# 参与贡献 / Contributing

**中文**

欢迎提 Issue 和 PR。

- **报告问题**：写清系统和版本（设置 › 关于）、复现步骤、你看到的和期望的结果，必要时附截图。
- **改代码前**：大一点的改动先开 Issue 说一下想法，避免白做。
- **提交前自查**：
  ```sh
  npx tsc --noEmit -p .
  npm run i18n -- --strict          # 新增的界面文字要补齐 en / ja / zh-TW 三个词典
  cd src-tauri && cargo test
  ```
- 界面文字一律用 `t("中文原文")` 包起来，翻译放在 `src/locales/`。
- PR 里说明改了什么、怎么验证的，界面改动附截图。

提交的代码按本项目的 [AGPL-3.0](LICENSE) 协议发布。

**English**

Issues and pull requests are welcome. Describe your system and version (Settings › About) and how to reproduce a bug. For larger changes, open an issue first. Before sending a PR, run `npx tsc --noEmit -p .`, `npm run i18n -- --strict` and `cargo test` in `src-tauri`. Wrap interface text in `t("…")` and add translations under `src/locales/`. Contributions are released under the project's AGPL-3.0 license.
