/**
 * 探测「当前运行的 DSH 版本」。
 *
 * 优先级（越靠前越准）：
 *  1. 动态 import `@deepseek-ai/dsh-app-boot` 的 `getDshRuntimeVersion()`；
 *  2. Electron：`require('<app.asar>/package.json')`（asar 虚拟路径，宿主原生支持）；
 *  3. 手读 asar header（普通 Node 环境）；
 *  4. 读 `$DSH_HOME/profiles/<profile>/node_modules/@deepseek-ai/dsh/package.json`；
 *  5. 环境变量 `DSH_VERSION` / `DSH_RUNTIME_VERSION`。
 *
 * 全部失败时返回 `{ version: null, attempts }` —— 调用方应要求显式传 runtime，**绝不猜**。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { candidateAsarPaths, findAsar, inspectAsarFile, requireAsarFile } from './asar.js'

/** DSH 数据目录（与 dsh-home-paths 的规则一致：显式 env → 空白当未设 → ~/.dsh）。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 进程内缓存（版本不会变）。 */
let cached = null

const short = (value, max = 220) => String(value ?? '').slice(0, max)

const pickVersion = (manifest) =>
  manifest && typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : null

/**
 * @returns {Promise<{version: string|null, source: string, attempts: Array<{source: string, ok: boolean, note?: string}>}>}
 */
export async function detectRuntimeVersion() {
  if (cached !== null) return cached
  const attempts = []

  // ① 官方模块
  try {
    const mod = await import('@deepseek-ai/dsh-app-boot')
    const fn = mod?.getDshRuntimeVersion
    if (typeof fn === 'function') {
      const value = fn()
      if (typeof value === 'string' && value !== '') {
        attempts.push({ source: '@deepseek-ai/dsh-app-boot', ok: true, note: value })
        cached = { version: value, source: '@deepseek-ai/dsh-app-boot → getDshRuntimeVersion()', attempts }
        return cached
      }
      attempts.push({ source: '@deepseek-ai/dsh-app-boot', ok: false, note: 'getDshRuntimeVersion() 返回空' })
    } else {
      attempts.push({ source: '@deepseek-ai/dsh-app-boot', ok: false, note: '模块已加载但没有 getDshRuntimeVersion' })
    }
  } catch (error) {
    attempts.push({ source: '@deepseek-ai/dsh-app-boot', ok: false, note: `import 失败：${short(error?.message || error, 150)}` })
  }

  // ②③ asar 两条路
  const asar = findAsar()
  if (asar === null) {
    attempts.push({
      source: 'asar',
      ok: false,
      note: `未找到 app.asar；execPath=${short(process.execPath, 110)}；候选=${candidateAsarPaths()
        .map((c) => short(c, 80))
        .join(' | ')}`,
    })
  } else {
    // ② Electron 的 asar 虚拟路径（优先）
    const required = requireAsarFile(asar, 'package.json')
    const requiredVersion = required.ok ? pickVersion(required.value) : null
    if (requiredVersion !== null) {
      attempts.push({ source: 'asar(require)', ok: true, note: `${short(asar, 100)} → ${requiredVersion}` })
      cached = { version: requiredVersion, source: `app.asar 的 package.json（Electron asar 虚拟路径）`, attempts }
      return cached
    }
    attempts.push({
      source: 'asar(require)',
      ok: false,
      note: short(required.error || 'require 成功但拿不到 version', 180),
    })

    // ③ 手读 header（普通 Node 有效；Electron 里预期为 `not found in <asar>`）
    const inspected = inspectAsarFile(asar, 'package.json')
    const inspectedVersion = inspected.ok ? pickVersion(JSON.parse(inspected.text)) : null
    if (inspectedVersion !== null) {
      attempts.push({ source: 'asar(header)', ok: true, note: `${short(asar, 100)} → ${inspectedVersion}` })
      cached = { version: inspectedVersion, source: 'app.asar 的 package.json（手读 header）', attempts }
      return cached
    }
    attempts.push({ source: 'asar(header)', ok: false, note: short(inspected.error, 180) })
  }

  // ④ profile 里的主包
  try {
    const profilesDir = join(dshHome(), 'profiles')
    if (!existsSync(profilesDir)) {
      attempts.push({ source: 'profile', ok: false, note: `没有 ${profilesDir}` })
    } else {
      let hit = false
      for (const profile of readdirSync(profilesDir)) {
        const manifestPath = join(profilesDir, profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
        if (!existsSync(manifestPath)) continue
        const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (pickVersion(parsed) !== null) {
          attempts.push({ source: 'profile', ok: true, note: `${profile} → ${parsed.version}` })
          cached = { version: parsed.version, source: `profile「${profile}」的 @deepseek-ai/dsh/package.json`, attempts }
          return cached
        }
        hit = true
      }
      if (!hit) attempts.push({ source: 'profile', ok: false, note: 'profiles 下没有 @deepseek-ai/dsh/package.json' })
    }
  } catch (error) {
    attempts.push({ source: 'profile', ok: false, note: short(error?.message || error, 150) })
  }

  // ⑤ 环境变量
  for (const key of ['DSH_VERSION', 'DSH_RUNTIME_VERSION']) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim() !== '') {
      attempts.push({ source: `env ${key}`, ok: true, note: value.trim() })
      cached = { version: value.trim(), source: `环境变量 ${key}`, attempts }
      return cached
    }
  }
  attempts.push({ source: 'env', ok: false, note: 'DSH_VERSION / DSH_RUNTIME_VERSION 都未设置' })

  cached = { version: null, source: '未能探测（调用方应显式传 runtime）', attempts }
  return cached
}
