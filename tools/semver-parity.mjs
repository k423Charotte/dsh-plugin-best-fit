/**
 * 对照测试：把我们的内联 semver 与官方 `semver` 包逐条比对。
 * 官方包不在依赖里（开发期从临时目录引用），所以这个脚本**不进 `npm test`**。
 *
 * 用法：node tools/semver-parity.mjs <官方 semver 的绝对路径>
 *   例：node tools/semver-parity.mjs C:/Users/AA/AppData/Local/Temp/semver-ref/node_modules/semver
 */

import { createRequire } from 'node:module'
import { satisfies as mine } from '../lib/semver.js'

const require = createRequire(import.meta.url)
const refPath = process.argv[2]
if (!refPath) {
  console.log('用法：node tools/semver-parity.mjs <semver 包绝对路径>')
  process.exit(2)
}
let ref
try {
  ref = require(refPath)
} catch (err) {
  console.log('无法加载官方 semver：', String(err?.message || err))
  process.exit(2)
}

/** 版本样本：覆盖 DSH 的各条线（含预发布）。 */
const VERSIONS = [
  '0.1.0-rc.6',
  '0.1.7-alpha.1',
  '0.2.0-rc.1',
  '0.2.0-rc.2',
  '0.2.1-rc.3',
  '0.2.1-rc.5',
  '0.2.1-alpha.2',
  '0.2.0',
  '0.2.1',
  '0.3.0',
  '1.0.0',
  '0.0.1',
  '1.2.3',
  '1.3.0',
  '2.0.0',
]

/** 范围样本：真实插件里出现过的写法 + 常见边界。 */
const RANGES = [
  // DSH 生态里的真实写法
  '>=0.2.0-rc.2 <0.3.0',
  '>=0.2.1-0 <0.3.0',
  '>=0.2.0-0 <0.3.0',
  '>=0.2.0-rc.2',
  '^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.2 || ^0.1.3-alpha.2 || ^0.1.5-alpha.1 || ^0.1.6-alpha.1 || ^0.1.7-alpha.1',
  '^0.2.0-rc.2',
  '^0.2.1-rc.1',
  '~4.0.4',
  '^4.0.1',
  '*',
  '>=0.1.2-rc.1 <0.3.0',
  '>=0.2.1-0 <0.3.0 || >=0.2.0-0 <0.3.0',
  // 常见边界
  '1.x',
  '1.2.x',
  '1.2.3 - 2.3.4',
  '~1.2.3',
  '^1.2.3',
  '>1.2',
  '<=1.2',
  '>=1.2.3 <2.0.0',
  '0.2.1-rc.5',
  '^0.0.3',
]

let same = 0
const diffs = []
for (const range of RANGES) {
  for (const version of VERSIONS) {
    const expected = ref.satisfies(version, range, { includePrerelease: true })
    let actual
    try {
      actual = mine(version, range)
    } catch (err) {
      actual = `THROW: ${String(err?.message || err)}`
    }
    if (actual === expected) same += 1
    else diffs.push({ range, version, expected, actual })
  }
}

const total = RANGES.length * VERSIONS.length
console.log(`\n对照结果：${same}/${total} 一致，${diffs.length} 处不一致\n`)
if (diffs.length > 0) {
  console.log('不一致明细：')
  for (const d of diffs.slice(0, 40)) {
    console.log(`  range=${JSON.stringify(d.range)}  version=${d.version}  官方=${d.expected}  我们=${d.actual}`)
  }
  if (diffs.length > 40) console.log(`  …还有 ${diffs.length - 40} 条`)
  process.exit(1)
}
console.log('✅ 内联 semver 与官方实现完全一致')
