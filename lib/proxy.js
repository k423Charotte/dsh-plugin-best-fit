/**
 * SOCKS5 代理客户端（零依赖，只用 `node:net` + `node:tls`）。
 *
 * 为什么必须自己实现：
 *  - Node 的 `NODE_USE_ENV_PROXY=1` **只支持 HTTP 代理**，不认 SOCKS5；
 *  - 很多加速器只开 SOCKS5；
 *  - 而且必须走 **socks5h 语义**（域名交给代理做远程 DNS）——
 *    本地解析会因 DNS 被污染/阻断而失败，实测 `socks5://` 挂、`socks5h://` 通。
 *
 * ⚠️ 实现要点（2026-10-31 实测踩过）：
 *  1. **不能"写一段再挂监听"**——socket 是流，数据可能在监听注册前就丢失；
 *     所以连接一建立就挂**持久 reader**（自己缓冲 + 按需切分）。
 *  2. SOCKS5 隧道建好后**必须摘掉 reader 的 data 监听**，否则 TLS 握手数据会被它吃掉。
 */

import { execFileSync } from 'node:child_process'
import net from 'node:net'
import tls from 'node:tls'

/** 解析代理 URL；支持 `socks5h://host:port`、`socks5://`、host:port（默认 socks5h/1080）。 */
export function parseProxyUrl(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return null
  try {
    const normalized = /^[a-z0-9+.-]+:\/\//i.test(text) ? text : `socks5h://${text}`
    const url = new URL(normalized)
    const scheme = url.protocol.replace(':', '').toLowerCase()
    if (!['socks5h', 'socks5', 'socks'].includes(scheme)) return null
    const port = Number(url.port || 1080)
    if (url.hostname === '' || !Number.isFinite(port) || port <= 0) return null
    return { host: url.hostname, port, remoteDns: scheme !== 'socks5' }
  } catch {
    return null
  }
}

/* ── 代理来源解析（配置 > 环境变量 > Windows 系统代理），带缓存 ───────────── */

let proxyCache = { value: null, at: 0 }
const PROXY_CACHE_MS = 30 * 1000

/** 读 Windows 系统代理（注册表）；返回 `host:port` 或 null。 */
function readWindowsSystemProxy() {
  if (process.platform !== 'win32') return null
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  try {
    const enable = execFileSync('reg', ['query', key, '/v', 'ProxyEnable'], { encoding: 'utf8', timeout: 3000 })
    if (!/0x1\b/i.test(enable)) return null
    const server = execFileSync('reg', ['query', key, '/v', 'ProxyServer'], { encoding: 'utf8', timeout: 3000 })
    const match = server.match(/ProxyServer\s+REG_SZ\s+(\S+)/i)
    if (!match) return null
    const value = match[1].trim()
    // 形如 "127.0.0.1:20768" 或 "http=h:p;https=h:p" —— 取第一个带端口的
    const single = value.includes('=')
      ? value
          .split(';')
          .map((part) => part.split('=')[1])
          .find((part) => part && part.includes(':')) || ''
      : value
    if (single === '' || !single.includes(':')) return null
    return single
  } catch {
    return null
  }
}

/**
 * 解析当前应使用的代理，30 秒缓存。
 * @param {() => object} readConfigFn 传 readConfig 进来（避免 proxy.js 反向依赖 config.js）
 * @returns {Promise<{url: string, source: string, proxy: object|null}>}
 */
export async function resolveProxy(readConfigFn) {
  const now = Date.now()
  if (proxyCache.value !== null && now - proxyCache.at < PROXY_CACHE_MS) return proxyCache.value

  const candidates = []
  try {
    const config = typeof readConfigFn === 'function' ? readConfigFn() : {}
    if (config && typeof config.proxyUrl === 'string' && config.proxyUrl.trim() !== '') {
      candidates.push({ url: config.proxyUrl.trim(), source: 'config' })
    }
  } catch {
    /* 配置读不到就当没有 */
  }
  for (const key of ['BEST_FIT_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'https_proxy', 'all_proxy']) {
    const value = String(process.env[key] ?? '').trim()
    if (value !== '') {
      candidates.push({ url: value, source: `env:${key}` })
      break
    }
  }
  if (candidates.length === 0) {
    const system = readWindowsSystemProxy()
    if (system !== null) candidates.push({ url: `socks5h://${system}`, source: 'windows-registry' })
  }

  for (const candidate of candidates) {
    const proxy = parseProxyUrl(candidate.url)
    if (proxy) {
      proxyCache = { value: { ...candidate, proxy }, at: now }
      return proxyCache.value
    }
  }
  proxyCache = { value: { url: '', source: '', proxy: null }, at: now }
  return proxyCache.value
}

/** 清掉代理缓存（配置保存后调用）。 */
export function clearProxyCache() {
  proxyCache = { value: null, at: 0 }
}

/* ── SOCKS5 实现 ──────────────────────────────────────────────────────── */

/** 持久 reader：连接建立后立刻挂上，保证不丢帧。 */
function createReader(socket) {
  let buffer = Buffer.alloc(0)
  let ended = false
  let endError = null
  const waiters = []

  const settle = (waiter, payload) => {
    clearTimeout(waiter.timer)
    waiter.resolve(payload)
  }

  const drain = () => {
    while (waiters.length > 0) {
      const waiter = waiters[0]
      if (waiter.kind === 'exact') {
        if (buffer.length < waiter.length) return
        const out = buffer.subarray(0, waiter.length)
        buffer = buffer.subarray(waiter.length)
        waiters.shift()
        settle(waiter, Buffer.from(out))
        continue
      }
      // kind === 'rest'：等连接关闭后把剩下的全给
      if (!ended) return
      const out = buffer
      buffer = Buffer.alloc(0)
      waiters.shift()
      settle(waiter, { data: out, error: endError })
      return
    }
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    drain()
  })
  socket.on('end', () => {
    ended = true
    drain()
  })
  socket.on('close', () => {
    ended = true
    drain()
  })
  socket.on('error', (error) => {
    endError = error
    ended = true
    drain()
  })

  return {
    readExact(length, timeoutMs) {
      return new Promise((resolve, reject) => {
        const waiter = { kind: 'exact', length, resolve, reject, timer: null }
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error('SOCKS5 读取超时'))
        }, timeoutMs)
        waiters.push(waiter)
        drain()
      })
    },
    readRest(timeoutMs) {
      return new Promise((resolve, reject) => {
        const waiter = { kind: 'rest', resolve, reject, timer: null }
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error('读取响应超时'))
        }, timeoutMs)
        waiters.push(waiter)
        drain()
      })
    },
    /**
     * 摘掉 data 监听，把原始 socket 交还给上层（TLS）。
     * ⚠️ SOCKS5 隧道建好后**必须**调用，否则 reader 会把 TLS 握手数据吃掉。
     */
    detach() {
      try {
        socket.removeAllListeners('data')
      } catch {
        /* 忽略 */
      }
    },
  }
}

function connectSocket(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    socket.setNoDelay(true)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('连接代理超时'))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/** SOCKS5 握手 + CONNECT（域名模式 = 远程 DNS）。 */
async function socks5Tunnel(socket, reader, targetHost, targetPort, timeoutMs) {
  socket.write(Buffer.from([0x05, 0x01, 0x00]))
  const greeting = await reader.readExact(2, timeoutMs)
  if (greeting[0] !== 0x05) throw new Error(`SOCKS5 版本不匹配（收到 ${greeting[0]}）`)
  if (greeting[1] !== 0x00) throw new Error(`SOCKS5 握手被拒（method=${greeting[1]}，可能需要认证）`)

  const hostBuffer = Buffer.from(targetHost, 'utf8')
  if (hostBuffer.length === 0 || hostBuffer.length > 255) throw new Error('目标域名长度非法')
  const portBuffer = Buffer.alloc(2)
  portBuffer.writeUInt16BE(targetPort, 0)
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuffer.length]), hostBuffer, portBuffer]))

  const head = await reader.readExact(4, timeoutMs)
  if (head[0] !== 0x05) throw new Error('SOCKS5 响应版本不匹配')
  if (head[1] !== 0x00) throw new Error(`SOCKS5 CONNECT 失败（code=${head[1]}）`)

  const atyp = head[3]
  let addressLength = 0
  if (atyp === 0x01) addressLength = 4
  else if (atyp === 0x04) addressLength = 16
  else if (atyp === 0x03) {
    const one = await reader.readExact(1, timeoutMs)
    addressLength = one[0]
  } else {
    throw new Error('SOCKS5 响应地址类型未知')
  }
  await reader.readExact(addressLength + 2, timeoutMs)
}

/** 解析 HTTP/1.1 响应（支持 Content-Length 与 chunked）。 */
export function parseHttpResponse(buffer) {
  const text = buffer.toString('utf8')
  const splitAt = text.indexOf('\r\n\r\n')
  if (splitAt < 0) throw new Error('HTTP 响应不完整（没有头部结束标记）')
  const headerText = text.slice(0, splitAt)
  const bodyText = text.slice(splitAt + 4)
  const lines = headerText.split('\r\n')
  const statusLine = lines.shift() ?? ''
  const statusMatch = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/)
  if (!statusMatch) throw new Error(`HTTP 状态行非法：${statusLine.slice(0, 40)}`)
  const status = Number(statusMatch[1])
  const headers = {}
  for (const line of lines) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim()
  }

  let body = bodyText
  if (String(headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
    body = decodeChunked(bodyText)
  } else if (typeof headers['content-length'] === 'string') {
    const expected = Number(headers['content-length'])
    if (Number.isFinite(expected) && expected >= 0) body = bodyText.slice(0, expected)
  }
  return { status, headers, text: body }
}

function decodeChunked(text) {
  const out = []
  let rest = text
  while (rest.length > 0) {
    const lineEnd = rest.indexOf('\r\n')
    if (lineEnd < 0) break
    const size = Number.parseInt(rest.slice(0, lineEnd).trim(), 16)
    if (!Number.isFinite(size) || size <= 0) break
    const start = lineEnd + 2
    out.push(rest.slice(start, start + size))
    rest = rest.slice(start + size + 2)
  }
  return out.join('')
}

/**
 * 通过 SOCKS5 代理发 HTTPS GET（零依赖手写 HTTP/1.1）。
 * @returns {Promise<{ok: boolean, status?: number, text?: string, error?: string, ms: number}>}
 */
export async function fetchViaSocks5(url, { proxy, timeoutMs = 12000, headers = {} } = {}) {
  const startedAt = Date.now()
  if (!proxy) return { ok: false, error: '未配置代理', ms: 0 }
  let socket = null
  try {
    const parsed = new URL(url)
    const isHttps = parsed.protocol === 'https:'
    if (!isHttps && parsed.protocol !== 'http:') throw new Error(`不支持的协议：${parsed.protocol}`)
    const port = Number(parsed.port || (isHttps ? 443 : 80))

    socket = await connectSocket(proxy.host, proxy.port, timeoutMs)
    const reader = createReader(socket)
    await socks5Tunnel(socket, reader, parsed.hostname, port, timeoutMs)
    // 隧道建好，把 socket 交还给 TLS（不摘监听的话 TLS 握手数据会被 reader 吃掉）
    reader.detach()

    const stream = isHttps
      ? await new Promise((resolve, reject) => {
          const secure = tls.connect({ socket, servername: parsed.hostname }, () => resolve(secure))
          secure.once('error', reject)
        })
      : socket
    const tlsReader = isHttps ? createReader(stream) : reader

    const path = `${parsed.pathname}${parsed.search}`
    const host = parsed.hostname + (parsed.port ? `:${parsed.port}` : '')
    const requestLines = [
      `GET ${path || '/'} HTTP/1.1`,
      `Host: ${host}`,
      'Connection: close',
      'Accept-Encoding: identity',
      'User-Agent: dsh-plugin-best-fit/0.1',
    ]
    for (const [key, value] of Object.entries(headers ?? {})) {
      if (value === undefined || value === null) continue
      requestLines.push(`${key}: ${value}`)
    }
    stream.write(`${requestLines.join('\r\n')}\r\n\r\n`)

    const rest = await tlsReader.readRest(timeoutMs)
    if (rest.error) throw rest.error
    const response = parseHttpResponse(rest.data)
    return {
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      text: response.text,
      ms: Date.now() - startedAt,
    }
  } catch (error) {
    return { ok: false, error: String(error?.message || error), ms: Date.now() - startedAt }
  } finally {
    try {
      if (socket) socket.destroy()
    } catch {
      /* 忽略 */
    }
  }
}
