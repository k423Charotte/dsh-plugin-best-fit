/**
 * 最小 semver：只实现「版本是否落在范围里」。
 *
 * ⚠️ 语义来源：DSH 的 `plugin-compatibility.ts` 用
 * `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 判定门禁。
 * 所以本实现**默认 includePrerelease**：预发布版本按普通版本参与比较。
 *
 * ⚠️ 关键细节：`^` / `~` / `x` 范围生成的**上界必须带 `-0` 预发布**
 * （如 `^0.1.0-rc.6` → `>=0.1.0-rc.6 <0.2.0-0`）。少了 `-0`，`0.2.0-rc.1` 这类
 * 预发布会被 `<0.2.0` 误判为满足 —— 这是与官方 semver 对照测试抓出来的差异。
 *
 * 支持：`1.2.3` / `=1.2.3` / `>1.2.3` / `>=1.2.3` / `<1.2.3` / `<=1.2.3` /
 * `^1.2.3` / `~1.2.3` / `1.2.x` / `1.x` / `*` / `>=1.2.3 <2.0.0` / `a || b` / `1.2.3 - 2.3.4`
 */

const NUM = /^\d+$/

/** 解析完整版本；不合法返回 null。 */
export function parseVersion(input) {
  if (typeof input !== 'string') return null
  const m = input
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
  }
}

const numCmp = (a, b) => (a === b ? 0 : a < b ? -1 : 1)

/** 版本比较：返回 -1 / 0 / 1。 */
export function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    const c = numCmp(a[key], b[key])
    if (c !== 0) return c
  }
  const ap = a.pre || []
  const bp = b.pre || []
  if (ap.length === 0 && bp.length === 0) return 0
  if (ap.length === 0) return 1 // 有预发布 < 无预发布
  if (bp.length === 0) return -1
  const len = Math.max(ap.length, bp.length)
  for (let i = 0; i < len; i += 1) {
    const x = ap[i]
    const y = bp[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = NUM.test(x)
    const yn = NUM.test(y)
    if (xn && yn) {
      const c = numCmp(Number(x), Number(y))
      if (c !== 0) return c
      continue
    }
    if (xn) return -1 // 数字标识符 < 字母标识符
    if (yn) return 1
    const c = x === y ? 0 : x < y ? -1 : 1
    if (c !== 0) return c
  }
  return 0
}

/**
 * 松散解析：`1` / `1.2` / `1.2.3` / `1.x` / `*` 都接受，缺的部分记 null。
 */
function parsePartial(text) {
  const raw = String(text).trim().replace(/^v/i, '')
  if (raw === '' || raw === '*' || raw === 'x' || raw === 'X') {
    return { major: null, minor: null, patch: null, pre: [] }
  }
  const dash = raw.indexOf('-')
  const core = dash < 0 ? raw : raw.slice(0, dash)
  const preText = dash < 0 ? '' : raw.slice(dash + 1)
  const parts = core.split('.')
  const num = (s) => {
    if (s === undefined || s === '' || s === 'x' || s === 'X' || s === '*') return null
    return NUM.test(s) ? Number(s) : Number.NaN
  }
  const major = num(parts[0])
  const minor = parts.length > 1 ? num(parts[1]) : null
  const patch = parts.length > 2 ? num(parts[2]) : null
  if ([major, minor, patch].some((v) => Number.isNaN(v))) return null
  return { major, minor, patch, pre: preText ? preText.split('.') : [] }
}

const v = (major, minor, patch, pre = []) => ({ major, minor, patch, pre })
/** 上界用的「该版本线的零点」：`-0` 预发布，用来排除整条版本线的预发布。 */
const zeroOf = (major, minor, patch) => v(major, minor, patch, ['0'])

/** 把一个 comparator 展开成 {@link {op, ver}} 列表（不含纯通配）。 */
function expandToken(token) {
  const m = String(token).match(/^(>=|<=|>|<|=|\^|~)?\s*(.+)$/)
  if (!m) return []
  const op = m[1] || '='
  const p = parsePartial(m[2])
  if (!p) return []
  const { major, minor, patch } = p

  if (major === null) return [] // `*` / `x`：任意

  const lower = (ver) => ({ op: '>=', ver })
  const upper = (ver) => ({ op: '<', ver })

  if (op === '^') {
    const base = v(major, minor ?? 0, patch ?? 0, p.pre)
    let upto
    if (major > 0) upto = zeroOf(major + 1, 0, 0)
    else if (minor !== null && minor > 0) upto = zeroOf(0, minor + 1, 0)
    else if (minor !== null) upto = zeroOf(0, 0, (patch ?? 0) + 1)
    else upto = zeroOf(1, 0, 0)
    return [lower(base), upper(upto)]
  }

  if (op === '~') {
    const base = v(major, minor ?? 0, patch ?? 0, p.pre)
    const upto = minor !== null ? zeroOf(major, minor + 1, 0) : zeroOf(major + 1, 0, 0)
    return [lower(base), upper(upto)]
  }

  const minorWild = minor === null
  const patchWild = patch === null
  const isWild = minorWild || patchWild

  // 带通配的偏序比较（x-range 语义）
  if (isWild) {
    const lowest = v(major, minor ?? 0, 0) // 该版本线的最低正式版
    if (op === '>') {
      // >1.2.x → >=1.3.0-0
      const bump = minorWild ? zeroOf(major + 1, 0, 0) : zeroOf(major, minor + 1, 0)
      return [lower(bump)]
    }
    if (op === '<=') {
      // <=1.2.x → <1.3.0-0
      const bump = minorWild ? zeroOf(major + 1, 0, 0) : zeroOf(major, minor + 1, 0)
      return [upper(bump)]
    }
    if (op === '<') {
      // <1.2.x → <1.2.0-0
      return [upper(minorWild ? zeroOf(major, 0, 0) : zeroOf(major, minor, 0))]
    }
    if (op === '>=') {
      // >=1.2.x → >=1.2.0
      return [lower(lowest)]
    }
    // `=1.2.x` / `1.2.x` → [1.2.0, 1.3.0-0)
    const bump = minorWild ? zeroOf(major + 1, 0, 0) : zeroOf(major, minor + 1, 0)
    return [lower(lowest), upper(bump)]
  }

  const ver = v(major, minor, patch, p.pre)
  return [{ op, ver }]
}

/** 解析一个 comparator set（空格分隔，或 hyphen range）。 */
function parseSet(setText) {
  const text = setText.trim()
  if (text === '' || text === '*' || text === 'x') return []

  // hyphen range：`1.2.3 - 2.3.4`
  const hy = text.match(/^(\S+)\s+-\s+(\S+)$/)
  if (hy) {
    const a = parsePartial(hy[1])
    const b = parsePartial(hy[2])
    if (!a || !b) return []
    const out = [{ op: '>=', ver: v(a.major, a.minor ?? 0, a.patch ?? 0, a.pre) }]
    if (b.minor === null) out.push({ op: '<', ver: zeroOf(b.major + 1, 0, 0) })
    else if (b.patch === null) out.push({ op: '<', ver: zeroOf(b.major, b.minor + 1, 0) })
    else out.push({ op: '<=', ver: v(b.major, b.minor, b.patch, b.pre) })
    return out
  }

  const out = []
  for (const token of text.split(/\s+/).filter(Boolean)) out.push(...expandToken(token))
  return out
}

/** 解析完整 range（`||` 连接）。 */
export function parseRange(range) {
  return String(range)
    .split('||')
    .map((part) => parseSet(part))
}

function testComparator(version, comparator) {
  const c = compareVersions(version, comparator.ver)
  switch (comparator.op) {
    case '=':
      return c === 0
    case '>':
      return c > 0
    case '>=':
      return c >= 0
    case '<':
      return c < 0
    case '<=':
      return c <= 0
    default:
      return false
  }
}

/**
 * 版本是否满足范围（includePrerelease 语义）。
 * @param {string} version 例如 `0.2.1-rc.5`
 * @param {string} range 例如 `>=0.2.0-rc.2 <0.3.0`
 */
export function satisfies(version, range) {
  const ver = parseVersion(version)
  if (!ver) return false
  const sets = parseRange(range)
  if (sets.length === 0) return false
  return sets.some((set) => set.every((comparator) => testComparator(ver, comparator)))
}
