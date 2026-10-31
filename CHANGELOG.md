# CHANGELOG

## 0.1.0（未发布）

- **P0 骨架**：插件可被 DSH 加载；注册 `find_dsh_plugin` 与 `check_plugin_compat` 两个工具（当前返回骨架状态）；附带离线冒烟测试（`npm test`）。
- 兼容声明采用 `engines.dsh: ">=0.2.0-0 <0.3.0"`（DSH 门禁只看它；上界按世代切，0.3 世代需人工重验）。
