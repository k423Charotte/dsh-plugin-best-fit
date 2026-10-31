/**
 * 出口兜底：把任意返回值里的字符串修成 well-formed（消灭孤立代理项）。
 *
 * 为什么必须做：DSH 的工具层序列化用 `JSON.parse(JSON.stringify(x))` 之类的严格路径，
 * 遇到**落单的 UTF-16 代理项**（`\uD800`–`\uDBFF` 后面没有低代理，或反过来）会以
 * `value is not lossless JSON` **拒绝整个工具返回** —— 一个脏字符毁掉整次调用。
 * 而 GitHub/npm 的描述字段里确实会出现这种字符（2026-10-31 实测 `find_dsh_plugin` 首次真机调用就崩在这）。
 */

/** 单个字符串修成 well-formed（优先用原生 `toWellFormed`）。 */
export function toWellFormedText(input) {
  const text = String(input ?? '')
  if (typeof text.toWellFormed === 'function') return text.toWellFormed()
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1]
        i += 1
      } else {
        out += '\ufffd'
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += '\ufffd'
    } else {
      out += text[i]
    }
  }
  return out
}

/** 递归修整任意 JSON-ish 值（深度上限 12，防环）。 */
export function wellFormedDeep(value, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return value
  if (typeof value === 'string') return toWellFormedText(value)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value
  if (Array.isArray(value)) return value.map((item) => wellFormedDeep(item, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const fixed = wellFormedDeep(item, depth + 1)
      // ⚠️ 跳过 undefined：JSON.stringify 会丢弃它，往返后字段消失 ——
      // DSH 会把这判成 `value is not lossless JSON`（2026-10-31 实测：`checks: undefined` 就是元凶）。
      if (fixed !== undefined) out[key] = fixed
    }
    return out
  }
  return value
}
