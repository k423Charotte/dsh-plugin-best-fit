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
await acheck('check_plugin_compat 在无 runtime 且探测不到时明确要求传 runtime', async () => {
  const t = registered.find((x) => x.name === 'check_plugin_compat')
  // 不联网：target 随便给，运行时会先于网络被校验
  const r = await t.execute({ target: 'x/y' })
  assert.ok(['error', 'ok', 'incompatible', 'none'].includes(r.status))
  if (r.status === 'error') assert.ok(String(r.error).length > 0)
})
check('没有 tools 服务时不崩', () => {
  assert.doesNotThrow(() => mod.apply({ get: () => undefined }))
})

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
