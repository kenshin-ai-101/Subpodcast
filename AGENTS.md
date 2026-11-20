# Agent notes for Subpodcast · 声译

- **对照**：可阅读 `/Users/kenshin/Projects/Subcast` 的设计与行为，**禁止复制其源码**。
- **Checks**：`npx tsc --noEmit -p .`；`cd src-tauri && cargo test --lib`
- **Tauri 新命令**：Rust 函数 + `invoke_handler` + `build.rs` COMMANDS + `capabilities/default.json`
- **WebView**：禁止 `window.confirm/alert/prompt`（用 `ask()`）；store 用 `useShallow`；不在组件内定义组件
- **Secrets**：永不进仓库、日志、提示词；macOS 签名凭据只在 `release/`（gitignore）与钥匙串 `notary`
- **Shipping**：正式 macOS 包走 [docs/RELEASING.md](docs/RELEASING.md)（`scripts/macos-sign-setup.sh` → `scripts/macos-release.sh`）；勿用 ad-hoc 包外发
- **Design**：无竖向侧条装饰；回复用户用中文；以「哥」开头
- **产品名**：英文 Subpodcast，中文 声译
