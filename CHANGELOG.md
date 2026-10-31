# CHANGELOG

## 0.1.0（未发布）

- **P0 骨架**：插件可被 DSH 加载；注册 `find_dsh_plugin` 与 `check_plugin_compat`；离线冒烟测试（`npm test`）。
- **P2 兼容性体检（可用）**：`check_plugin_compat` 接上真实现。
  - 取 manifest：**多路线并行竞速**（npmmirror / npmjs / esm.sh / unpkg / gh-proxy+raw / GitHub contents / 以及需代理的 raw·jsDelivr·statically·ghproxy.net），谁先回用谁，失败静默只记 `attempts`。
  - 判定：`engines.dsh` 存在时只看它（peer 被忽略）；否则逐个校验 `@deepseek-ai/dsh*` peer；两样都没有 → `none`。预发布参与匹配。
  - 内联 semver（`lib/semver.js`）与官方 `semver@7` **330/330 逐条对照**，完全一致（含 `-0` 上界语义）。
- **P1 搜索（可用）**：`find_dsh_plugin` 多路线并行（GitHub search / npmmirror search / npmjs search / GitHub topics HTML / awesome plugins.json），**边完成边合并**、总预算 6s，返回可直接粘贴的安装命令。
- **P3 搜索+体检联动**：`find_dsh_plugin(check: true)` 对前 3 条顺带体检。
- **P4 多源降级**：每条路线独立超时、失败静默；需代理的路线保留实现但排在后面（验证状态见仓库外《待加速器验证-路线清单.md》）。
- **runtime 版本自动探测**：Electron `require('app.asar/package.json')` → 手读 asar → profile → 环境变量；全失败时要求显式传 `runtime`，**绝不猜**。

### 修掉的两个真机 bug（2026-10-31）

1. **`value is not lossless JSON`**：`find_dsh_plugin` 首次真机调用就崩。排查结论不是"孤立代理项"（扫描为 0），而是返回值里的 **`undefined` 字段**——`JSON.stringify` 会丢弃它，往返后字段消失，DSH 判定不无损。修法：出口统一 `wellFormedDeep`（修代理项 **且剔除 undefined**）。
2. **GitHub topics 返回 406**：给 HTML 页面发了 `accept: application/json`。修法：该路线单独用 `accept: text/html`。

### 已知待优化

（P5 已处理，见下）

### P5 打磨（2026-10-31）

- **搜索从 11.8s → 0.38s（38 倍）**。根因：**宿主进程里并发多个 HTTPS 请求会集体超时**（8s 都没回），而同一个 URL 单独请求只要 300–900ms。
  改法：**串行 + 短路** —— 一个接一个试，结果够多就不再打后续源。搜索默认只走 npmmirror 一个源（实测 138ms）。
- **体检同样串行**（按优先级一个个试，第一个成功即返回），单次约 243ms。
- 输出新增 `summary` 字段（人能直接读的清单），`partial` 标明是否有源未返回。
- 默认**不跑需要代理的路线**（`BEST_FIT_NEEDS_PROXY=1` 才启用），避免无代理环境白等 8 秒；多源覆盖用 `BEST_FIT_ALL_SOURCES=1`。
- 新增 `docs/DEVELOPMENT.md`（架构、实测数据、6 个坑）。
- 离线测试 **41 条**（新增目标解析 / 路线构造 / 身份校验 / well-formed）。

### P7 输入框浮窗（2026-10-31）

- **配置不再只能靠环境变量**：客户端半把一个小按钮挂到 `conversation.input.overlay` ——
  这个槽位的语义是"渲染在输入框卡片**内部**的浮层"，宽度天然等于输入框，正是"大小跟随输入框的弹出窗口"。
- 可配置项：GitHub Token（存 `<DSH_HOME>/best-fit/credential.json`，**0o600**、只回显后 4 位）、
  搜索源开关、需代理路线、默认条数、体检条数、自动体检、诊断信息。
- Host 侧新增 `GET/POST /best-fit/config.json`：**同一 path 只能注册一次**，故按 method 在单个 handler 里分发；
  来源校验只放行 loopback（非回环 `Origin` 一律 403，实测通过）。
- ⚠️ 客户端半需要**重启 DSH + F5** 才进组合。

### 实测记录（2026-10-31，本机宿主网络）

| 端点 | 结果 |
| --- | --- |
| `raw.githubusercontent.com` | 稳定不通（ECONNRESET ×3）→ 不用 |
| `cdn.jsdelivr.net` | 不通（ECONNRESET）→ 不用 |
| `registry.npmmirror.com` | 46–371ms，但**不一定有某个包** |
| `registry.npmjs.org` | 有全部包但慢（2.5–5.3s）→ 与镜像并行竞速 |
| `api.github.com` | 间歇（首轮可能 8s 超时）→ 超时 8s + 重试 2 次 |
