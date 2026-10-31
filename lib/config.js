/**
 * 配置与凭证的本地存取。
 *
 * - 配置：`<DSH_HOME>/best-fit/config.json`（可读可改，设置浮窗通过 HTTP 路由读写）
 * - 凭证：`<DSH_HOME>/best-fit/credential.json`（**单独文件 + 0o600**，绝不写进 config.json）
 *
 * 全部路径由 `DSH_HOME` / `os.homedir()` 推导，不硬编码任何本机路径。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 默认配置（浮窗里所有可调项）。 */
export const DEFAULTS = {
  /** 查询模式：'fast'（默认，不体检、评分含估计项）| 'full'（逐条体检、评分含真实兼容结论） */
  mode: 'fast',
  /** 搜索源 id 白名单，按顺序试 */
  sources: ['npmmirror-search', 'github-search', 'npmjs-search'],
  /** 是否启用"需要代理"的路线（raw / jsDelivr / statically / ghproxy.net） */
  needsProxyRoutes: false,
  /** 搜索默认返回条数 */
  defaultLimit: 8,
  /** 是否对**全部**返回候选做兼容体检（筛选本来就该有成本，默认开） */
  checkAll: true,
  /** `checkAll = false` 时只体检前几条（0–20） */
  checkTopN: 5,
  /** 搜索时默认是否顺带体检 */
  autoCheck: true,
  /** 输出里是否带每个源的成败与耗时 */
  showDiagnostics: true,
}

export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

export function configDir() {
  return join(dshHome(), 'best-fit')
}

export function configPath() {
  return join(configDir(), 'config.json')
}

export function credentialPath() {
  return join(configDir(), 'credential.json')
}

function ensureDir() {
  const dir = configDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** 原子写：先写临时文件再 rename，避免半截文件。 */
function writeAtomic(path, text, mode) {
  ensureDir()
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, text, { encoding: 'utf8', mode })
  try {
    chmodSync(temp, mode)
  } catch {
    /* Windows 上 chmod 语义有限，忽略失败 */
  }
  renameSync(temp, path)
}

function clampInt(value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(Math.max(Math.floor(num), min), max)
}

/** 统一纠偏（读和写都走这里，避免半截坏值） */
function normalize(input) {
  const merged = { ...DEFAULTS }
  if (input && typeof input === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (Object.hasOwn(input, key)) merged[key] = input[key]
    }
  }
  if (!Array.isArray(merged.sources)) merged.sources = [...DEFAULTS.sources]
  merged.sources = merged.sources.filter((id) => typeof id === 'string')
  merged.defaultLimit = clampInt(merged.defaultLimit, 1, 20, DEFAULTS.defaultLimit)
  merged.checkTopN = clampInt(merged.checkTopN, 0, 20, DEFAULTS.checkTopN)
  merged.mode = merged.mode === 'full' ? 'full' : 'fast'
  merged.checkAll = Boolean(merged.checkAll)
  merged.needsProxyRoutes = Boolean(merged.needsProxyRoutes)
  merged.autoCheck = Boolean(merged.autoCheck)
  merged.showDiagnostics = Boolean(merged.showDiagnostics)
  return merged
}

/** 读配置（与默认值合并；读坏了就用默认值，绝不抛）。 */
export function readConfig() {
  try {
    const path = configPath()
    if (!existsSync(path)) return { ...DEFAULTS }
    return normalize(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return { ...DEFAULTS }
  }
}

/** 局部更新配置（只认已知键）。 */
export function writeConfig(partial) {
  const current = readConfig()
  const next = { ...current }
  if (partial && typeof partial === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (!Object.hasOwn(partial, key)) continue
      const value = partial[key]
      if (key === 'sources') {
        if (Array.isArray(value)) next.sources = value.filter((id) => typeof id === 'string')
      } else if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
        next[key] = value
      }
    }
  }
  const normalized = normalize(next)
  writeAtomic(configPath(), `${JSON.stringify(normalized, null, 2)}\n`, 0o600)
  return normalized
}

/** 读 GitHub token（没有就返回空串）。 */
export function readToken() {
  try {
    const path = credentialPath()
    if (!existsSync(path)) return ''
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed?.github_token === 'string' ? parsed.github_token : ''
  } catch {
    return ''
  }
}

/** 写 GitHub token（空串 = 删除）。 */
export function writeToken(token) {
  const value = typeof token === 'string' ? token.trim() : ''
  if (value === '') {
    try {
      const path = credentialPath()
      if (existsSync(path)) writeAtomic(path, '{}\n', 0o600)
    } catch {
      /* 删除失败不致命 */
    }
    return
  }
  writeAtomic(credentialPath(), `${JSON.stringify({ github_token: value }, null, 2)}\n`, 0o600)
}

/** 给前端的安全视图：不回显 token，只告诉它有没有。 */
export function publicConfig() {
  const config = readConfig()
  const token = readToken()
  return {
    ...config,
    hasToken: token !== '',
    tokenHint: token === '' ? '' : `••••${token.slice(-4)}`,
    paths: { config: configPath(), credential: credentialPath() },
  }
}
