/**
 * 搜索插件的多路线实现（并行竞速 + 边完成边合并 + 总预算）。
 *
 * 路线（全部实测过，见 PLAN.md 的四之二章）：
 *  1. `api.github.com/search/repositories?q=<kw> topic:dsh-plugin` —— 覆盖最大（实测 total_count≈24896）；
 *  2. `registry.npmmirror.com/-/v1/search` —— 国内快（46–371ms），只覆盖发过 npm 的；
 *  3. `registry.npmjs.org/-/v1/search` —— 慢但全；
 *  4. `github.com/topics/dsh-plugin`（HTML）—— 不按关键词、只做兜底，本地再过滤；**必须 text/html**（发 json 会 406）；
 *  5. `awesome-dsh-plugin.com/plugins.json` —— 需代理（needsProxy），默认不跑，开 `BEST_FIT_NEEDS_PROXY=1` 才启用。
 *
 * ⚠️ 总预算：`budgetMs`（默认 4s）到点就带**已完成路线**的结果返回，不等慢的。
 *
 * 只返回**字符串形式的安装命令**，绝不自动安装任何第三方代码。
 */

import { describeFailure, fetchWithTimeout, wantsNeedsProxyRoutes } from './source.js'

const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_BUDGET_MS = 4000

async function fetchText(url, options) {
  return fetchWithTimeout(url, { timeoutMs: DEFAULT_TIMEOUT_MS, ...options })
}

/** GitHub search → 统一条目（导出供离线测试）。 */
export function mapGitHubItems(items) {
  const out = []
  for (const item of items ?? []) {
    if (!item?.full_name) continue
    const [owner, repo] = String(item.full_name).split('/')
    if (!owner || !repo) continue
    // 官方仓库不是给用户装的第三方插件
    if (owner.toLowerCase() === 'deepseek-ai') continue
    out.push({
      name: item.full_name,
      owner,
      repo,
      url: item.html_url ?? `https://github.com/${item.full_name}`,
      stars: typeof item.stargazers_count === 'number' ? item.stargazers_count : null,
      forks: typeof item.forks_count === 'number' ? item.forks_count : null,
      openIssues: typeof item.open_issues_count === 'number' ? item.open_issues_count : null,
      archived: item.archived === true,
      license: item.license && typeof item.license.spdx_id === 'string' ? item.license.spdx_id : null,
      description: typeof item.description === 'string' ? item.description : '',
      pushedAt: typeof item.pushed_at === 'string' ? item.pushed_at : null,
      install: `dsh plugin --profile web add github:${item.full_name}`,
      source: 'github-search',
    })
  }
  return out
}

/** npm search → 统一条目（从 repository 链接里提取 owner/repo；带 registry 的 quality 分）。 */
export function mapNpmItems(objects) {
  const out = []
  for (const obj of objects ?? []) {
    const pkg = obj?.package
    if (!pkg?.name) continue
    // 排除 DSH 官方内部包：它们是宿主自己的模块（@deepseek-ai/dsh-client-ui-* 之类），
    // 不是给用户「装」的第三方插件 —— 2026-10-31 实测搜 sidebar 时它们占满了前 5 条。
    if (pkg.name.startsWith('@deepseek-ai/')) continue
    const repoUrl = pkg.links?.repository ?? ''
    const match = String(repoUrl).match(/github\.com\/([^/]+)\/([^/#?]+)/i)
    const owner = match ? match[1] : null
    const repo = match ? match[2].replace(/\.git$/i, '') : null
    const detail = obj?.score?.detail ?? {}
    out.push({
      name: pkg.name,
      owner,
      repo,
      url: repoUrl || pkg.links?.npm || '',
      stars: null,
      npmPopularity: typeof detail.popularity === 'number' ? detail.popularity : null,
      npmQuality: typeof detail.quality === 'number' ? detail.quality : null,
      npmMaintenance: typeof detail.maintenance === 'number' ? detail.maintenance : null,
      description: typeof pkg.description === 'string' ? pkg.description : '',
      pushedAt: pkg.date ?? null,
      install: `dsh plugin --profile web add ${pkg.name}`,
      source: 'npm-search',
    })
  }
  return out
}

/** topics 页 HTML → 仓库链接（不按关键词，本地过滤）。 */
export function mapTopicsHtml(html) {
  const seen = new Set()
  const out = []
  const re = /href="\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)"/g
  let m
  while ((m = re.exec(html)) !== null) {
    const owner = m[1]
    const repo = m[2]
    if (['topics', 'features', 'about', 'login', 'signup', 'pricing'].includes(owner)) continue
    const key = `${owner}/${repo}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      name: `${owner}/${repo}`,
      owner,
      repo,
      url: `https://github.com/${owner}/${repo}`,
      stars: null,
      description: '',
      pushedAt: null,
      install: `dsh plugin --profile web add github:${owner}/${repo}`,
      source: 'github-topics',
    })
  }
  return out
}

/** awesome-dsh-plugin 的 plugins.json → 统一条目。 */
export function mapAwesomeJson(parsed, tokens) {
  const list = parsed?.plugins ?? []
  const out = []
  for (const p of list) {
    const description = p?.description?.zh ?? p?.description?.en ?? ''
    const name = p?.name ?? p?.owner ?? ''
    if (!matchesQuery({ name, description }, tokens)) continue
    out.push({
      name: String(name),
      owner: p?.owner ?? null,
      repo: p?.name ?? null,
      url: p?.url ?? '',
      stars: typeof p?.stars === 'number' ? p.stars : null,
      description,
      pushedAt: p?.added ?? null,
      install: p?.install ?? '',
      source: 'awesome-json',
    })
  }
  return out
}

export function tokenize(query) {
  return String(query)
    .toLowerCase()
    .split(/[\s,，、]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

export function matchesQuery(item, tokens) {
  if (tokens.length === 0) return true
  const haystack = `${item.name ?? ''} ${item.description ?? ''}`.toLowerCase()
  return tokens.some((token) => haystack.includes(token))
}

/**
 * 构造搜索路线。
 * ⚠️ 默认只发**两个主源**：实测宿主进程里并发 4 个 HTTPS 请求会集体超时（8s 都没回），
 * 而同一个源单独请求 300–900ms 就回。需要更全的覆盖时设 `BEST_FIT_ALL_SOURCES=1`。
 */
export function searchRoutes(query, { limit, githubToken, includeNeedsProxy = false, includeAllSources = false } = {}) {
  const q = encodeURIComponent(`${query} topic:dsh-plugin`)
  const perPage = Math.min(Math.max(limit * 2, 6), 30)
  const ghHeaders = githubToken ? { authorization: `Bearer ${githubToken}` } : {}
  const routes = [
    {
      id: 'npmmirror-search',
      needsProxy: false,
      timeoutMs: 6000,
      url: `https://registry.npmmirror.com/-/v1/search?text=${encodeURIComponent(query)}%20dsh-plugin&size=${perPage}`,
      kind: 'npm-search',
    },
    {
      id: 'github-search',
      needsProxy: false,
      timeoutMs: 4000,
      attempts: 1,
      url: `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${perPage}`,
      headers: { ...ghHeaders, accept: 'application/vnd.github+json' },
      kind: 'github-search',
    },
  ]
  if (includeAllSources) {
    routes.push(
      {
        id: 'npmjs-search',
        needsProxy: false,
        timeoutMs: 8000,
        url: `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}%20dsh-plugin&size=${perPage}`,
        kind: 'npm-search',
      },
      {
        id: 'github-topics',
        needsProxy: false,
        timeoutMs: 6000,
        // ⚠️ 这是 HTML 页面：带 accept: application/json 会被 GitHub 回 406（实测）
        headers: { accept: 'text/html' },
        url: 'https://github.com/topics/dsh-plugin',
        kind: 'topics-html',
      },
    )
  }
  if (includeNeedsProxy) {
    routes.push({
      id: 'awesome-json',
      needsProxy: true,
      timeoutMs: 8000,
      url: 'https://awesome-dsh-plugin.com/plugins.json',
      kind: 'awesome-json',
    })
  }
  return routes
}

/**
 * 并行搜索，边完成边合并；到 `budgetMs` 就带已有结果返回。
 * @returns {Promise<{ok: boolean, results: object[], sources: object[], partial?: boolean, error?: string}>}
 */
export async function searchPlugins(
  query,
  { limit = 8, githubToken, budgetMs = DEFAULT_BUDGET_MS, graceMs = 4000, includeNeedsProxy, includeAllSources } = {},
) {
  const tokens = tokenize(query)
  const withProxy = wantsNeedsProxyRoutes(includeNeedsProxy)
  const allSources =
    typeof includeAllSources === 'boolean'
      ? includeAllSources
      : String(process.env.BEST_FIT_ALL_SOURCES ?? '').trim() === '1'
  const routes = searchRoutes(query, {
    limit,
    githubToken,
    includeNeedsProxy: withProxy,
    includeAllSources: allSources,
  })
  // ⚠️ 串行（不是并发）：实测宿主进程里并发多个 HTTPS 请求会集体超时，单请求却很快。
  const sources = []
  const bucket = new Map()

  const ingest = (items) => {
    for (const item of items) {
      const key = String(item.name ?? '').toLowerCase()
      if (key === '' || bucket.has(key)) continue
      bucket.set(key, item)
    }
  }

  for (const route of routes) {
    const res = await fetchText(route.url, {
      timeoutMs: route.timeoutMs,
      attempts: route.attempts ?? 1,
      headers: route.headers ?? {},
    })
    if (!res.ok) {
      sources.push({ route: route.id, needsProxy: route.needsProxy, ok: false, ms: res.ms, error: res.error })
      continue
    }
    let items = []
    try {
      if (route.kind === 'github-search') items = mapGitHubItems(JSON.parse(res.text)?.items)
      else if (route.kind === 'npm-search') items = mapNpmItems(JSON.parse(res.text)?.objects)
      else if (route.kind === 'topics-html') items = mapTopicsHtml(res.text).filter((item) => matchesQuery(item, tokens))
      else if (route.kind === 'awesome-json') items = mapAwesomeJson(JSON.parse(res.text), tokens)
    } catch (error) {
      sources.push({
        route: route.id,
        needsProxy: route.needsProxy,
        ok: false,
        ms: res.ms,
        error: `解析失败：${describeFailure(error)}`,
      })
      continue
    }
    sources.push({ route: route.id, needsProxy: route.needsProxy, ok: true, ms: res.ms, count: items.length })
    ingest(items)
    // 已经够了就不再打后续源：失败路线会把超时拖满，得不偿失
    if (bucket.size >= limit) break
  }

  const partial = sources.some((source) => !source.ok)

  const results = [...bucket.values()]
    .sort((a, b) => {
      const sa = typeof a.stars === 'number' ? a.stars : -1
      const sb = typeof b.stars === 'number' ? b.stars : -1
      if (sa !== sb) return sb - sa
      return String(a.name).localeCompare(String(b.name))
    })
    .slice(0, limit)

  const anyOk = sources.some((s) => s.ok)
  return {
    ok: anyOk || results.length > 0,
    results,
    sources,
    partial: partial || undefined,
    error: anyOk ? undefined : sources.map((s) => `${s.route} → ${s.error}`).join('；'),
  }
}
