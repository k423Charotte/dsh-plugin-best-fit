/**
 * 搜索插件的多路线实现（并行竞速 + 边完成边合并 + 总预算）。
 *
 * 路线（全部实测过，见 PLAN.md 的四之二章）：
 *  1. `api.github.com/search/repositories?q=<kw> topic:dsh-plugin` —— 覆盖最大（实测 total_count≈24896）；
 *  2. `registry.npmmirror.com/-/v1/search` —— 国内快（46–371ms），只覆盖发过 npm 的；
 *  3. `registry.npmjs.org/-/v1/search` —— 慢但全；
 *  4. `github.com/topics/dsh-plugin`（HTML）—— 不按关键词、只做兜底，本地再过滤；**必须 text/html**（发 json 会 406）；
 *  5. `awesome-dsh-plugin.com/plugins.json` —— 需代理（needsProxy），失败静默。
 *
 * ⚠️ 总预算：`budgetMs`（默认 6s）到点就带着**已完成路线**的结果返回，不等慢的全部跑完。
 *
 * 只返回**字符串形式的安装命令**，绝不自动安装任何第三方代码。
 */

import { describeFailure } from './source.js'

const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_BUDGET_MS = 6000

async function fetchText(url, { timeoutMs = DEFAULT_TIMEOUT_MS, attempts = 1, headers = {} } = {}) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = Date.now()
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-best-fit', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const ms = Date.now() - startedAt
      if (!res.ok) return { ok: false, status: res.status, ms, error: `HTTP ${res.status}` }
      return { ok: true, status: res.status, ms, text: await res.text() }
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
  return { ok: false, status: 0, ms: 0, error: describeFailure(lastError) }
}

/** GitHub search → 统一条目。 */
function mapGitHubItems(items) {
  const out = []
  for (const item of items ?? []) {
    if (!item?.full_name) continue
    const [owner, repo] = String(item.full_name).split('/')
    if (!owner || !repo) continue
    out.push({
      name: item.full_name,
      owner,
      repo,
      url: item.html_url ?? `https://github.com/${item.full_name}`,
      stars: typeof item.stargazers_count === 'number' ? item.stargazers_count : null,
      description: typeof item.description === 'string' ? item.description : '',
      pushedAt: typeof item.pushed_at === 'string' ? item.pushed_at : null,
      install: `dsh plugin --profile web add github:${item.full_name}`,
      source: 'github-search',
    })
  }
  return out
}

/** npm search → 统一条目（从 repository 链接里提取 owner/repo）。 */
function mapNpmItems(objects) {
  const out = []
  for (const obj of objects ?? []) {
    const pkg = obj?.package
    if (!pkg?.name) continue
    const repoUrl = pkg.links?.repository ?? ''
    const match = String(repoUrl).match(/github\.com\/([^/]+)\/([^/#?]+)/i)
    const owner = match ? match[1] : null
    const repo = match ? match[2].replace(/\.git$/i, '') : null
    out.push({
      name: pkg.name,
      owner,
      repo,
      url: repoUrl || pkg.links?.npm || '',
      stars: null,
      description: typeof pkg.description === 'string' ? pkg.description : '',
      pushedAt: pkg.date ?? null,
      install: `dsh plugin --profile web add ${pkg.name}`,
      source: 'npm-search',
    })
  }
  return out
}

/** topics 页 HTML → 仓库链接（不按关键词，本地过滤）。 */
function mapTopicsHtml(html) {
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
function mapAwesomeJson(parsed, tokens) {
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

function tokenize(query) {
  return String(query)
    .toLowerCase()
    .split(/[\s,，、]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

function matchesQuery(item, tokens) {
  if (tokens.length === 0) return true
  const haystack = `${item.name ?? ''} ${item.description ?? ''}`.toLowerCase()
  return tokens.some((token) => haystack.includes(token))
}

/** 构造搜索路线。 */
function searchRoutes(query, { limit, githubToken }) {
  const q = encodeURIComponent(`${query} topic:dsh-plugin`)
  const perPage = Math.min(Math.max(limit * 2, 6), 30)
  const ghHeaders = githubToken ? { authorization: `Bearer ${githubToken}` } : {}
  return [
    {
      id: 'github-search',
      needsProxy: false,
      timeoutMs: 8000,
      attempts: 2,
      url: `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${perPage}`,
      headers: { ...ghHeaders, accept: 'application/vnd.github+json' },
      kind: 'github-search',
    },
    {
      id: 'npmmirror-search',
      needsProxy: false,
      timeoutMs: 8000,
      url: `https://registry.npmmirror.com/-/v1/search?text=${encodeURIComponent(query)}%20dsh-plugin&size=${perPage}`,
      kind: 'npm-search',
    },
    {
      id: 'npmjs-search',
      needsProxy: false,
      timeoutMs: 10000,
      url: `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}%20dsh-plugin&size=${perPage}`,
      kind: 'npm-search',
    },
    {
      id: 'github-topics',
      needsProxy: false,
      timeoutMs: 8000,
      // ⚠️ 这是 HTML 页面：带 accept: application/json 会被 GitHub 回 406（实测）
      headers: { accept: 'text/html' },
      url: 'https://github.com/topics/dsh-plugin',
      kind: 'topics-html',
    },
    {
      id: 'awesome-json',
      needsProxy: true,
      timeoutMs: 8000,
      url: 'https://awesome-dsh-plugin.com/plugins.json',
      kind: 'awesome-json',
    },
  ]
}

/**
 * 并行搜索，边完成边合并；到 `budgetMs` 就带已有结果返回。
 * @returns {Promise<{ok: boolean, results: object[], sources: object[], partial?: boolean, error?: string}>}
 */
export async function searchPlugins(query, { limit = 8, githubToken, budgetMs = DEFAULT_BUDGET_MS } = {}) {
  const tokens = tokenize(query)
  const routes = searchRoutes(query, { limit, githubToken })
  const sources = []
  const bucket = new Map() // lowercase name → item（先到先得）

  const ingest = (items) => {
    for (const item of items) {
      const key = String(item.name ?? '').toLowerCase()
      if (key === '' || bucket.has(key)) continue
      bucket.set(key, item)
    }
  }

  const tasks = routes.map(async (route) => {
    const res = await fetchText(route.url, {
      timeoutMs: route.timeoutMs,
      attempts: route.attempts ?? 1,
      headers: route.headers ?? {},
    })
    if (!res.ok) {
      sources.push({ route: route.id, needsProxy: route.needsProxy, ok: false, ms: res.ms, error: res.error })
      return
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
      return
    }
    sources.push({ route: route.id, needsProxy: route.needsProxy, ok: true, ms: res.ms, count: items.length })
    ingest(items)
  })

  const all = Promise.allSettled(tasks)
  let partial = false
  await Promise.race([
    all.then(() => {
      partial = false
    }),
    new Promise((resolve) => {
      setTimeout(() => {
        partial = true
        resolve()
      }, budgetMs)
    }),
  ])

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
