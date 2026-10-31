/**
 * 取一个插件的 `package.json`（manifest）——**多路线并行竞速**。
 *
 * 设计原则（用户 2026-10-31 定）：不能拿我们这边的网络状况替所有用户做决定，
 * 所以每条路线都要实现；谁先回用谁；失败的静默忽略，只记进 `attempts` 供诊断。
 *
 * `needsProxy` 路线（raw / jsDelivr / statically / ghproxy.net）**默认不启用**：
 * 我方当前无代理，它们必然超时，白等 8 秒。设 `BEST_FIT_NEEDS_PROXY=1`（或传 `includeNeedsProxy`）可启用，
 * 用于将来在有代理的环境验证 —— 验证清单见仓库外的《待加速器验证-路线清单.md》。
 */

import { Buffer } from 'node:buffer'

const DEFAULT_TIMEOUT_MS = 8000
const RAW_GITHUB = 'https://raw.githubusercontent.com'

/** 是否启用「需要代理」的路线（默认关，避免在无代理环境里白等）。 */
export function wantsNeedsProxyRoutes(override) {
  if (typeof override === 'boolean') return override
  const raw = String(process.env.BEST_FIT_NEEDS_PROXY ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

/** 目标形态：`owner/repo` → github；否则 npm 包名（可带 @版本）。 */
export function parseTarget(target) {
  const raw = String(target ?? '').trim()
  if (raw === '') return null
  const gh = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  if (gh) return { kind: 'github', owner: gh[1], repo: gh[2], raw }
  const at = raw.lastIndexOf('@')
  if (at > 0) return { kind: 'npm', name: raw.slice(0, at), version: raw.slice(at + 1), raw }
  return { kind: 'npm', name: raw, version: null, raw }
}

/** 把任意错误整理成「message (code) ← cause」的可读串。 */
export function describeFailure(error) {
  const parts = []
  let current = error
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = current.code
    const label =
      typeof code === 'string' && code && !current.message.includes(code)
        ? `${current.message} (${code})`
        : current.message
    if (label && !parts.includes(label)) parts.push(label)
    current = current.cause
  }
  return parts.length ? parts.join(' ← ') : String(error)
}

export async function fetchWithTimeout(
  url,
  { timeoutMs = DEFAULT_TIMEOUT_MS, attempts = 1, headers = {}, method = 'GET', body } = {},
) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = Date.now()
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-best-fit', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const ms = Date.now() - startedAt
      if (!res.ok) return { ok: false, status: res.status, url, ms, error: `HTTP ${res.status}` }
      return { ok: true, status: res.status, url, ms, text: await res.text() }
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 350))
    }
  }
  return { ok: false, status: 0, url, ms: 0, error: describeFailure(lastError) }
}

/** 只挑判定需要的字段（多留 repository 供降级时校验身份）。 */
export function slimManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return null
  const repository =
    typeof manifest.repository === 'string'
      ? manifest.repository
      : manifest.repository && typeof manifest.repository.url === 'string'
        ? manifest.repository.url
        : null
  const scripts = manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : null
  return {
    name: typeof manifest.name === 'string' ? manifest.name : null,
    version: typeof manifest.version === 'string' ? manifest.version : null,
    engines: manifest.engines && typeof manifest.engines === 'object' ? manifest.engines : null,
    peerDependencies:
      manifest.peerDependencies && typeof manifest.peerDependencies === 'object' ? manifest.peerDependencies : null,
    repository,
    // 给评分用：安装期脚本是风险信号；peer 数量异常多通常意味着整包复制
    scripts,
    hasInstallScript: Boolean(scripts && (scripts.preinstall || scripts.install || scripts.postinstall)),
    peerCount: manifest.peerDependencies ? Object.keys(manifest.peerDependencies).length : 0,
  }
}

/** manifest 的 repository 是否指向 owner/repo（防止同名包冒认）。 */
export function repositoryMatches(manifest, owner, repo) {
  const url = String(manifest?.repository ?? '').toLowerCase()
  if (url === '') return false
  return url.includes(`/${String(owner).toLowerCase()}/${String(repo).toLowerCase()}`)
}

/**
 * 构造「取 manifest」的候选路线。
 * @param {{kind: 'github'|'npm', owner?: string, repo?: string, name?: string, version?: string|null}} parsed
 */
export function manifestRoutes(parsed, { githubToken, includeNeedsProxy = false } = {}) {
  const routes = []
  const ghHeaders = githubToken ? { authorization: `Bearer ${githubToken}` } : {}

  if (parsed.kind === 'npm') {
    const spec = parsed.version ? parsed.version : 'latest'
    const npmPath = `/${parsed.name}/${spec}`
    routes.push({
      id: 'npmmirror',
      needsProxy: false,
      timeoutMs: 8000,
      url: `https://registry.npmmirror.com${npmPath}`,
      parse: 'json',
    })
    routes.push({
      id: 'npmjs',
      needsProxy: false,
      timeoutMs: 12000,
      url: `https://registry.npmjs.org${npmPath}`,
      parse: 'json',
    })
    routes.push({
      id: 'esm.sh',
      needsProxy: false,
      timeoutMs: 8000,
      url: `https://esm.sh/${parsed.name}@${spec}/package.json`,
      parse: 'json',
    })
    routes.push({
      id: 'unpkg',
      needsProxy: false,
      timeoutMs: 12000,
      url: `https://unpkg.com/${parsed.name}@${spec}/package.json`,
      parse: 'json',
    })
    if (includeNeedsProxy) {
      routes.push({
        id: 'jsdelivr-npm',
        needsProxy: true,
        timeoutMs: 8000,
        url: `https://cdn.jsdelivr.net/npm/${parsed.name}@${spec}/package.json`,
        parse: 'json',
      })
    }
    return routes
  }

  const { owner, repo } = parsed
  const rawUrl = `${RAW_GITHUB}/${owner}/${repo}/HEAD/package.json`

  routes.push({
    id: 'github-contents',
    needsProxy: false,
    timeoutMs: 8000,
    attempts: 2,
    url: `https://api.github.com/repos/${owner}/${repo}/contents/package.json`,
    headers: ghHeaders,
    parse: 'github-contents',
  })
  routes.push({ id: 'gh-proxy', needsProxy: false, timeoutMs: 8000, url: `https://gh-proxy.com/${rawUrl}`, parse: 'json' })
  routes.push({
    id: 'npm-by-repo-name',
    needsProxy: false,
    timeoutMs: 8000,
    url: `https://registry.npmmirror.com/${repo}/latest`,
    parse: 'json',
    requireRepository: { owner, repo },
  })
  routes.push({
    id: 'esm.sh-by-repo-name',
    needsProxy: false,
    timeoutMs: 8000,
    url: `https://esm.sh/${repo}@latest/package.json`,
    parse: 'json',
    requireRepository: { owner, repo },
  })
  if (includeNeedsProxy) {
    routes.push({ id: 'raw-github', needsProxy: true, timeoutMs: 8000, url: rawUrl, parse: 'json' })
    routes.push({
      id: 'jsdelivr-gh',
      needsProxy: true,
      timeoutMs: 8000,
      url: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@main/package.json`,
      parse: 'json',
    })
    routes.push({
      id: 'statically',
      needsProxy: true,
      timeoutMs: 8000,
      url: `https://cdn.statically.io/gh/${owner}/${repo}/HEAD/package.json`,
      parse: 'json',
    })
    routes.push({ id: 'ghproxy.net', needsProxy: true, timeoutMs: 8000, url: `https://ghproxy.net/${rawUrl}`, parse: 'json' })
  }
  return routes
}

function parseRoute(route, text) {
  if (route.parse === 'github-contents') {
    const body = JSON.parse(text)
    if (typeof body?.content !== 'string' || body?.encoding !== 'base64') {
      return { ok: false, error: 'contents API 返回里没有 base64 content' }
    }
    return { ok: true, manifest: slimManifest(JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'))) }
  }
  return { ok: true, manifest: slimManifest(JSON.parse(text)) }
}

/**
 * 取 manifest：**串行按优先级尝试**，第一个成功即返回。
 *
 * ⚠️ 不是并发竞速 —— 实测（2026-10-31）宿主进程里**并发多个 HTTPS 请求会集体超时**，
 * 而同一个 URL 单独请求只要 300–900ms。所以这里逐个试、成功就停。
 * @returns {Promise<{ok: true, route: string, url: string, manifest: object, needsProxy: boolean, attempts: object[]}
 *   | {ok: false, error: string, attempts: object[]}>}
 */
export async function fetchManifest(target, { githubToken, includeNeedsProxy, budgetMs = 15000 } = {}) {
  const parsed = parseTarget(target)
  if (!parsed) return { ok: false, error: 'target 为空', attempts: [] }

  const withProxy = wantsNeedsProxyRoutes(includeNeedsProxy)
  const routes = manifestRoutes(parsed, { githubToken, includeNeedsProxy: withProxy })
  const attempts = []
  const startedAt = Date.now()
  const deadline = startedAt + budgetMs

  for (const route of routes) {
    // 单条体检的总预算：某几路线一起卡住时别再往下试，标记为超时放弃
    if (Date.now() > deadline) {
      attempts.push({ route: '(剩余路线)', needsProxy: false, ok: false, ms: 0, error: `超过单条体检总预算 ${budgetMs}ms，已放弃` })
      break
    }
    const res = await fetchWithTimeout(route.url, {
      timeoutMs: route.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      attempts: route.attempts ?? 1,
      headers: route.headers ?? {},
    })
    if (!res.ok) {
      attempts.push({ route: route.id, needsProxy: route.needsProxy, ok: false, ms: res.ms, error: res.error })
      continue
    }
    let parsedBody
    try {
      parsedBody = parseRoute(route, res.text)
    } catch (error) {
      attempts.push({
        route: route.id,
        needsProxy: route.needsProxy,
        ok: false,
        ms: res.ms,
        error: `解析失败：${describeFailure(error)}`,
      })
      continue
    }
    if (!parsedBody.ok) {
      attempts.push({ route: route.id, needsProxy: route.needsProxy, ok: false, ms: res.ms, error: parsedBody.error })
      continue
    }
    if (
      route.requireRepository &&
      !repositoryMatches(parsedBody.manifest, route.requireRepository.owner, route.requireRepository.repo)
    ) {
      attempts.push({
        route: route.id,
        needsProxy: route.needsProxy,
        ok: false,
        ms: res.ms,
        error: 'repo 名对应到别的包（repository 字段不匹配），已拒绝',
      })
      continue
    }
    attempts.push({ route: route.id, needsProxy: route.needsProxy, ok: true, ms: res.ms })
    return {
      ok: true,
      route: route.id,
      url: route.url,
      manifest: parsedBody.manifest,
      needsProxy: route.needsProxy,
      attempts,
      ms: Date.now() - startedAt,
    }
  }

  return {
    ok: false,
    error: attempts.length ? attempts.map((a) => `${a.route} → ${a.error}`).join('；') : '没有可用路线',
    attempts,
    ms: Date.now() - startedAt,
  }
}
