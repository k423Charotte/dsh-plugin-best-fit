/**
 * dsh-plugin-best-fit ——「寻找最合适的插件」
 *
 * P0 骨架：只做三件事 —— 加载、注册两个工具、被调用时如实回答"我还是骨架"。
 *  - P1：`find_dsh_plugin` 接 GitHub `topic:dsh-plugin` 搜索
 *  - P2：`check_plugin_compat` 做兼容性体检（engines.dsh / @deepseek-ai/dsh* peer → 三态）
 *
 * 设计约束：
 *  1. 零运行时依赖（不 import `@deepseek-ai/*`，只用宿主通过 `ctx.get('tools')` 给的服务）；
 *  2. 拿不到 `tools` 服务时**静默不注册**，绝不阻塞宿主启动；
 *  3. 工具参数的 JSON Schema 自己拼（DSH 要求 `type: object` + `properties`）。
 */

export const name = 'dsh-plugin-best-fit'

/** 与 package.json 同步（发布时由脚本核对）。 */
export const version = '0.1.0'

export function apply(ctx) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (!tools || typeof tools.register !== 'function') {
    // 没有 tools 服务：本插件无事可做，静默退出（不影响宿主）。
    return
  }

  /** 所有工具的返回值都以纯文本渲染，保证模型能直接读。 */
  const textOutput = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
  }

  /** 字段表 → 标准 JSON Schema。 */
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

  /** 注册一个工具；注册失败只记日志，绝不让整个插件挂掉。 */
  const define = (spec) => {
    try {
      tools.register(spec)
    } catch (err) {
      try {
        ctx.logger?.warn?.(`[best-fit] 注册工具 ${spec.name} 失败：${String(err?.message || err)}`)
      } catch {
        /* 日志失败也不值得扩散 */
      }
    }
  }

  const skeleton = (what) => ({
    status: 'skeleton',
    plugin: name,
    version,
    what,
    message:
      `${name} 已加载，但「${what}」尚未实现（当前是 P0 骨架）。` +
      '接下来会实现：P1 搜索、P2 兼容性体检。',
  })

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
    execute: async (_args) => skeleton('搜索插件'),
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
    }),
    output: textOutput,
    execute: async (_args) => skeleton('兼容性体检'),
  })
}
