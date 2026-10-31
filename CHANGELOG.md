# CHANGELOG

## 0.1.0（未发布）

- **P0 骨架**：插件可被 DSH 加载；注册 `find_dsh_plugin` 与 `check_plugin_compat` 两个工具；附带离线冒烟测试（`npm test`）。
- **P2 兼容性体检（可用）**：`check_plugin_compat` 接上真实现。
  - 取 manifest：npm 双源**并行竞速**（npmmirror / npmjs）；GitHub 走 contents API（base64），失败时按 repo 名降级到 npm 并**校验 `repository` 字段确实指向该 owner/repo**（防同名包冒认）。
  - 判定：`engines.dsh` 存在时只看它（peer 被忽略）；否则逐个校验 `@deepseek-ai/dsh*` peer；两样都没有 → `none`。预发布参与匹配。
  - 内联 semver（`lib/semver.js`）与官方 `semver@7` 做 **330/330 逐条对照**，完全一致（含 `-0` 上界语义）。
- **runtime 版本自动探测**：Electron `require('app.asar/package.json')` → 手读 asar → profile → 环境变量；全失败时要求显式传 `runtime`，**绝不猜**。
- 移除多余的 `@deepseek-ai/cordis` peer 声明（本插件零依赖，不 import 它）。

### 实测记录（2026-10-31，本机宿主网络）

| 端点 | 结果 |
| --- | --- |
| `raw.githubusercontent.com` | 稳定不通（ECONNRESET ×3）→ 不用 |
| `cdn.jsdelivr.net` | 不通（ECONNRESET）→ 不用 |
| `registry.npmmirror.com` | 46–371ms，但**不一定有某个包** |
| `registry.npmjs.org` | 有全部包但慢（2.5–5.3s）→ 与镜像并行竞速 |
| `api.github.com` | 间歇（首轮可能 8s 超时）→ 超时 8s + 重试 2 次 |
