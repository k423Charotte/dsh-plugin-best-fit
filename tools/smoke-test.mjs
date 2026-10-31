/**
 * 离线冒烟测试：不需要 DSH 在跑，不碰网络。
 * 验证：模块能加载 / 导出正确 / 工具注册成功 / 被调用时如实返回骨架状态。
 */

import assert from 'node:assert/strict'

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

const asynccheck = async (label, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (err) {
    failed += 1
    console.log(`  ✗ ${label}\n      ${String(err?.message || err).split('\n')[0]}`)
  }
}

console.log('\n[1] 模块导出')
const mod = await import('../lib/index.js')
check('name 正确', () => assert.equal(mod.name, 'dsh-plugin-best-fit'))
check('导出 apply 函数', () => assert.equal(typeof mod.apply, 'function'))
check('导出 version 字符串', () => assert.equal(typeof mod.version, 'string'))

console.log('\n[2] 注册行为')
const registered = []
const tools = { register: (t) => registered.push(t) }
const ctx = { get: (k) => (k === 'tools' ? tools : undefined) }
mod.apply(ctx)
check('注册了两个工具', () => assert.equal(registered.length, 2))
check(
  '工具名正确',
  () => assert.deepEqual(registered.map((t) => t.name).sort(), ['check_plugin_compat', 'find_dsh_plugin']),
)
check(
  '每个工具都有 description / parameters / execute',
  () =>
    registered.forEach((t) => {
      assert.ok(t.description && t.description.length > 20, `${t.name} 缺 description`)
      assert.equal(t.parameters?.type, 'object', `${t.name} parameters 必须是 object`)
      assert.equal(typeof t.execute, 'function', `${t.name} 缺 execute`)
    }),
)
check(
  'find_dsh_plugin 的 query 是必填',
  () => {
    const t = registered.find((x) => x.name === 'find_dsh_plugin')
    assert.deepEqual(t.parameters.required, ['query'])
  },
)
check(
  'check_plugin_compat 的 target 是必填',
  () => {
    const t = registered.find((x) => x.name === 'check_plugin_compat')
    assert.deepEqual(t.parameters.required, ['target'])
  },
)

console.log('\n[3] 没有 tools 服务时不崩')
const emptyCtx = { get: () => undefined }
check('apply 静默返回', () => {
  assert.doesNotThrow(() => mod.apply(emptyCtx))
})

console.log('\n[4] P0 骨架的返回值')
await asynccheck('find_dsh_plugin 返回 skeleton', async () => {
  const t = registered.find((x) => x.name === 'find_dsh_plugin')
  const r = await t.execute({ query: '终端 TUI' })
  assert.equal(r.status, 'skeleton')
  assert.equal(r.plugin, 'dsh-plugin-best-fit')
  assert.ok(r.message.includes('尚未实现'))
})
await asynccheck('check_plugin_compat 返回 skeleton', async () => {
  const t = registered.find((x) => x.name === 'check_plugin_compat')
  const r = await t.execute({ target: 'k423Charotte/bili-duty' })
  assert.equal(r.status, 'skeleton')
  assert.ok(r.message.length > 0)
})
await asynccheck('output.render 能产出文本块', async () => {
  const t = registered[0]
  const blocks = t.output.render({}, { status: 'skeleton', n: 1 })
  assert.equal(Array.isArray(blocks), true)
  assert.equal(blocks[0].type, 'text')
  assert.ok(blocks[0].text.includes('skeleton'))
})

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
