/**
 * dsh-plugin-best-fit —— Client 半（输入框上的配置浮窗）
 * ============================================================================
 * 形态：静态客户端模块，按 `window.__ModuleLoader__.load` 约定注册惰性 factory，
 * 把一个小按钮 + 配置面板挂到 `conversation.input.overlay`（输入框卡片**内部**的浮层）。
 *
 * 为什么用这个槽位：它的语义就是 "Floating entries rendered inside the resident composer card"，
 * 宽度天然等于输入框卡片 —— 正好是"大小跟随输入框的弹出窗口"。
 *
 * 约束（都是实测踩过的）：
 *  - 不 import 任何 `@deepseek-ai/*`，只用 `require('react')`；
 *  - factory 体里任何 throw 都会让 entry failed，而 web boot 把 failed 当**致命** → 全包 try/catch；
 *  - 与 Host 通信只走插件自己的路由 `/best-fit/config.json`；
 *  - 样式只用主题 token（`--dsw-alias-*`），浅色/深色自动跟随。
 * ============================================================================
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-best-fit',
  factory(require) {
    try {
      const React = require('react')
      const h = React.createElement
      const { useState, useEffect, useCallback } = React

      const CSS = [
        '.bf-root{position:absolute;inset-inline:0;bottom:calc(100% + 6px);z-index:30;display:flex;flex-direction:column;align-items:stretch;gap:6px;pointer-events:none;}',
        '.bf-root>*{pointer-events:auto;}',
        '.bf-trigger{align-self:flex-start;display:inline-flex;align-items:center;gap:6px;padding:4px 10px;font-size:12px;line-height:1.4;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:pointer;}',
        '.bf-trigger:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
        '.bf-trigger[data-open="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
        '.bf-panel{width:100%;box-sizing:border-box;max-height:min(60vh,420px);overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 8px 28px rgba(0,0,0,.18);padding:10px 12px;font-size:12px;line-height:1.5;}',
        '.bf-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;}',
        '.bf-title{font-size:13px;font-weight:600;}',
        '.bf-sub{color:var(--dsw-alias-label-secondary);font-size:11px;}',
        '.bf-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:5px 0;}',
        '.bf-row-label{flex:1 1 auto;min-width:0;}',
        '.bf-hint{color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:1px;}',
        '.bf-input{width:100%;box-sizing:border-box;padding:4px 8px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;outline:none;}',
        '.bf-input:focus{border-color:var(--dsw-alias-brand-primary);}',
        '.bf-num{width:64px;}',
        '.bf-switch{position:relative;display:inline-flex;align-items:center;width:32px;height:18px;flex:0 0 auto;border-radius:999px;border:0;background:var(--dsw-alias-border-l2);cursor:pointer;padding:2px;}',
        '.bf-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);}',
        '.bf-knob{display:block;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .12s ease;}',
        '.bf-switch[aria-checked="true"] .bf-knob{transform:translateX(14px);}',
        '.bf-chips{display:flex;flex-wrap:wrap;gap:4px;}',
        '.bf-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);font-size:11px;cursor:pointer;user-select:none;}',
        '.bf-chip[data-on="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
        '.bf-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:4px 10px;font:inherit;font-size:12px;border-radius:7px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
        '.bf-btn:disabled{opacity:.5;cursor:not-allowed;}',
        '.bf-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-weight:600;}',
        '.bf-actions{display:flex;align-items:center;gap:6px;margin-top:8px;}',
        '.bf-status{font-size:11px;color:var(--dsw-alias-label-secondary);}',
        '.bf-status[data-kind="ok"]{color:var(--dsw-alias-state-success-primary);}',
        '.bf-status[data-kind="err"]{color:var(--dsw-alias-state-error-primary);}',
        '.bf-mono{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:11px;word-break:break-all;}',
        '.bf-sep{height:1px;background:var(--dsw-alias-border-l1);margin:6px 0;}',
      ].join('')

      const SOURCE_OPTIONS = [
        { id: 'npmmirror-search', label: 'npm 镜像' },
        { id: 'github-search', label: 'GitHub 搜索' },
        { id: 'npmjs-search', label: 'npm 官方' },
        { id: 'github-topics', label: 'topics 页' },
        { id: 'awesome-json', label: 'awesome（需代理）' },
      ]

      const api = async (init) => {
        const res = await fetch('/best-fit/config.json', {
          cache: 'no-store',
          ...init,
          headers: { 'content-type': 'application/json', ...(init && init.headers) },
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`)
        return body.config
      }

      function Switch(props) {
        return h(
          'button',
          {
            type: 'button',
            className: 'bf-switch',
            role: 'switch',
            'aria-checked': props.value === true,
            disabled: props.disabled === true,
            onClick: () => props.onChange(!props.value),
          },
          h('span', { className: 'bf-knob' }),
        )
      }

      function Row(props) {
        return h(
          'div',
          { className: 'bf-row' },
          h(
            'div',
            { className: 'bf-row-label' },
            h('div', null, props.label),
            props.hint ? h('div', { className: 'bf-hint' }, props.hint) : null,
          ),
          h('div', null, props.children),
        )
      }

      function Panel() {
        const [open, setOpen] = useState(false)
        const [config, setConfig] = useState(null)
        const [tokenInput, setTokenInput] = useState('')
        const [busy, setBusy] = useState(false)
        const [status, setStatus] = useState(null)

        const load = useCallback(async () => {
          try {
            setConfig(await api({ method: 'GET' }))
            setStatus(null)
          } catch (error) {
            setStatus({ kind: 'err', text: `读取配置失败：${String(error.message || error)}` })
          }
        }, [])

        useEffect(() => {
          if (open && config === null) load()
        }, [open, config, load])

        const save = useCallback(
          async (patch) => {
            setBusy(true)
            try {
              const next = await api({ method: 'POST', body: JSON.stringify(patch) })
              setConfig(next)
              setStatus({ kind: 'ok', text: '已保存' })
              window.setTimeout(() => setStatus(null), 1600)
            } catch (error) {
              setStatus({ kind: 'err', text: `保存失败：${String(error.message || error)}` })
            } finally {
              setBusy(false)
            }
          },
          [],
        )

        const toggleSource = (id) => {
          const current = Array.isArray(config?.sources) ? config.sources : []
          const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
          save({ sources: next })
        }

        return h(
          'div',
          { className: 'bf-root' },
          h('style', null, CSS),
          h(
            'button',
            {
              type: 'button',
              className: 'bf-trigger',
              'data-open': open ? 'true' : 'false',
              onClick: () => setOpen((value) => !value),
              title: '寻找最合适的插件 · 设置',
            },
            open ? '▾ 找插件设置' : '▸ 找插件',
          ),
          open
            ? h(
                'div',
                { className: 'bf-panel' },
                h(
                  'div',
                  { className: 'bf-head' },
                  h(
                    'div',
                    null,
                    h('div', { className: 'bf-title' }, '寻找最合适的插件'),
                    h('div', { className: 'bf-sub' }, '这些设置只影响本插件的工具行为'),
                  ),
                  h('button', { type: 'button', className: 'bf-btn', onClick: () => setOpen(false) }, '收起'),
                ),

                config === null
                  ? h('div', { className: 'bf-status' }, '读取中…')
                  : h(
                      'div',
                      null,
                      // ── GitHub Token ──
                      h(
                        Row,
                        {
                          label: 'GitHub Token',
                          hint: config.hasToken ? `已配置 ${config.tokenHint}（留空不改）` : '匿名搜索 10 次/分，配了变 30 次/分',
                        },
                        h('input', {
                          className: 'bf-input',
                          type: 'password',
                          placeholder: config.hasToken ? '已配置' : 'ghp_…',
                          value: tokenInput,
                          onChange: (event) => setTokenInput(event.target.value),
                          onBlur: () => {
                            if (tokenInput !== '') {
                              save({ token: tokenInput })
                              setTokenInput('')
                            }
                          },
                        }),
                      ),

                      h('div', { className: 'bf-sep' }),

                      // ── 查询模式（差别在评分精度）──
                      h(
                        Row,
                        { label: '查询模式', hint: '两者的评分维度相同，差别只在「兼容性」一项是否真去体检' },
                        h(
                          'div',
                          { className: 'bf-chips' },
                          [
                            { id: 'fast', label: '快速（不体检）' },
                            { id: 'full', label: '全面（逐条体检）' },
                          ].map((option) =>
                            h(
                              'label',
                              {
                                key: option.id,
                                className: 'bf-chip',
                                'data-on': (config.mode || 'fast') === option.id ? 'true' : 'false',
                              },
                              h('input', {
                                type: 'checkbox',
                                style: { display: 'none' },
                                checked: (config.mode || 'fast') === option.id,
                                onChange: () => save({ mode: option.id }),
                              }),
                              option.label,
                            ),
                          ),
                        ),
                      ),

                      h('div', { className: 'bf-sep' }),

                      // ── 搜索源 ──
                      h(
                        Row,
                        { label: '搜索源', hint: '默认只开两个主源（快）；加更多覆盖更全但更慢' },
                        h(
                          'div',
                          { className: 'bf-chips' },
                          SOURCE_OPTIONS.map((option) =>
                            h(
                              'label',
                              {
                                key: option.id,
                                className: 'bf-chip',
                                'data-on': (config.sources || []).includes(option.id) ? 'true' : 'false',
                              },
                              h('input', {
                                type: 'checkbox',
                                style: { display: 'none' },
                                checked: (config.sources || []).includes(option.id),
                                onChange: () => toggleSource(option.id),
                              }),
                              option.label,
                            ),
                          ),
                        ),
                      ),

                      h(
                        Row,
                        { label: '需代理的路线', hint: '打开后才会试 raw / jsDelivr / ghproxy 等' },
                        h(Switch, {
                          value: config.needsProxyRoutes === true,
                          onChange: (value) => save({ needsProxyRoutes: value }),
                        }),
                      ),

                      h('div', { className: 'bf-sep' }),

                      h(
                        Row,
                        { label: '默认返回条数' },
                        h('input', {
                          className: 'bf-input bf-num',
                          type: 'number',
                          min: 1,
                          max: 20,
                          value: config.defaultLimit,
                          onChange: (event) => save({ defaultLimit: Number(event.target.value) }),
                        }),
                      ),
                      h(
                        Row,
                        { label: '搜索时自动体检', hint: '默认开 —— 筛选本来就该有成本' },
                        h(Switch, { value: config.autoCheck === true, onChange: (value) => save({ autoCheck: value }) }),
                      ),
                      h(
                        Row,
                        { label: '体检全部候选', hint: '关掉则只体检下面指定的前 N 条' },
                        h(Switch, { value: config.checkAll === true, onChange: (value) => save({ checkAll: value }) }),
                      ),
                      h(
                        Row,
                        { label: '仅当上面关掉时：体检前 N 条' },
                        h('input', {
                          className: 'bf-input bf-num',
                          type: 'number',
                          min: 0,
                          max: 20,
                          value: config.checkTopN,
                          onChange: (event) => save({ checkTopN: Number(event.target.value) }),
                        }),
                      ),
                      h(
                        Row,
                        { label: '显示诊断信息', hint: '每个源的成败与耗时' },
                        h(Switch, {
                          value: config.showDiagnostics === true,
                          onChange: (value) => save({ showDiagnostics: value }),
                        }),
                      ),

                      h(
                        'div',
                        { className: 'bf-actions' },
                        h('button', { type: 'button', className: 'bf-btn', onClick: load, disabled: busy }, '重新读取'),
                        status
                          ? h(
                              'span',
                              { className: 'bf-status', 'data-kind': status.kind },
                              status.text,
                            )
                          : h('span', { className: 'bf-status' }, busy ? '保存中…' : ''),
                      ),
                      h('div', { className: 'bf-sub bf-mono' }, config.paths ? config.paths.config : ''),
                    ),
              )
            : null,
        )
      }

      // ── 工具结果卡片（评分 + 详情展开）─────────────────────────────────
      const TV_CSS = [
        '.bftv-wrap{display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);}',
        '.bftv-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);}',
        '.bftv-badge{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);}',
        '.bftv-item{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);}',
        '.bftv-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;}',
        '.bftv-name{font-weight:600;word-break:break-all;}',
        '.bftv-desc{color:var(--dsw-alias-label-secondary);font-size:11px;}',
        '.bftv-score{flex:0 0 auto;font-weight:600;font-variant-numeric:tabular-nums;}',
        '.bftv-btn{flex:0 0 auto;padding:2px 8px;font:inherit;font-size:11px;border-radius:6px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}',
        '.bftv-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
        '.bftv-detail{flex-basis:100%;margin-top:4px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:11px;display:flex;flex-direction:column;gap:3px;}',
        '.bftv-row{display:flex;justify-content:space-between;gap:10px;}',
        '.bftv-lab{color:var(--dsw-alias-label-secondary);}',
        '.bftv-num{font-variant-numeric:tabular-nums;}',
        '.bftv-warn{color:var(--dsw-alias-state-warn-primary);}',
        '.bftv-cmd{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;}',
        '.bftv-empty{color:var(--dsw-alias-label-secondary);font-size:11px;}',
        '.bftv-raw{white-space:pre-wrap;word-break:break-word;font-size:11px;}',
      ].join('')

      const SCORE_LABELS = {
        compatibility: '兼容性',
        activity: '活跃度',
        popularity: '人气',
        health: '维护健康',
        risk: '风险',
      }

      /** 从工具结果块里读出我们的 JSON（字段名做了兜底，不同版本的块形状可能不同）。 */
      function readToolPayload(block) {
        try {
          const content = block && (block.content || (block.result && block.result.content))
          if (Array.isArray(content)) {
            const textPart = content.find((part) => part && part.type === 'text' && typeof part.text === 'string')
            if (textPart) return JSON.parse(textPart.text)
          }
          if (block && typeof block.output === 'string') return JSON.parse(block.output)
        } catch (error) {
          return null
        }
        return null
      }

      /** 评分明细（点「详情」展开）。 */
      function ScoreDetail(props) {
        const item = props.item || {}
        const parts = item.scoreParts || {}
        const rows = Object.keys(parts).map((key) =>
          h(
            'div',
            { className: 'bftv-row', key },
            h('span', { className: 'bftv-lab' }, SCORE_LABELS[key] || key),
            h('span', { className: 'bftv-num' }, `${parts[key]} 分`),
          ),
        )
        return h(
          'div',
          { className: 'bftv-detail' },
          rows,
          h(
            'div',
            { className: 'bftv-row' },
            h('span', { className: 'bftv-lab' }, '兼容结论'),
            h('span', null, item.compatStatus || '未验证（按 15 分估）'),
          ),
          ...(item.checklist || []).map((text, index) =>
            h('div', { className: 'bftv-empty', key: `c${index}` }, `· ${text}`),
          ),
          ...(item.caveats || []).map((text, index) =>
            h('div', { className: 'bftv-warn', key: `w${index}` }, `⚠ ${text}`),
          ),
          h('div', { className: 'bftv-cmd' }, item.install || ''),
        )
      }

      /** 工具结果卡片主体。 */
      function BestFitToolView(props) {
        const [openKey, setOpenKey] = useState(null)
        let payload = null
        try {
          payload = readToolPayload(props && props.block)
        } catch (error) {
          payload = null
        }

        // 认不出我们的结果 → 把原文渲染出来（绝不让卡片变空白）
        if (!payload || typeof payload !== 'object' || !Array.isArray(payload.results)) {
          let raw = ''
          try {
            const content = props.block && (props.block.content || (props.block.result && props.block.result.content))
            raw = Array.isArray(content)
              ? content.map((part) => (part && part.text) || '').join('\n')
              : ''
          } catch (error) {
            raw = ''
          }
          return raw === ''
            ? null
            : h('div', { className: 'bftv-wrap' }, h('style', null, TV_CSS), h('div', { className: 'bftv-raw' }, raw))
        }

        const items = payload.results
        const head = `${payload.query || ''} · ${payload.mode === 'full' ? '全面' : '快速'}模式 · ${items.length} 条 · ${payload.ms || 0}ms`
        const coverage =
          payload.checkedCount > 0
            ? payload.checkedCount >= items.length
              ? '全部已体检'
              : `已体检 ${payload.checkedCount}/${items.length} 条`
            : '未体检'

        return h(
          'div',
          { className: 'bftv-wrap' },
          h('style', null, TV_CSS),
          h('div', { className: 'bftv-head' }, h('span', null, head), h('span', { className: 'bftv-badge' }, coverage)),
          items.map((item, index) => {
            const key = `${index}:${item.name}`
            const open = openKey === key
            return h(
              'div',
              { className: 'bftv-item', key },
              h(
                'div',
                { className: 'bftv-main' },
                h('div', { className: 'bftv-name' }, item.name),
                h('div', { className: 'bftv-desc' }, String(item.description || '').slice(0, 90)),
                h('div', { className: 'bftv-cmd' }, item.install || ''),
              ),
              h('div', { className: 'bftv-score' }, `${item.score === undefined ? '?' : item.score} 分`),
              h(
                'button',
                { type: 'button', className: 'bftv-btn', onClick: () => setOpenKey(open ? null : key) },
                open ? '收起' : '详情',
              ),
              open ? h(ScoreDetail, { item }) : null,
            )
          }),
        )
      }

      return {
        name: 'dsh-plugin-best-fit',
        inject: ['slots'],
        apply(ctx) {
          // 这里任何 throw 都会让 web boot failed、DSH 起不来 —— 全部吞掉。
          try {
            if (ctx && ctx.slots && typeof ctx.slots.inject === 'function') {
              ctx.slots.inject('conversation.input.overlay', () =>
                ctx.slots.register(
                  {
                    name: 'conversation.input.overlay',
                    id: 'best-fit-config',
                    order: 20,
                    label: '寻找最合适的插件',
                  },
                  Panel,
                ),
              )
              // 工具结果卡片：让 find_dsh_plugin 的调用结果显示评分 + 「详情」按钮
              ctx.slots.inject('tool.call.toolview', () =>
                ctx.slots.register({ name: 'tool.call.toolview', key: 'find_dsh_plugin' }, BestFitToolView),
              )
            }
          } catch (error) {
            /* 静默：客户端半加载失败不该影响宿主 */
          }
        },
      }
    } catch (error) {
      // 兜底：返回一个什么都不做的插件，保证 DSH 照常启动。
      return { name: 'dsh-plugin-best-fit', apply() {} }
    }
  },
})
