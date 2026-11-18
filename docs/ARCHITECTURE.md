# 架构 · Subpodcast 声译

```
┌──────────────── WebView (React + TS) ────────────────┐
│ 订阅列表 · 单集 · 播放器 · 双语字幕 · AI 问答 · 设置（字幕/AI/通用） │
└──────────────▲───────────────── invoke / events ─────┘
               │
┌──────────────┴──────── Rust (Tauri 2) ───────────────┐
│ feeds     RSS/Atom、YouTube 频道、iTunes、小宇宙        │
│ import    浏览器 YouTube 订阅 / OPML 等（前端解析文件） │
│ captions  YouTube InnerTube + podcast:transcript     │
│ translate 谷歌 / LLM 批次                            │
│ llm       OpenAI 兼容流式代理                        │
│ db        SQLite：订阅、单集、字幕、blobs、设置        │
│ secrets   API Key → 系统钥匙串                       │
│ net       代理（http/socks5）                        │
└──────────────────────────────────────────────────────┘
```

## 关键决策
- 网络全在 Rust（CORS + 统一代理）
- 订阅源归一为 Show + Episode
- MVP 识别：官方字幕 → 用户触发的云端 Whisper 兼容接口；本机引擎二期再上
- 翻译：默认谷歌；可切自有模型
- 问答：整集带时间戳文稿进上下文；回答要求 `[mm:ss]`

## 数据表
`shows` · `episodes` · `transcripts` · `blobs` · `settings`

## 对照说明
产品理念与布局可参考 SubCast；本仓库实现为原创代码，标识符 `app.subpodcast.desktop`。
