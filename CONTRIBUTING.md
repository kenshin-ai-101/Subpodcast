# 参与贡献 / Contributing

欢迎为 **Subpodcast · 声译** 提交 Issue 和 Pull Request。

## 提交前必过检查

```sh
npx tsc --noEmit -p .
npm run test
npm run lint
npm run i18n -- --strict
cd src-tauri && cargo test --lib
```

## 编码约定

- **Tauri 命令同步**：新增或修改命令时，须同时同步 Rust `#[tauri::command]` + `invoke_handler` + `src-tauri/build.rs` `COMMANDS` + `src-tauri/capabilities/default.json`。
- **WebView 约束**：禁止 `window.confirm` / `alert` / `prompt`（统一用 `src/lib/confirm.ts` 的 `ask()`）；多字段 Zustand 选择器使用 `useShallow`；不在组件内定义子组件。
- **多语言文案**：新增界面文案统一用 `t("简体原文")` 包裹，并同步补齐 `src/locales/zh-TW.json` 与 `src/locales/en.json`。
- **设计规范**：遵循暖纸编辑风视觉令牌，禁止装饰性竖向侧条（如引用块 `border-left` 粗彩条）。
- **密钥与凭据**：永不提交 API Key、证书、`.p8` 文件或本机配置；macOS 发布凭据仅保存在 gitignored 的 `release/` 与系统钥匙串。

## 反馈 Bug

请附上：操作系统版本、应用版本号（见 `package.json` / 发布包名）、复现步骤、实际现象与期望行为；涉及界面布局请附截图。

提交的代码均按 [AGPL-3.0-only](LICENSE) 协议发布。
