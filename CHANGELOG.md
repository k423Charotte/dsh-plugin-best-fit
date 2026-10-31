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

- 一次 `check: true` 调用实测约 **11.8s**（搜索 6s 预算 + 3 个体检）。后续可降预算到 4s、并让体检复用搜索结果里已拿到的 owner/repo（少走一轮竞速）。

### 实测记录（2026-10-31，本机宿主网络）

| 端点 | 结果 |
| --- | --- |
| `raw.githubusercontent.com` | 稳定不通（ECONNRESET ×3）→ 不用 |
| `cdn.jsdelivr.net` | 不通（ECONNRESET）→ 不用 |
| `registry.npmmirror.com` | 46–371ms，但**不一定有某个包** |
| `registry.npmjs.org` | 有全部包但慢（2.5–5.3s）→ 与镜像并行竞速 |
| `api.github.com` | 间歇（首轮可能 8s 超时）→ 超时 8s + 重试 2 次 |
