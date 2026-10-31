/**
 * 诊断脚本：扫一遍搜索结果的字符串，找出会让 DSH 工具层报
 * `value is not lossless JSON` 的孤立代理项，并验证 wellFormedDeep 是否真能修干净。
 *
 * 用法：node tools/scan-dirty.mjs [关键词]
 */

import { searchPlugins } from '../lib/registry.js'
import { wellFormedDeep } from '../lib/sanitize.js'

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

const scan = (value, path = '$', hits = []) => {
  if (typeof value === 'string') {
    if (LONE.test(value)) hits.push({ path, sample: JSON.stringify(value).slice(0, 90) })
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => scan(item, `${path}[${index}]`, hits))
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) scan(item, `${path}.${key}`, hits)
  }
  return hits
}

const query = process.argv[2] ?? '终端 TUI'
const res = await searchPlugins(query, { limit: 5 })
console.log(
  `ok=${res.ok} 条目=${res.results.length} 来源=${res.sources.map((s) => `${s.route}${s.ok ? '✅' : '❌'}`).join(',')}`,
)

const hits = scan(res)
console.log(`孤立代理项命中 = ${hits.length}`)
for (const hit of hits.slice(0, 10)) console.log(`   ${hit.path} → ${hit.sample}`)

const fixed = wellFormedDeep(res)
const before = JSON.stringify(res)
const after = JSON.stringify(fixed)
console.log(`JSON 长度：原始 ${before.length} → 修后 ${after.length}；修后仍含孤立代理项 = ${LONE.test(after)}`)
try {
  JSON.parse(after)
  console.log('修后 JSON 可解析 = true')
} catch (error) {
  console.log(`修后 JSON 解析失败：${error.message}`)
}
