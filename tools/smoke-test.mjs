/**
 * 离线冒烟测试：不需要 DSH 在跑，也不碰网络。
 * 覆盖：模块导出 / 工具注册 / semver 语义 / 三态判定 / 渲染。
 */

import assert from 'node:assert/strict'
import { evaluateCompat, formatVerdict } from '../lib/compat.js'
import { satisfies } from '../lib/semver.js'

let passed = 0
let failed = 0
const check = (label, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (err) {
    failed += 1
    console.log(`  ✗ ${label}\n      ${String(err?.message || err).split('\n')[0]}`)
  }
}
const acheck = async (label, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (err) {
    failed += 1
    console.log(`  ✗ ${label}\n      ${String(err?.message || err).split('\n')[0]}`)
  }
}

const RUNTIME = '0.2.1-rc.5'

console.log('\n[1] 模块导出')
const mod = await import('../lib/index.js')
check('name 正确', () => assert.equal(mod.name, 'dsh-plugin-best-fit'))
check('导出 apply', () => assert.equal(typeof mod.apply, 'function'))

console.log('\n[2] semver 关键语义（与官方实现对齐的样本）')
check('>=0.2.0-rc.2 覆盖 0.2.1-rc.5', () => assert.equal(satisfies('0.2.1-rc.5', '>=0.2.0-rc.2'), true))
check('>=0.2.0-0 <0.3.0 覆盖 0.2.1-rc.5', () => assert.equal(satisfies('0.2.1-rc.5', '>=0.2.0-0 <0.3.0'), true))
check('^0.1.0-rc.6 不覆盖 0.2.1-rc.5', () => assert.equal(satisfies('0.2.1-rc.5', '^0.1.0-rc.6'), false))
check('^0.1.0-rc.6 不覆盖 0.2.0-rc.1（-0 上界）', () => assert.equal(satisfies('0.2.0-rc.1', '^0.1.0-rc.6'), false))
check('^0.2.1-rc.1 覆盖 0.2.1-rc.5', () => assert.equal(satisfies('0.2.1-rc.5', '^0.2.1-rc.1'), true))
check('多段 || 的任意一段命中即可', () =>
  assert.equal(satisfies('0.2.1-rc.5', '^0.1.0-rc.6 || ^0.2.0-rc.2'), true))
check('0.3.0 不满足 <0.3.0', () => assert.equal(satisfies('0.3.0', '>=0.2.0-0 <0.3.0'), false))

console.log('\n[3] 三态判定（真实样本的 manifest 精简版）')
const cases = [
  {
    label: 'bili-duty 风格：engines.dsh >=0.2.0-rc.2 → ok',
    manifest: { name: 'bili-duty', version: '0.1.3', engines: { dsh: '>=0.2.0-rc.2', node: '>=22' } },
    expect: 'ok',
    fieldUsed: 'engines.dsh',
  },
  {
    label: 'find-plugin 风格：只有 peer @deepseek-ai/dsh-tools ^0.1.x → incompatible',
    manifest: {
      name: 'dsh-find-plugin',
      version: '0.4.0',
      peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.7-alpha.1' },
    },
    expect: 'incompatible',
    fieldUsed: 'peerDependencies',
  },
  {
    label: 'radar 风格：peer dsh-llm ^0.1.0-rc.6 → incompatible',
    manifest: { name: 'dsh-plugin-radar', version: '0.4.12', peerDependencies: { '@deepseek-ai/dsh-llm': '^0.1.0-rc.6' } },
    expect: 'incompatible',
    fieldUsed: 'peerDependencies',
  },
  {
    label: 'scout 风格：engines.dsh >=0.2.0-rc.2 <0.3.0 → ok',
    manifest: { name: 'dsh-plugin-scout', version: '0.1.11', engines: { dsh: '>=0.2.0-rc.2 <0.3.0' } },
    expect: 'ok',
    fieldUsed: 'engines.dsh',
  },
  {
    label: 'engines.dsh 存在时 peer 被忽略（peer 写死的旧范围不影响 ok）',
    manifest: {
      name: 'x',
      version: '1.0.0',
      engines: { dsh: '>=0.2.0-0 <0.3.0' },
      peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' },
    },
    expect: 'ok',
    fieldUsed: 'engines.dsh',
  },
  {
    label: '什么都没声明 → none',
    manifest: { name: 'y', version: '1.0.0' },
    expect: 'none',
    fieldUsed: null,
  },
  {
    label: 'peer 写 workspace:* → 视为当前 runtime（ok）',
    manifest: { name: 'z', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-tools': 'workspace:*' } },
    expect: 'ok',
    fieldUsed: 'peerDependencies',
  },
]
for (const c of cases) {
  check(c.label, () => {
    const r = evaluateCompat(c.manifest, RUNTIME)
    assert.equal(r.status, c.expect, `status 应为 ${c.expect}，实际 ${r.status}（${r.reason}）`)
    assert.equal(r.fieldUsed, c.fieldUsed)
  })
}

console.log('\n[4] 边界与渲染')
check('非法 runtime 报 error 而不是 ok', () => {
  assert.equal(evaluateCompat({ engines: { dsh: '*1' } }, 'not-a-version').status, 'error')
})
check('formatVerdict 带上 runtime 与判据', () => {
  const r = evaluateCompat({ name: 'bili-duty', version: '0.1.3', engines: { dsh: '>=0.2.0-rc.2' } }, RUNTIME)
  const text = formatVerdict(r, { manifest: { name: 'bili-duty', version: '0.1.3' } })
  assert.ok(text.includes('bili-duty@0.1.3'))
  assert.ok(text.includes(RUNTIME))
  assert.ok(text.includes('engines.dsh'))
})

console.log('\n[4.5] asar 读取（可选：由 BEST_FIT_TEST_ASAR 指定归档路径）')
const asarPathForTest = process.env.BEST_FIT_TEST_ASAR
if (asarPathForTest) {
  const { readAsarFile } = await import('../lib/asar.js')
  check('能从 asar 读出 package.json 并解析出版本', () => {
    const text = readAsarFile(asarPathForTest, 'package.json')
    assert.ok(typeof text === 'string' && text.length > 0, '读不到内容')
    const parsed = JSON.parse(text)
    assert.ok(typeof parsed.version === 'string' && parsed.version.length > 0, '没有 version 字段')
    console.log(`      版本 = ${parsed.version}`)
  })
  check('不存在的文件返回 null', () => {
    assert.equal(readAsarFile(asarPathForTest, 'no/such/file.json'), null)
  })
} else {
  console.log('  - 跳过（未设置 BEST_FIT_TEST_ASAR）')
}

console.log('\n[4.6] well-formed 兜底（真机踩过的坑）')
const { toWellFormedText, wellFormedDeep } = await import('../lib/sanitize.js')
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
check('孤立代理项被修复', () => {
  const dirty = 'a\uD800b'
  const fixed = toWellFormedText(dirty)
  assert.ok(!LONE_SURROGATE.test(fixed), '仍有孤立代理项')
  assert.ok(fixed.includes('a') && fixed.includes('b'))
})
check('合法代理对（emoji）被保留', () => {
  const pair = '\uD83D\uDC1F'
  assert.equal(toWellFormedText(pair), pair)
})
check('嵌套值被递归修整', () => {
  const fixed = wellFormedDeep({ a: ['x\uDC00y'], b: 1, c: null })
  assert.equal(typeof fixed.b, 'number')
  assert.equal(fixed.c, null)
  assert.ok(!LONE_SURROGATE.test(fixed.a[0]))
})
check('undefined 字段被剔除（JSON 往返不丢字段 → 才是 lossless）', () => {
  const fixed = wellFormedDeep({ a: 1, b: undefined, c: { d: undefined, e: 2 } })
  assert.equal('b' in fixed, false)
  assert.equal('d' in fixed.c, false)
  assert.equal(fixed.c.e, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(fixed)), fixed)
})

console.log('\n[4.7] 目标解析与路线构造')
const { parseTarget, repositoryMatches, manifestRoutes } = await import('../lib/source.js')
check('parseTarget: owner/repo → github', () => {
  const p = parseTarget('k423Charotte/bili-duty')
  assert.equal(p.kind, 'github')
  assert.equal(p.owner, 'k423Charotte')
  assert.equal(p.repo, 'bili-duty')
})
check('parseTarget: 包名 → npm（无版本）', () => {
  const p = parseTarget('bili-duty')
  assert.equal(p.kind, 'npm')
  assert.equal(p.name, 'bili-duty')
  assert.equal(p.version, null)
})
check('parseTarget: 包名@版本', () => {
  const p = parseTarget('bili-duty@0.1.3')
  assert.equal(p.kind, 'npm')
  assert.equal(p.name, 'bili-duty')
  assert.equal(p.version, '0.1.3')
})
check('parseTarget: @scope/包名 → npm（不带版本）', () => {
  const p = parseTarget('@liustack/modlens')
  assert.equal(p.kind, 'npm')
  assert.equal(p.name, '@liustack/modlens')
  assert.equal(p.version, null)
})
check('parseTarget: @scope/包名@版本', () => {
  const p = parseTarget('@liustack/modlens@3.27.1')
  assert.equal(p.kind, 'npm')
  assert.equal(p.name, '@liustack/modlens')
  assert.equal(p.version, '3.27.1')
})
check('parseTarget: 空 → null', () => assert.equal(parseTarget('   '), null))
check('repositoryMatches：命中同一 repo', () =>
  assert.equal(
    repositoryMatches({ repository: 'git+https://github.com/k423Charotte/bili-duty.git' }, 'k423Charotte', 'bili-duty'),
    true,
  ))
check('repositoryMatches：同名但不同 owner 必须拒绝', () =>
  assert.equal(
    repositoryMatches({ repository: 'git+https://github.com/someone-else/bili-duty.git' }, 'k423Charotte', 'bili-duty'),
    false,
  ))
check('manifestRoutes：npm 目标默认不含 needsProxy 路线', () => {
  const routes = manifestRoutes(parseTarget('bili-duty@0.1.3'), { includeNeedsProxy: false })
  assert.ok(routes.length > 0)
  assert.equal(routes.some((r) => r.needsProxy), false)
})
check('manifestRoutes：github 目标默认不含 needsProxy 路线', () => {
  const routes = manifestRoutes(parseTarget('k423Charotte/bili-duty'), { includeNeedsProxy: false })
  assert.ok(routes.length > 0)
  assert.equal(routes.some((r) => r.needsProxy), false)
})
check('manifestRoutes：includeNeedsProxy=true 时包含 needsProxy 路线', () => {
  const routes = manifestRoutes(parseTarget('k423Charotte/bili-duty'), { includeNeedsProxy: true })
  assert.equal(routes.some((r) => r.needsProxy), true)
})
check('manifestRoutes：GitHub 降级路线带身份校验', () => {
  const routes = manifestRoutes(parseTarget('k423Charotte/bili-duty'), { includeNeedsProxy: false })
  const fallback = routes.filter((r) => r.requireRepository)
  assert.ok(fallback.length > 0, '应至少有一条 npm 降级路线需要校验 repository 归属')
})
console.log('\n[4.9] 评分（可解释、可复算）')
const { scoreCandidate, scoreActivity, scorePopularity, scoreHealth, scoreRisk, scoreCompatibility, WEIGHTS } =
  await import('../lib/score.js')
const NOW = Date.parse('2026-10-31T00:00:00Z')

check('活跃度：7 天内 25 分', () => assert.equal(scoreActivity('2026-10-28T00:00:00Z', NOW).score, 25))
check('活跃度：半年以上 0 分且带提醒', () => {
  const r = scoreActivity('2026-01-01T00:00:00Z', NOW)
  assert.equal(r.score, 0)
  assert.ok(r.caveat)
})
check('人气：★100 ≈ 10 分', () => assert.equal(scorePopularity({ stars: 100 }).score, 10))
check('人气：★1000 ≈ 15 分', () => assert.equal(scorePopularity({ stars: 1000 }).score, 15))
check('健康：归档 = 0 且提示停止维护', () => {
  const r = scoreHealth({ archived: true })
  assert.equal(r.score, 0)
  assert.ok(r.caveat.includes('停止维护'))
})
check('风险：安装期脚本扣满 5 分并提醒', () => {
  const r = scoreRisk({ hasInstallScript: true })
  assert.equal(r.score, 0)
  assert.ok(r.caveats.some((text) => text.includes('安装期脚本')))
})
check('兼容：ok=40 / none=20 / incompatible=0', () => {
  assert.equal(scoreCompatibility({ status: 'ok', fieldUsed: 'engines.dsh', requirements: {} }).score, 40)
  assert.equal(scoreCompatibility({ status: 'none' }).score, 20)
  assert.equal(scoreCompatibility({ status: 'incompatible', fieldUsed: 'peerDependencies' }).score, 0)
})
check('总分 = 分项之和，且落在 0–100', () => {
  const r = scoreCandidate(
    { stars: 1000, pushedAt: '2026-10-30T00:00:00Z', openIssues: 5, archived: false },
    { compat: { status: 'ok' } },
  )
  const sum = Object.values(r.scoreParts).reduce((a, b) => a + b, 0)
  assert.equal(r.score, sum)
  assert.ok(r.score <= 100 && r.score >= 0)
  assert.ok(Array.isArray(r.checklist) && r.checklist.length >= 4)
})
check('不兼容的候选应明显低于兼容的（至少差 20 分）', () => {
  const base = { stars: 500, pushedAt: '2026-10-30T00:00:00Z', openIssues: 5 }
  const ok = scoreCandidate(base, { compat: { status: 'ok' } }).score
  const bad = scoreCandidate(base, { compat: { status: 'incompatible' } }).score
  assert.ok(ok - bad >= 20, `兼容 ${ok} 与不兼容 ${bad} 差距不足`)
})
check('权重总和 = 100', () => {
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0)
  assert.equal(total, 100)
})

console.log('\n[5] 工具注册与调用')
const registered = []
const tools = { register: (t) => registered.push(t) }
const ctx = { get: (k) => (k === 'tools' ? tools : undefined) }
mod.apply(ctx)
check('注册两个工具', () => assert.equal(registered.length, 2))
await acheck('check_plugin_compat 在空 target 时返回 error', async () => {
  const t = registered.find((x) => x.name === 'check_plugin_compat')
  const r = await t.execute({ target: '  ' })
  assert.equal(r.status, 'error')
})
await acheck('check_plugin_compat 在 runtime 非法时**不联网**直接报错', async () => {
  const t = registered.find((x) => x.name === 'check_plugin_compat')
  const startedAt = Date.now()
  const r = await t.execute({ target: 'not-a-real-package-xyz', runtime: 'not-a-version' })
  assert.equal(r.status, 'error')
  assert.ok(String(r.error).includes('runtime'), `error 应指向 runtime，实际：${r.error}`)
  assert.ok(Date.now() - startedAt < 500, '非法 runtime 不该走网络（应 < 500ms）')
})
await acheck('find_dsh_plugin 在 query 为空时返回 error', async () => {
  const t = registered.find((x) => x.name === 'find_dsh_plugin')
  const r = await t.execute({ query: '   ' })
  assert.equal(r.status, 'error')
})
check('没有 tools 服务时不崩', () => {
  assert.doesNotThrow(() => mod.apply({ get: () => undefined }))
})

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
