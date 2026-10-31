/**
 * 兼容性判定：把 manifest + runtime 版本 → 三态结论。
 *
 * 规则来源：DSH 0.2.1-rc.5 的 `dsh-app-boot` 里 `unmetRequirements()`（2026-10-31 从 asar 源码核实）：
 *  1. **有 `engines.dsh` → 只按它判**，`peerDependencies` 里的 dsh 包全部被忽略；
 *  2. 没有 `engines.dsh` → 逐个校验 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 peer 范围；
 *  3. peer 里写 `workspace:^` / `workspace:~` / `workspace:*` → 视为「当前 runtime」；
 *  4. **预发布参与匹配**（includePrerelease），`>=0.2.0-rc.2` 能覆盖 `0.2.1-rc.5`。
 *
 * 三态：`ok` / `incompatible` / `none`（未声明 —— 门禁不拦，但不等于能用）。
 */

import { parseVersion, satisfies } from './semver.js'

const DSH_PEER = '@deepseek-ai/dsh'
const DSH_PEER_PREFIX = '@deepseek-ai/dsh-'
const WORKSPACE_RANGES = new Set(['workspace:^', 'workspace:~', 'workspace:*'])

const isDshPeer = (name) => name === DSH_PEER || name.startsWith(DSH_PEER_PREFIX)

/**
 * @param {{engines?: object, peerDependencies?: object, name?: string, version?: string}} manifest
 * @param {string} runtimeVersion 例如 `0.2.1-rc.5`
 */
export function evaluateCompat(manifest, runtimeVersion) {
  const runtime = String(runtimeVersion ?? '').trim()
  if (!parseVersion(runtime)) {
    return {
      status: 'error',
      fieldUsed: null,
      runtime,
      requirements: {},
      failed: {},
      reason: `runtime 版本不合法：${JSON.stringify(runtimeVersion)}（需要形如 0.2.1-rc.5）`,
    }
  }

  const enginesDsh = manifest?.engines?.dsh
  if (typeof enginesDsh === 'string' && enginesDsh.trim() !== '') {
    const range = enginesDsh.trim()
    const ok = satisfies(runtime, range)
    return {
      status: ok ? 'ok' : 'incompatible',
      fieldUsed: 'engines.dsh',
      runtime,
      requirements: { 'engines.dsh': range },
      failed: ok ? {} : { 'engines.dsh': range },
      reason: ok
        ? `engines.dsh「${range}」覆盖 ${runtime}`
        : `engines.dsh 要求「${range}」，当前 ${runtime} 不满足（声明了 engines.dsh 时 peerDependencies 被忽略）`,
    }
  }

  const peers = manifest?.peerDependencies
  const dshPeers = {}
  if (peers && typeof peers === 'object') {
    for (const [peerName, range] of Object.entries(peers)) {
      if (isDshPeer(peerName) && typeof range === 'string' && range.trim() !== '') {
        dshPeers[peerName] = range.trim()
      }
    }
  }

  if (Object.keys(dshPeers).length === 0) {
    return {
      status: 'none',
      fieldUsed: null,
      runtime,
      requirements: {},
      failed: {},
      reason:
        '该插件既没有 engines.dsh，也没有 @deepseek-ai/dsh* 的 peerDependencies —— ' +
        '门禁不会拦它，**但这不代表它能用**（作者没声明任何版本约束）。',
    }
  }

  const failed = {}
  for (const [peerName, range] of Object.entries(dshPeers)) {
    if (WORKSPACE_RANGES.has(range)) continue // 视为当前 runtime，恒满足
    if (!satisfies(runtime, range)) failed[peerName] = range
  }
  const ok = Object.keys(failed).length === 0
  return {
    status: ok ? 'ok' : 'incompatible',
    fieldUsed: 'peerDependencies',
    runtime,
    requirements: dshPeers,
    failed,
    reason: ok
      ? `所有 @deepseek-ai/dsh* peer 范围都覆盖 ${runtime}`
      : `不满足：${Object.entries(failed)
          .map(([peerName, range]) => `${peerName} 要求「${range}」`)
          .join('；')}`,
  }
}

const STATUS_TEXT = {
  ok: '✅ 兼容',
  incompatible: '❌ 不兼容',
  none: '⚠️ 未声明',
  error: '❗ 无法判定',
}

/** 把判定结果渲染成一段中文文本（给工具返回用）。 */
export function formatVerdict(result, { target, manifest } = {}) {
  const lines = []
  const label = manifest?.name ? `${manifest.name}@${manifest.version ?? '?'}` : String(target ?? '')
  lines.push(`${STATUS_TEXT[result.status] ?? result.status} · ${label}`)
  lines.push(`当前 DSH：${result.runtime || '未知'}`)
  if (result.fieldUsed) lines.push(`判据字段：${result.fieldUsed}`)
  lines.push(`结论：${result.reason}`)
  if (Object.keys(result.requirements || {}).length > 0) {
    lines.push(
      '声明原文：' +
        Object.entries(result.requirements)
          .map(([k, v]) => `${k}=${v}`)
          .join('，'),
    )
  }
  if (result.status === 'none') {
    lines.push('建议：先在测试环境装一次并调一次工具，确认它真的能工作。')
  }
  if (result.status === 'incompatible') {
    lines.push('建议：升级该插件、或留在匹配的 DSH 版本；强行安装会被门禁 disabled（模块永不导入）。')
  }
  return lines.join('\n')
}
