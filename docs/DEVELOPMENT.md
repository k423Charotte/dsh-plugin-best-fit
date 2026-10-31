# DEVELOPMENT.md · dsh-plugin-best-fit

给"下一个接手的人（或下一个我）"看的实现说明。**只看这份 + `PLAN.md` 就能接着做。**

## 一、文件职责

```
lib/
├─ index.js     入口：注册两个工具、组装输出、出口统一 wellFormedDeep
├─ source.js    取 manifest：多路线竞速（npm 系 / GitHub 系 / raw 代理）
├─ registry.js  搜索插件：多路线竞速 + 边完成边合并 + 总预算
├─ compat.js    三态判定（ok / incompatible / none）+ 中文 verdict 渲染
├─ semver.js    内联最小 semver（含 includePrerelease 与 `-0` 上界语义）
├─ runtime.js   探测当前 DSH 版本（asar → profile → env）
├─ asar.js      读 Electron asar（优先 Electron 虚拟路径 require，兜底手读 header）
└─ sanitize.js  出口兜底：修孤立代理项 + **剔除 undefined**（见下）
tools/
├─ smoke-test.mjs   离线测试（不联网），`npm test`
├─ semver-parity.mjs 与官方 semver 逐条对照（开发期用，不进 npm test）
└─ scan-dirty.mjs   扫描搜索结果里的脏字符（诊断用）
```

## 二、判定规则（不能改错的核心）

来自 DSH 0.2.1-rc.5 的 `dsh-app-boot` 源码（`unmetRequirements()`）：

1. **有 `engines.dsh` → 只看它**，`peerDependencies` 里的 dsh 包全部忽略；
2. 没有 `engines.dsh` → 逐个校验 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`；
3. peer 里 `workspace:^|~|*` → 视为当前 runtime；
4. **预发布参与匹配**（`includePrerelease: true`）；
5. 三态：`ok` / `incompatible` / `none`（**none ≠ 能用**）。

`^` / `~` / `x` 范围生成的**上界必须带 `-0`**（`^0.1.0-rc.6` → `<0.2.0-0`），否则 `0.2.0-rc.1` 会被误判为满足。
这条是和官方 semver 对照测出来的（330/330 一致）。

## 三、网络路线（2026-10-31 实测）

| 端点 | 结果 | 用途 |
| --- | --- | --- |
| `registry.npmmirror.com`（包 + 搜索） | 46–371ms | 首选 |
| `registry.npmjs.org`（包 + 搜索） | 2.5–5.3s | 并行竞速 |
| `esm.sh` | 1.1s | 备选 |
| `gh-proxy.com` + raw | **1.5s** | GitHub 最优 |
| `api.github.com`（contents / search） | 间歇（首轮可能 8s 超时） | 重试 2 次 |
| `github.com/topics/dsh-plugin` | 2.0s（HTML，必须 `accept: text/html`） | 兜底 |
| `raw.githubusercontent.com` 直连 | ECONNRESET | 需代理（默认不跑） |
| `cdn.jsdelivr.net` | ECONNRESET | 需代理（默认不跑） |
| `cdn.statically.io` / `ghproxy.net` | 超时 | 需代理（默认不跑） |
| `unpkg.com` | 4.1s / 偶发超时 | 慢车道 |
| `awesome-dsh-plugin.com/plugins.json` | 时通时超时 | 需代理（默认不跑） |
| `dshplugins.co/api/v1/plugins/<pkg>.json` | 3.6s+，首次会超时 | 未接入（P5 可作补充数据） |

**需要在有代理时验证的路线**：见仓库外的《待加速器验证-路线清单.md》。
开启方式：`BEST_FIT_NEEDS_PROXY=1`（默认关闭，避免无代理环境白等 8 秒）。

## 四、踩过的坑（都是真机实测）

### 1. `value is not lossless JSON`（第一次真机调用就崩）

现象：`find_dsh_plugin` 返回时 DSH 报 `tool returned invalid output: value is not lossless JSON`。

排查过程：先怀疑是 bili-duty 那个"孤立 UTF-16 代理项"老毛病 → 写 `tools/scan-dirty.mjs` 扫 → **脏字符 0 个**。
真因：返回值里的 **`undefined` 字段**（`checks: undefined`）。`JSON.stringify` 会丢弃 undefined，往返后字段消失，DSH 判定"不无损"。

修法：`lib/sanitize.js` 的 `wellFormedDeep` **修代理项 + 剔除 undefined**，并在 `define()` 里统一包装 `execute`。
👉 以后任何插件都要在工具出口做这件事。

### 2. GitHub topics 返回 406

给 HTML 页面发了 `accept: application/json`。→ 该路线单独 `accept: text/html`。

### 3. asar 在插件进程里读不了

手写 asar header 解析在**普通 Node**里能读到版本，但**插件进程（Electron）** 里 `fs` 被 asar 层接管，报 `ENOENT, not found in <asar>`。
修法：用 Electron 原生能力 `createRequire(asarPath)(asarPath + '/package.json')`。

### 4. npmjs 慢到 5.3 秒

3 秒超时必然失败。→ 与 npmmirror **并行竞速**，超时放到 8–12 秒。

### 5. 同名包冒认

GitHub 拿不到时用 repo 名降级到 npm —— 但必须校验 manifest 的 `repository` 确实指向该 `owner/repo`，否则会取到别人的同名包。

### 6. ★ 宿主进程里并发 HTTPS 会集体超时（P5 最关键的一条）

现象：一次调用里**并发**发 4 个源 → 全部 8s 超时、一条不回；而**同一个源单独请求**只要 300–900ms。
后果：搜索 11.8s、`check: true` 体检 14.5s。
修法：**全部串行** —— 一个接一个试，第一个成功即返回；搜索再加"结果够了就 break"。
结果：**14.5s → 0.38s**。

👉 这条对**任何在 DSH 里发网络请求的插件**都成立：**串行 > 并发**。别再写 `Promise.any(routes)`。

## 五、测试策略

| 测试 | 是否联网 | 说明 |
| --- | --- | --- |
| `npm test`（`tools/smoke-test.mjs`） | ❌ 不联网 | 导出/注册/semver/三态/渲染/目标解析/路线构造/well-formed |
| `tools/semver-parity.mjs <官方 semver 路径>` | ❌ | 与官方实现逐条对照（开发期） |
| `tools/scan-dirty.mjs [关键词]` | ✅ | 扫描真实搜索结果的脏字符（诊断） |

`BEST_FIT_TEST_ASAR=<asar 路径>` 可让 smoke 顺带验证 asar 读取。

## 六、发布流程（P6）

1. `npm test` 全绿；
2. `node --check` 所有 `lib/*.js`；
3. 隐私扫描：全包 grep **本机用户名与私有路径**（形如 `C:\Users\<本机用户名>`、`<私有盘符>:/...`）必须零命中 —— 连文档里的举例也别写真实用户名；
4. `npm pack --dry-run` 核对文件清单（应为 `lib/ locale/ cordis.patch.yml README.md CHANGELOG.md package.json`）；
5. **用本插件体检它自己**：`check_plugin_compat target: dsh-plugin-best-fit` 必须是 `ok`；
6. `npm publish`（不可逆，先给用户看第 4 步输出）；
7. `git tag v0.1.0` + push tag。
