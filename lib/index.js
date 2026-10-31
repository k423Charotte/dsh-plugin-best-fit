/**
 * dsh-plugin-best-fit ——「寻找最合适的插件」
 *
 * 进度：P0 骨架 ✅ · P1 搜索 ✅ · P2 兼容体检 ✅ · P3 联动 ✅ · P4 多源降级 ✅ · P5 打磨 ✅
 *        P7 输入框浮窗 ✅ · P8 评分（让「最合适」有依据）✅
 *
 * 设计约束：零运行时依赖；拿不到 tools 服务时静默不注册；结论必须可溯源；绝不自动安装任何东西。
 */

import { detectRuntimeVersion } from './runtime.js'
import { fetchManifest } from './source.js'
import { searchPlugins } from './registry.js'
import { evaluateCompat, formatVerdict } from './compat.js'
import { parseVersion } from './semver.js'
import { wellFormedDeep } from './sanitize.js'
import { explainScore, scoreCandidate, WEIGHTS } from './score.js'
import { readConfig, readToken, publicConfig } from './config.js'
import { registerRoutes } from './routes.js'

export const name = 'dsh-plugin-best-fit'

/** 与 package.json 同步。 */
export const version = '0.1.1'

const MAX_LIMIT = 20
const DEFAULT_LIMIT = 8
const DEFAULT_CHECK_TOP_N = 3

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
const keyOf = (name) => String(name ?? '').toLowerCase()

/**
 * GitHub token 解析顺序：
 *  1. 插件浮窗里配置的 token（`<DSH_HOME>/best-fit/credential.json`）；
 *  2. DSH credentials 服务里的 `GITHUB_TOKEN`。
 */
async function resolveGitHubToken(ctx) {
  try {
    const own = readToken()
    if (typeof own === 'string' && own !== '') return own
  } catch {
    /* 读不到就走下一档 */
  }
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
    if (!service || typeof service.resolve !== 'function') return undefined
    const resolved = await service.resolve('GITHUB_TOKEN')
    const value = resolved?.value
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/** 把一条候选连同评分一起整理成对外的形状。 */
function decorate(item, compat) {
  const result = scoreCandidate(item, { compat })
  return {
    ...item,
    score: result.score,
    scoreParts: result.scoreParts,
    checklist: result.checklist,
    caveats: result.caveats,
  }
}

/** 搜索摘要（含每条评分与最值得注意的提醒）。 */
function renderSearchSummary(results, { ms, partial, weights }) {
  const head =
    `找到 ${results.length} 条（${ms}ms${partial ? '，部分来源未返回' : ''}）｜` +
    `评分权重：兼容 ${weights.compatibility} / 活跃 ${weights.activity} / 人气 ${weights.popularity} / 健康 ${weights.health} / 风险 ${weights.risk}`
  const body = results.map((item, index) => {
    const stars = typeof item.stars === 'number' ? `★${item.stars}` : '★?'
    const description = (item.description || '(无描述)').replace(/\s+/g, ' ').slice(0, 60)
    const caveat = Array.isArray(item.caveats) && item.caveats.length > 0 ? `\n   ⚠ ${item.caveats[0]}` : ''
    return `${index + 1}. ${item.name}  ${stars}  ${item.score} 分  ${description}${caveat}\n   ${item.install}`
  })
  return [head, ...body].join('\n')
}

export function apply(ctx) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined

  try {
    registerRoutes(ctx, ctx.logger)
  } catch (error) {
    try {
      ctx.logger?.warn?.(`[best-fit] registerRoutes 失败：${String(error?.message || error)}`)
    } catch {
      /* 忽略 */
    }
  }

  if (!tools || typeof tools.register !== 'function') return

  const textOutput = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
  }

  const params = (spec) => {
    const properties = {}
    const required = []
    for (const [key, field] of Object.entries(spec || {})) {
      properties[key] = { type: field.type, description: field.description }
      if (field.enum) properties[key].enum = field.enum
      if (field.required) required.push(key)
    }
    const out = { type: 'object', properties }
    if (required.length) out.required = required
    return out
  }

  const define = (spec) => {
    const inner = typeof spec.execute === 'function' ? spec.execute : null
    // ⚠️ 出口统一修 well-formed：搜索描述可能带孤立代理项，且 undefined 字段会让 JSON 往返不无损，
    // DSH 会以 `value is not lossless JSON` 拒绝整包（2026-10-31 实测）。
    const wrapped = inner ? { ...spec, execute: async (...args) => wellFormedDeep(await inner(...args)) } : spec
    try {
      tools.register(wrapped)
    } catch (err) {
      try {
        ctx.logger?.warn?.(`[best-fit] 注册工具 ${spec.name} 失败：${String(err?.message || err)}`)
      } catch {
        /* 日志失败无所谓 */
      }
    }
  }

  define({
    name: 'find_dsh_plugin',
    description:
      '在会话里搜索 DSH 插件，并按**可解释的评分**排序（兼容性 40 / 活跃度 25 / 人气 20 / 维护健康 10 / 风险 5）。' +
      '返回：名称 / owner / 星数 / 最近推送 / 一句话描述 / **评分与分项** / 风险提醒 / **可直接粘贴的安装命令**。' +
      '传 `check: true` 会对前几条先做版本兼容体检，再用兼容性重新排序（更准但更慢，默认关闭）。' +
      '只返回安装命令字符串，**绝不自动安装**任何第三方代码。',
    parameters: params({
      query: {
        type: 'string',
        required: true,
        description: '关键词，中英文都行（例："终端 TUI"、"微信通知"、"sidebar"、"memory"）',
      },
      limit: { type: 'number', description: `返回几条，默认 ${DEFAULT_LIMIT}（可在浮窗里改），上限 ${MAX_LIMIT}` },
      check: { type: 'boolean', description: '是否对前几条做兼容性体检并按兼容性重排（默认按浮窗设置）' },
      runtime: { type: 'string', description: '可选：体检时对照的 DSH 版本（默认自动探测当前运行版本）' },
    }),
    output: textOutput,
    execute: async (args = {}) => {
      const query = String(args.query ?? '').trim()
      if (query === '') return { status: 'error', error: 'query 不能为空' }

      const config = readConfig()
      const limit = clamp(
        Number.isFinite(Number(args.limit)) ? Math.floor(Number(args.limit)) : config.defaultLimit,
        1,
        MAX_LIMIT,
      )
      const shouldCheck = typeof args.check === 'boolean' ? args.check : config.autoCheck === true
      const checkTopN = clamp(config.checkTopN ?? DEFAULT_CHECK_TOP_N, 0, 5)
      const token = await resolveGitHubToken(ctx)
      const startedAt = Date.now()
      const found = await searchPlugins(query, {
        limit,
        githubToken: token,
        includeNeedsProxy: config.needsProxyRoutes === true,
      })

      if (!found.ok) {
        return {
          status: 'error',
          query,
          error: `所有搜索路线都失败：${found.error}`,
          sources: config.showDiagnostics ? found.sources : null,
          note: '网络或限流问题；可稍后重试，或在插件浮窗里配置 GitHub Token 提高限额。',
        }
      }

      // ── 阶段一：静态评分（不含兼容性）后排序 ─────────────────────────────
      let results = found.results.map((item) => decorate(item)).sort((a, b) => b.score - a.score)

      // ── 阶段二：体检 → 把兼容性计入 → 重排 ───────────────────────────────
      let checks = null
      if (shouldCheck && checkTopN > 0 && results.length > 0) {
        let runtime = typeof args.runtime === 'string' ? args.runtime.trim() : ''
        let runtimeSource = '调用方传入'
        if (runtime === '') {
          const detected = await detectRuntimeVersion()
          runtime = detected.version ?? ''
          runtimeSource = detected.source
        }
        if (parseVersion(runtime) !== null) {
          // 默认**体检全部候选**（筛选本身有成本，不为省时间砍条数）；只有显式关掉 checkAll 才截断。
          const checkTargets = config.checkAll === true ? results : results.slice(0, checkTopN)
          const compatByKey = new Map()
          checks = []
          for (const item of checkTargets) {
            const target = item.owner && item.repo ? `${item.owner}/${item.repo}` : item.name
            const fetched = await fetchManifest(target, {
              githubToken: token,
              includeNeedsProxy: config.needsProxyRoutes === true,
            })
            if (!fetched.ok) {
              checks.push({ target, label: item.name, status: 'error', error: `取不到 manifest：${fetched.error}` })
              compatByKey.set(keyOf(item.name), { status: 'error' })
              continue
            }
            const verdict = evaluateCompat(fetched.manifest, runtime)
            checks.push({
              target,
              label: item.name,
              status: verdict.status,
              runtime,
              fieldUsed: verdict.fieldUsed,
              requirements: verdict.requirements,
              reason: verdict.reason,
              route: fetched.route,
            })
            compatByKey.set(keyOf(item.name), {
              status: verdict.status,
              fieldUsed: verdict.fieldUsed,
              requirements: verdict.requirements,
            })
          }
          // 用体检结论重新打分（兼容性占 40 分）并重排
          results = results
            .map((item) => {
              const compat = compatByKey.get(keyOf(item.name))
              if (!compat) return item
              const base = { ...item }
              delete base.score
              delete base.scoreParts
              delete base.checklist
              delete base.caveats
              const scoredItem = decorate(base, compat)
              // 便于核对：把「参与打分的那个兼容性结论」一并带出来
              return { ...scoredItem, compatStatus: compat.status }
            })
            .sort((a, b) => b.score - a.score)
        }
      }

      const finalResults = results.slice(0, limit)
      const summary = renderSearchSummary(finalResults, {
        ms: Date.now() - startedAt,
        partial: found.partial === true,
        weights: WEIGHTS,
      })

      return {
        status: 'ok',
        query,
        runtime: (await detectRuntimeVersion()).version,
        count: finalResults.length,
        results: finalResults,
        summary,
        checks,
        sources: config.showDiagnostics ? found.sources : null,
        partial: found.partial === true,
        scored: shouldCheck && checks !== null,
        ms: Date.now() - startedAt,
        note:
          `评分 = 兼容性 ${WEIGHTS.compatibility} + 活跃度 ${WEIGHTS.activity} + 人气 ${WEIGHTS.popularity} + 维护健康 ${WEIGHTS.health} + 风险 ${WEIGHTS.risk}。` +
          '未做体检时兼容性按“未体检”给 15 分；`check: true` 会用真实体检结论替换并重排。' +
          '`install` 只是命令字符串，是否执行、是否信任由你决定；第三方插件是**未经安全检测**的代码。',
      }
    },
  })

  define({
    name: 'check_plugin_compat',
    description:
      '判断一个 DSH 插件是否适配**当前正在运行的 DSH 版本**。' +
      '`target` 接受两种写法：GitHub 的 `owner/repo`，或 npm 包名（可带版本，如 `bili-duty@0.1.3`）。' +
      '返回三态：`ok`（兼容，附判据字段与范围）/ `incompatible`（不兼容，附要求原文）/ `none`（该插件未声明任何 dsh 要求 —— 不等于能用，只是不会被门禁拦）。' +
      '判定依据：`engines.dsh` 存在时只看它（peerDependencies 被忽略），否则逐个校验 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 peer 范围，且预发布参与匹配。',
    parameters: params({
      target: {
        type: 'string',
        required: true,
        description: '`owner/repo`（GitHub）或 npm 包名（可带 @版本）',
      },
      runtime: {
        type: 'string',
        description: '可选：显式指定要对照的 DSH 版本（默认自动探测当前运行的版本）',
      },
    }),
    output: textOutput,
    execute: async (args = {}) => {
      const target = typeof args.target === 'string' ? args.target.trim() : ''
      if (target === '') return { status: 'error', error: 'target 不能为空（`owner/repo` 或 npm 包名）' }

      const config = readConfig()
      let runtime = typeof args.runtime === 'string' ? args.runtime.trim() : ''
      let runtimeSource = '调用方传入'
      let runtimeAttempts
      if (runtime === '') {
        const detected = await detectRuntimeVersion()
        runtime = detected.version ?? ''
        runtimeSource = detected.source
        runtimeAttempts = detected.attempts
      }
      if (runtime === '') {
        return {
          status: 'error',
          error: '无法确定当前 DSH 版本，请在调用时传 `runtime`（例如 runtime: "0.2.1-rc.5"）',
          runtimeAttempts,
        }
      }
      if (parseVersion(runtime) === null) {
        return {
          status: 'error',
          target,
          error: `runtime 版本不合法：${JSON.stringify(runtime)}（需要形如 0.2.1-rc.5）`,
        }
      }

      const token = await resolveGitHubToken(ctx)
      const fetched = await fetchManifest(target, {
        githubToken: token,
        includeNeedsProxy: config.needsProxyRoutes === true,
      })
      if (!fetched.ok) {
        return {
          status: 'error',
          target,
          error: `取不到 package.json：${fetched.error}`,
          attempts: fetched.attempts,
          hint: '所有可用路线都试过了。若这是私有仓库或没发 npm，只能人工核对。',
        }
      }

      const manifest = fetched.manifest
      const result = evaluateCompat(manifest, runtime)
      const verdict = formatVerdict(result, { target, manifest })
      const scored = scoreCandidate(
        { hasInstallScript: manifest.hasInstallScript === true, peerCount: manifest.peerCount ?? 0 },
        { compat: { status: result.status, fieldUsed: result.fieldUsed, requirements: result.requirements } },
      )

      return {
        status: result.status,
        target,
        manifest: {
          name: manifest.name,
          version: manifest.version,
          engines: manifest.engines,
          peerDependencies: manifest.peerDependencies,
          repository: manifest.repository,
        },
        runtime,
        runtimeSource,
        fieldUsed: result.fieldUsed,
        requirements: result.requirements,
        failed: result.failed,
        reason: result.reason,
        route: fetched.route,
        attempts: config.showDiagnostics ? fetched.attempts : null,
        verdict,
        score: scored.score,
        scoreParts: scored.scoreParts,
        caveats: scored.caveats,
        note:
          '判定规则与 DSH 门禁一致（engines.dsh 存在时只看它；否则校验 @deepseek-ai/dsh* peer；预发布参与匹配）。' +
          '拿不到 manifest 时不会猜 —— 只会报错并说明试过哪些路线。',
      }
    },
  })
}

/** 供浮窗之外的地方读取配置。 */
export { publicConfig, explainScore }
