/**
 * dsh-plugin-best-fit ——「寻找最合适的插件」
 *
 * 当前进度：
 *  - P0：骨架（加载 + 工具注册）✅
 *  - P2：兼容性体检 ✅（本文件里 check_plugin_compat 已接真实现）
 *  - P1：搜索 —— 待实现（find_dsh_plugin 仍返回骨架状态）
 *
 * 设计约束：零运行时依赖；拿不到 tools 服务时静默不注册；结论必须可溯源。
 */

import { detectRuntimeVersion } from './runtime.js'
import { describeFailure, fetchManifest } from './source.js'
import { evaluateCompat, formatVerdict } from './compat.js'

export const name = 'dsh-plugin-best-fit'

/** 与 package.json 同步。 */
export const version = '0.1.0'

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
    try {
      tools.register(spec)
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
      '在会话里搜索 DSH 插件。按关键词搜 GitHub 上 `topic:dsh-plugin` 的仓库，返回每条的名称 / owner / 星数 / 最近推送 / 一句话描述 / 安装命令。' +
      '传 `check: true` 时会对前 3 条顺带做兼容性体检（会多发几次网络请求，默认关闭）。' +
      '只返回安装命令字符串，**不会自动安装**任何第三方代码。',
    parameters: params({
      query: {
        type: 'string',
        required: true,
        description: '关键词，中英文都行（例："终端 TUI"、"微信通知"、"sidebar"、"memory"）',
      },
      limit: { type: 'number', description: '返回几条，默认 8，上限 20' },
      check: { type: 'boolean', description: '是否对前 3 条做兼容性体检，默认 false' },
    }),
    output: textOutput,
    execute: async () => ({
      status: 'skeleton',
      plugin: name,
      version,
      what: '搜索插件',
      message: `${name} 已加载，但「搜索插件」尚未实现（搜索在 P1 实现）。兼容性体检已可用：请用 check_plugin_compat。`,
    }),
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

      // 1) runtime 版本：显式参数优先，否则自动探测
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

      // 2) 取 manifest
      const token = await resolveGitHubToken(ctx)
      const fetched = await fetchManifest(target, { githubToken: token })
      if (!fetched.ok) {
        return {
          status: 'error',
          target,
          source: fetched.source,
          url: fetched.url,
          error: `取不到 package.json：${fetched.error}`,
          hint: 'GitHub contents API 与 npm registry 都试过了；如果这是私有仓库或没发 npm，只能人工核对。',
        }
      }

      // 3) 判定
      const manifest = fetched.manifest
      const result = evaluateCompat(manifest, runtime)
      const verdict = formatVerdict(result, { target, manifest })

      return {
        status: result.status,
        target,
        manifest: {
          name: manifest.name,
          version: manifest.version,
          engines: manifest.engines,
          peerDependencies: manifest.peerDependencies,
        },
        runtime,
        runtimeSource,
        fieldUsed: result.fieldUsed,
        requirements: result.requirements,
        failed: result.failed,
        reason: result.reason,
        source: fetched.source,
        url: fetched.url,
        verdict,
        note:
          '判定规则与 DSH 门禁一致（engines.dsh 存在时只看它；否则校验 @deepseek-ai/dsh* peer；预发布参与匹配）。' +
          '拿不到 manifest 时不会猜 —— 只会报错并说明试过哪些来源。',
      }
    },
  })
}
