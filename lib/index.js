/**
 * dsh-plugin-best-fit ——「寻找最合适的插件」
 *
 * 进度：P0 骨架 ✅ · P2 兼容体检 ✅ · P1 搜索（多路线竞速）✅（本文件）
 *        P3 搜索+体检联动 ✅（check 参数）· P4 多源降级 ✅（每条路线独立、失败静默）
 *
 * 设计约束：零运行时依赖；拿不到 tools 服务时静默不注册；结论必须可溯源；不自动安装任何东西。
 */

import { detectRuntimeVersion } from './runtime.js'
import { fetchManifest } from './source.js'
import { searchPlugins } from './registry.js'
import { evaluateCompat, formatVerdict } from './compat.js'
import { parseVersion } from './semver.js'
import { wellFormedDeep } from './sanitize.js'

export const name = 'dsh-plugin-best-fit'

/** 与 package.json 同步。 */
export const version = '0.1.0'

const MAX_LIMIT = 20
const DEFAULT_LIMIT = 8
const CHECK_TOP_N = 3

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

/** 可选服务：credential 里配了 GITHUB_TOKEN 就用它提限额；没有也不影响。 */
async function resolveGitHubToken(ctx) {
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

export function apply(ctx) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
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
    // ⚠️ 出口统一修 well-formed：搜索结果里的描述可能带孤立代理项，
    // 不修的话 DSH 工具层会以 `value is not lossless JSON` 拒绝整包（2026-10-31 实测）。
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
      '在会话里搜索 DSH 插件。并行查询多个来源（GitHub `topic:dsh-plugin`、npm registry 搜索、GitHub topics 页），按星数排序返回：' +
      '名称 / owner / 星数 / 最近推送 / 一句话描述 / **可直接粘贴的安装命令**。' +
      '传 `check: true` 时会对前 3 条顺带做兼容性体检（每条都要额外取一次包元数据，默认关闭）。' +
      '只返回安装命令字符串，**绝不自动安装**任何第三方代码。',
    parameters: params({
      query: {
        type: 'string',
        required: true,
        description: '关键词，中英文都行（例："终端 TUI"、"微信通知"、"sidebar"、"memory"）',
      },
      limit: { type: 'number', description: `返回几条，默认 ${DEFAULT_LIMIT}，上限 ${MAX_LIMIT}` },
      check: { type: 'boolean', description: '是否对前 3 条做兼容性体检，默认 false（会多发请求）' },
    }),
    output: textOutput,
    execute: async (args = {}) => {
      const query = String(args.query ?? '').trim()
      if (query === '') return { status: 'error', error: 'query 不能为空' }

      const limit = clamp(Number.isFinite(Number(args.limit)) ? Math.floor(Number(args.limit)) : DEFAULT_LIMIT, 1, MAX_LIMIT)
      const token = await resolveGitHubToken(ctx)
      const startedAt = Date.now()
      const found = await searchPlugins(query, { limit, githubToken: token })

      if (!found.ok) {
        return {
          status: 'error',
          query,
          error: `所有搜索路线都失败：${found.error}`,
          sources: found.sources,
          note: '网络或限流问题；可稍后重试，或在 DSH 的 credentials 里配置 GITHUB_TOKEN 提高限额。',
        }
      }

      // 可选：对前 N 条做体检（未开启时保持 null，别留 undefined —— 那会让工具结果不 lossless）
      let checks = null
      if (args.check === true && found.results.length > 0) {
        const detected = await detectRuntimeVersion()
        const top = found.results.slice(0, CHECK_TOP_N)
        checks = await Promise.all(
          top.map(async (item) => {
            const target = item.owner && item.repo ? `${item.owner}/${item.repo}` : item.name
            const label = item.name
            if (detected.version === null) {
              return { target, label, status: 'error', error: '无法探测当前 DSH 版本；请传 runtime 或先手动核对' }
            }
            const fetched = await fetchManifest(target, { githubToken: token })
            if (!fetched.ok) {
              return { target, label, status: 'error', error: `取不到 manifest：${fetched.error}` }
            }
            const verdict = evaluateCompat(fetched.manifest, detected.version)
            return {
              target,
              label,
              status: verdict.status,
              runtime: detected.version,
              fieldUsed: verdict.fieldUsed,
              requirements: verdict.requirements,
              reason: verdict.reason,
              route: fetched.route,
            }
          }),
        )
      }

      return {
        status: 'ok',
        query,
        runtime: (await detectRuntimeVersion()).version,
        count: found.results.length,
        results: found.results,
        checks,
        sources: found.sources,
        ms: Date.now() - startedAt,
        note:
          '结果来自多个来源的竞速合并（GitHub 搜索优先，npm 搜索补充）。' +
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
      // runtime 格式先校验，避免为了一个非法版本号去白跑一轮网络
      if (parseVersion(runtime) === null) {
        return {
          status: 'error',
          target,
          error: `runtime 版本不合法：${JSON.stringify(runtime)}（需要形如 0.2.1-rc.5）`,
        }
      }

      const token = await resolveGitHubToken(ctx)
      const fetched = await fetchManifest(target, { githubToken: token })
      if (!fetched.ok) {
        return {
          status: 'error',
          target,
          error: `取不到 package.json：${fetched.error}`,
          attempts: fetched.attempts,
          hint: '所有路线都试过了（npm 镜像/官方、esm.sh、unpkg、GitHub contents、gh-proxy 等）。若这是私有仓库或没发 npm，只能人工核对。',
        }
      }

      const manifest = fetched.manifest
      const result = evaluateCompat(manifest, runtime)
      const verdict = formatVerdict(result, { target, manifest })

      return {
        status: result.status,
        target,
        manifest,
        runtime,
        runtimeSource,
        fieldUsed: result.fieldUsed,
        requirements: result.requirements,
        failed: result.failed,
        reason: result.reason,
        route: fetched.route,
        attempts: fetched.attempts,
        verdict,
        note:
          '判定规则与 DSH 门禁一致（engines.dsh 存在时只看它；否则校验 @deepseek-ai/dsh* peer；预发布参与匹配）。' +
          '拿不到 manifest 时不会猜 —— 只会报错并说明试过哪些路线。',
      }
    },
  })
}
