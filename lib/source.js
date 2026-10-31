/**
 * 取一个插件的 `package.json`（manifest）。
 *
 * 实测约束（2026-10-31，本机宿主网络，三轮采样）：
 *  - `raw.githubusercontent.com` **稳定不通**（ECONNRESET ×3）→ 不用；
 *  - `cdn.jsdelivr.net` **也不通**（ECONNRESET / 超时）→ 不用；
 *  - `api.github.com` 间歇（首轮可能 8s 超时，之后 120–330ms）→ 超时 8s + **重试 2 次**；
 *  - `registry.npmmirror.com` 快（46–371ms）但**不一定有这个包**（实测 dsh-find-plugin 没有）；
 *  - `registry.npmjs.org` 有全部包但**慢**（实测 2.5–5.3s）。
 *
 * 策略：
 *  1. npm 源：两个 registry **并行竞速**，谁先回用谁；
 *  2. GitHub 源：contents API（base64），失败后用 **repo 名去 npm 试**，并校验 manifest 的
 *     `repository` 字段确实指向该 owner/repo（防止同名包冒认）。
 */

const NPM_REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org']
const GITHUB_API = 'https://api.github.com'
const GITHUB_TIMEOUT_MS = 8000
const GITHUB_ATTEMPTS = 2
const NPM_TIMEOUT_MS = 8000

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
    const label = typeof code === 'string' && code && !current.message.includes(code) ? `${current.message} (${code})` : current.message
    if (label && !parts.includes(label)) parts.push(label)
    current = current.cause
  }
  return parts.length ? parts.join(' ← ') : String(error)
}

async function fetchJson(url, { timeoutMs, attempts = 1, headers = {} } = {}) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = Date.now()
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-best-fit', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const ms = Date.now() - startedAt
      if (res.status === 404) return { ok: false, status: 404, url, ms, error: 'HTTP 404（不存在）' }
      if (!res.ok) return { ok: false, status: res.status, url, ms, error: `HTTP ${res.status}` }
      return { ok: true, status: res.status, url, ms, json: await res.json() }
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }
  return { ok: false, status: 0, url, ms: 0, error: describeFailure(lastError) }
}

/** 只挑判定需要的字段（多留 repository，用于降级时校验身份）。 */
function slim(manifest) {
  const repository =
    typeof manifest?.repository === 'string'
      ? manifest.repository
      : manifest?.repository && typeof manifest.repository.url === 'string'
        ? manifest.repository.url
        : null
  return {
    name: typeof manifest?.name === 'string' ? manifest.name : null,
    version: typeof manifest?.version === 'string' ? manifest.version : null,
    engines: manifest?.engines && typeof manifest.engines === 'object' ? manifest.engines : null,
    peerDependencies:
      manifest?.peerDependencies && typeof manifest.peerDependencies === 'object' ? manifest.peerDependencies : null,
    repository,
  }
}

/** manifest 的 repository 是否指向 owner/repo（防止同名包冒认）。 */
function repositoryMatches(manifest, owner, repo) {
  const url = String(manifest?.repository ?? '').toLowerCase()
  if (url === '') return false
  const needle = `/${owner.toLowerCase()}/${repo.toLowerCase()}`
  return url.includes(needle)
}

/** npm 源：两个 registry 并行竞速。 */
async function fetchFromNpm(name, spec) {
  const startedAt = Date.now()
  const attempts = []
  const tasks = NPM_REGISTRIES.map(async (registry) => {
    const url = `${registry}/${name}/${spec}`
    const result = await fetchJson(url, { timeoutMs: NPM_TIMEOUT_MS })
    attempts.push({ url, ok: result.ok, ms: result.ms, error: result.error ?? null })
    if (!result.ok) throw new Error(result.error)
    return { url, json: result.json }
  })
  try {
    const winner = await Promise.any(tasks)
    return { ok: true, url: winner.url, manifest: slim(winner.json), attempts, ms: Date.now() - startedAt }
  } catch {
    return {
      ok: false,
      url: '',
      error: attempts.map((a) => `${a.url} → ${a.error}`).join('；'),
      attempts,
      ms: Date.now() - startedAt,
    }
  }
}

/**
 * @returns {Promise<{ok: true, source: string, url: string, manifest: object, ms?: number, attempts?: any[]}
 *   | {ok: false, source: string, url: string, error: string, attempts?: any[]}>}
 */
export async function fetchManifest(target, { githubToken } = {}) {
  const parsed = parseTarget(target)
  if (!parsed) return { ok: false, source: 'target', url: '', error: 'target 为空' }

  if (parsed.kind === 'github') {
    const url = `${GITHUB_API}/repos/${parsed.owner}/${parsed.repo}/contents/package.json`
    const headers = githubToken ? { authorization: `Bearer ${githubToken}` } : {}
    const res = await fetchJson(url, { timeoutMs: GITHUB_TIMEOUT_MS, attempts: GITHUB_ATTEMPTS, headers })

    if (res.ok) {
      const content = res.json?.content
      if (typeof content === 'string' && res.json?.encoding === 'base64') {
        try {
          const decoded = Buffer.from(content, 'base64').toString('utf8')
          return { ok: true, source: 'github', url, manifest: slim(JSON.parse(decoded)), ms: res.ms }
        } catch (error) {
          // 解析失败也走下面的 npm 降级
        }
      }
    }

    // 降级：repo 名 → npm（必须校验 repository 指向同一 repo）
    const fallback = await fetchFromNpm(parsed.repo, 'latest')
    if (fallback.ok && repositoryMatches(fallback.manifest, parsed.owner, parsed.repo)) {
      return {
        ok: true,
        source: 'npm（由 repo 名降级，已校验 repository 字段）',
        url: fallback.url,
        manifest: fallback.manifest,
        ms: fallback.ms,
        attempts: fallback.attempts,
      }
    }
    return {
      ok: false,
      source: 'github',
      url,
      error: res.ok
        ? `contents API 有响应但取不到可用 package.json；npm 降级也未命中（${fallback.ok ? 'repo 名对应到别的包，已拒绝' : fallback.error}）`
        : `${res.error}；npm 降级（包名 ${parsed.repo}）也失败：${fallback.ok ? 'repo 名对应到别的包，已拒绝' : fallback.error}`,
    }
  }

  const spec = parsed.version ? parsed.version : 'latest'
  const npm = await fetchFromNpm(parsed.name, spec)
  if (npm.ok) {
    return { ok: true, source: 'npm', url: npm.url, manifest: npm.manifest, ms: npm.ms, attempts: npm.attempts }
  }
  return { ok: false, source: 'npm', url: '', error: npm.error, attempts: npm.attempts }
}
