# Subpodcast · 声译

听懂海外播客和 YouTube：双语字幕与 AI 问答，桌面端（macOS / Windows / Linux）。

> 产品理念可对照 [SubCast](https://github.com/joeseesun/subcast)；本仓库为**原创实现**。

## 开发

需要 Node.js 22+、Rust stable。

```sh
npm install
npm run tauri dev
```

检查：

```sh
npx tsc --noEmit -p .
cd src-tauri && cargo test --lib
```

## MVP

订阅 → 播放 → 官方字幕 / 云端识别 → 翻译 → AI 问答。详见 [docs/PRD.md](docs/PRD.md)。

## 协议

AGPL-3.0
