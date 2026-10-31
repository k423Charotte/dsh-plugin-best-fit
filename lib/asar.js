/**
 * 从 Electron asar 归档里取文件内容。
 *
 * ⚠️ 实测结论（2026-10-31）：
 *  - 手写 header 解析在**普通 Node**里可用，但在**插件进程**（Electron）里会报
 *    `ENOENT, not found in <asar>` —— 因为 Electron 的 `fs` 被 asar 层接管，
 *    按偏移读归档原始字节这种玩法会被它拦下；
 *  - Electron 原生支持把 `<xxx>.asar/<内部路径>` 当虚拟路径 `require`，这才是正路。
 *
 * 所以这里给两条路：`requireAsarJson`（优先，Electron 环境）与 `inspectAsarFile`（兜底，普通 Node）。
 */

import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** 候选 asar 路径：Windows/Linux 与 macOS 各一条，再从 exe 上两级兜一次。 */
export function candidateAsarPaths() {
  const out = []
  try {
    const exeDir = dirname(process.execPath)
    out.push(join(exeDir, 'resources', 'app.asar')) // Windows / Linux
    out.push(join(exeDir, '..', 'Resources', 'app.asar')) // macOS
    out.push(join(exeDir, '..', 'resources', 'app.asar')) // 兜底
  } catch {
    /* execPath 不可用时返回空列表 */
  }
  return out
}

/** 找出第一个存在的 asar。 */
export function findAsar() {
  for (const candidate of candidateAsarPaths()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const describe = (error) => {
  const parts = []
  let current = error
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    const code = current.code
    const label = typeof code === 'string' && code && !current.message.includes(code) ? `${current.message} (${code})` : current.message
    if (label && !parts.includes(label)) parts.push(label)
    current = current.cause
  }
  return parts.length ? parts.join(' ← ') : String(error)
}

/**
 * 用 Electron 的 asar 虚拟路径读一个文件（JSON / JS 都行）。
 * @returns {{ok: boolean, value: any, error: string|null}}
 */
export function requireAsarFile(asarPath, relPath) {
  try {
    // 以 asar 内的一个基准路径建 require，再解析 asar 内文件
    const requireFromAsar = createRequire(join(asarPath, 'index.js'))
    const value = requireFromAsar(join(asarPath, relPath))
    return { ok: true, value, error: null }
  } catch (error) {
    return { ok: false, value: null, error: describe(error) }
  }
}

/**
 * 手读 asar（普通 Node 环境可用）；Electron 里可能报 `not found in <asar>`。
 * @returns {{ok: boolean, text: string|null, error: string|null}}
 */
export function inspectAsarFile(asarPath, relPath) {
  let fd
  try {
    fd = openSync(asarPath, 'r')

    const head = Buffer.alloc(16)
    const headRead = readSync(fd, head, 0, 16, 0)
    if (headRead !== 16) return { ok: false, text: null, error: `header 只读到 ${headRead} 字节` }

    const headerSize = head.readUInt32LE(12)
    if (!Number.isFinite(headerSize) || headerSize <= 0 || headerSize > 64 * 1024 * 1024) {
      return { ok: false, text: null, error: `headerSize 异常：${headerSize}` }
    }

    const headerBuf = Buffer.alloc(headerSize)
    const headerRead = readSync(fd, headerBuf, 0, headerSize, 16)
    if (headerRead !== headerSize) return { ok: false, text: null, error: `header 读取不完整：${headerRead}/${headerSize}` }

    let header
    try {
      header = JSON.parse(headerBuf.toString('utf8'))
    } catch (error) {
      return { ok: false, text: null, error: `header JSON 解析失败：${describe(error)}` }
    }

    let node = header
    for (const segment of String(relPath).split('/').filter(Boolean)) {
      node = node?.files?.[segment]
      if (!node) return { ok: false, text: null, error: `路径不存在：${relPath}（断在 ${segment}）` }
    }
    if (node.files) return { ok: false, text: null, error: `${relPath} 是目录不是文件` }
    if (typeof node.size !== 'number') return { ok: false, text: null, error: `size 字段异常：${JSON.stringify(node.size)}` }
    if (node.size <= 0) return { ok: false, text: null, error: 'size 为 0' }

    const dataStart = 16 + headerSize
    const content = Buffer.alloc(node.size)
    const contentRead = readSync(fd, content, 0, node.size, dataStart + Number(node.offset))
    if (contentRead !== node.size) return { ok: false, text: null, error: `内容读取不完整：${contentRead}/${node.size}` }

    return { ok: true, text: content.toString('utf8'), error: null }
  } catch (error) {
    return { ok: false, text: null, error: describe(error) }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* 关闭失败无所谓 */
      }
    }
  }
}

/** 兼容旧签名：读不到就返回 null。 */
export function readAsarFile(asarPath, relPath) {
  const result = inspectAsarFile(asarPath, relPath)
  return result.ok ? result.text : null
}
