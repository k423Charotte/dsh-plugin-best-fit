# dsh-plugin-best-fit · 寻找最合适的插件

> 在会话里搜 DSH 插件，并在**安装之前**告诉你：**以你这版 DSH，它到底能不能装、为什么。**

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。零 UI、零运行时依赖、只读网络请求。

## 它解决什么问题

现在找插件的工具不少：市场类帮你"逛"，体检类帮你查"已装的"。但真正会让人踩坑的那一步没人管——

**你想装一个插件，却不知道它是否适配你当前的 DSH 版本。**

DSH 的插件兼容是**运行时门禁**：`peerDependencies` 里 `@deepseek-ai/dsh*` 的范围不匹配时，那一行会被直接 `disabled`，模块**永不导入**；表现就是"装上了但什么都没有"。而写 `^0.1.x` 这类"锁某条线"的范围，会在 DSH 进入 0.2 之后**永久失效**（`dsh-find-plugin` 就是这么死的）。

本插件把这件事变成一次调用：

- `find_dsh_plugin` —— 按关键词搜 GitHub `topic:dsh-plugin`
- `check_plugin_compat` —— 给一个候选，当场判 `ok` / `incompatible` / `none`，并附**判据字段原文**

## 状态

**P0 / P1 / P2 / P3 / P4 / P5 / P7 已完成**：两个工具都可用，另有输入框上的配置浮窗。

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 骨架：加载 + 工具注册 + 离线测试 | ✅ |
| P1 | 搜索（GitHub `topic:dsh-plugin` + npm + topics 页） | ✅ |
| P2 | 兼容性体检（三态 + 依据） | ✅ |
| P3 | 搜索 + 体检联动（`check: true`） | ✅ |
| P4 | 多源降级 + 串行请求 | ✅ |
| P5 | 测试与文档打磨 | ✅ |
| P7 | **输入框上的配置浮窗** | ✅（需重启 DSH + F5） |
| P6 | 发布到 npm | ✅ `0.1.0` |

## 配置浮窗（不用改环境变量）

输入框**上方**会多出一个小按钮「▸ 找插件」。点开后是一个面板，宽度跟随输入框：

| 配置项 | 说明 |
| --- | --- |
| **GitHub Token** | 匿名搜索 10 次/分（共享出口 IP），配了变 30 次/分。存在 `<DSH_HOME>/best-fit/credential.json`（0o600），界面只回显后 4 位 |
| **搜索源** | 默认只开「npm 镜像 + GitHub 搜索」两个主源（快）；可加 npm 官方、topics 页、awesome（需代理） |
| **需代理的路线** | 打开后才试 raw / jsDelivr / ghproxy 等（开加速器后用） |
| **默认条数 / 体检条数 / 自动体检 / 显示诊断** | 影响工具的默认行为 |

配置文件在 `<DSH_HOME>/best-fit/config.json`，删掉即回到默认值。

## 现在就能用

```
find_dsh_plugin      query: "终端 TUI"  limit: 5
find_dsh_plugin      query: "微信通知"  check: true limit: 3
check_plugin_compat  target: bili-duty@0.1.3
check_plugin_compat  target: awesome-dsh-plugin/dsh-find-plugin
```

一次带体检的真实输出会是这样：

| 插件 | 结论 | 依据 |
| --- | --- | --- |
| `ly6170/dsh-messager` | ✅ 兼容 | 50 个 `@deepseek-ai/dsh*` peer 全 `^0.2.0-rc.1`，覆盖当前 `0.2.1-rc.5` |
| `cryjkd/dsh-clawbot` | ⚠️ 未声明 | 既无 `engines.dsh` 也无 dsh peer —— **门禁不拦，但不等于能用** |
| `awesome-dsh-plugin/dsh-find-plugin` | ❌ 不兼容 | peer 锁死在 `^0.1.x` |

## 判定规则（已按 DSH 0.2.1-rc.5 源码核实）

1. 有 `engines.dsh` → **只按它判**，`peerDependencies` 里的 dsh 包全部被忽略；
2. 没有 `engines.dsh` → 逐个校验 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 peer 范围；
3. **预发布参与匹配**（`includePrerelease`），所以 `>=0.2.0-rc.2` 能匹配 `0.2.1-rc.5`；
4. 三态：`ok` / `incompatible` / `none`（**未声明 ≠ 能用**，只是不会被拦）。

## 数据源与网络

- 搜索主源：GitHub `search/repositories?q=<kw> topic:dsh-plugin`（匿名 10 次/分/IP，超时 5s + 重试 1 次）
- 降级①：npm 镜像搜索（实测 46–371ms）
- 降级②：`awesome-dsh-plugin.com/plugins.json`
- 体检：npm registry 元数据优先；只有 GitHub 的插件走 `api.github.com` 的 contents API
- **不依赖** `raw.githubusercontent.com`（实测稳定不通）

## 安全边界

- **只返回安装命令字符串，绝不自动安装**任何第三方代码
- 不读取你的私有仓库；只访问公开 API
- 兼容结论必须附**依据字段原文**，便于你自己复核

## 许可

MIT
