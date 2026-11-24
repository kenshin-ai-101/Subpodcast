# Subpodcast · 声译

> 听懂海外播客与 YouTube：双语字幕、AI 精读/导读/问答、多引擎朗读、FSRS 沉浸学英语与高光双语视频剪辑，原创桌面端（Tauri 2 + React/TS + Rust + SQLite）。

## 核心能力

- **全源订阅与双形态播放**：支持 Apple Podcasts 搜索、RSS/Atom、小宇宙与 YouTube 频道；支持浏览器 YouTube 订阅与 OPML 导入；同集支持「视频 / 仅音频」切换、离线下载与断网自动回退、离页迷你播放器。
- **双语字幕与离线识别**：官方字幕 → 共享字幕库 → 本机离线识别（Qwen3-ASR / Whisper，音频不出本机）或云端识别（显式提示上传）；支持谷歌翻译与自有大模型翻译（快速 / 二阶段精翻）。
- **四栏深度理解**：字幕 · 乔木精读 · AI 导读 · AI 问答（带可点击时间戳、快捷提示词、多模型切换与会话归档）。
- **多引擎朗读（TTS）**：系统增强语音、Edge Read Aloud、本机离线神经语音（Melo / Kokoro，带 SHA-256 校验）与多云端朗读服务。
- **英语学习模式**：内置离线 ECDICT 词典、按水平（四级/六级/考研/雅思）标词、句内 AI 释义、原声句级剪辑、FSRS 生词本复习（回想 / 拼写 / 跟读 / 听写）、已知词过滤与 Anki `.apkg` / CSV 导出。
- **高光短视频工作室**：AI 自动抽取金句高光、WYSIWYG 双语叠字与 8 款封面模板、单段与多段蒙太奇 H.264/AAC MP4 导出。
- **外观与多语言**：支持 macOS 一体式标题栏、跟随系统 / 浅色 / 深色主题切换、简体中文 / 繁體中文 / English 界面与 19 项可自定义快捷键（`⌘/` 速查）。

## 隐私与安全声明

- **音频默认不出本机**：用户未主动选择云端 ASR 服务前，音频永不上传云端。
- **匿名共享字幕默认关闭**：`shareTranscripts` 默认关闭，仅在用户主动开启后匿名上传公共源字幕；含鉴权参数或内网私有源永不上传。开启单集时查询共享字幕库（`subcast.qiaomu.ai`）以加速首屏字幕体验。
- **密钥与边界**：正式签名包 API Key 存系统钥匙串；WebView 开启 CSP 策略，外部链接强制 `http(s)` 协议校验，API Key 仅发往用户已保存的服务配置地址。

## 开发与验证

需要 Node.js 22+、Rust stable（macOS 11.0+ 推荐）。

```sh
npm install
npm run tauri dev
```

质量检查门禁：

```sh
npx tsc --noEmit -p .
npm run test
npm run lint
npm run i18n -- --strict
cd src-tauri && cargo test --lib
```

发布 macOS 签名公证包见 [docs/RELEASING.md](docs/RELEASING.md)。

## 文档索引

- 产品需求：[docs/PRD.md](docs/PRD.md)
- 系统架构：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 发布手册：[docs/RELEASING.md](docs/RELEASING.md)
- 参与贡献：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全策略：[SECURITY.md](SECURITY.md)

## 协议

[AGPL-3.0-only](LICENSE)
