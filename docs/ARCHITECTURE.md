# 架构 · Subpodcast 声译

```
┌──────────────── WebView (React + TS) ────────────────┐
│ 订阅 · 单集 · 播放器 · 双语字幕 · 精读/导读/问答 · 学英语/生词本 · 设置 │
└──────────────▲───────────────── invoke / events ─────┘
               │
┌──────────────┴──────── Rust (Tauri 2) ───────────────┐
│ feeds     RSS/Atom、YouTube 频道、iTunes、小宇宙        │
│ import    浏览器 YouTube 订阅 / OPML 等（前端解析文件） │
│ captions  YouTube InnerTube + podcast:transcript     │
│ shared    subcast.qiaomu.ai 匿名共享字幕库           │
│ translate 谷歌（tr_cache）/ LLM 批次                 │
│ llm       OpenAI 兼容流式代理                        │
│ clip      句级原声剪辑（Range / 本地 / YouTube 音轨）   │
│ anki      生词本 .apkg（schema-11）                   │
│ db        SQLite：订阅、单集、字幕、blobs、tr_cache   │
│ secrets   API Key → 钥匙串（签名包）/ 本机文件（开发） │
│ net       代理（http/socks5）                        │
└──────────────────────────────────────────────────────┘
```

## 关键决策
- 网络全在 Rust（CORS + 统一代理）
- 订阅源归一为 Show + Episode
- 识别：官方字幕 → 共享库 → 用户触发本机（Qwen3/CrispASR 或 Whisper）或云端；ASR 成功可匿名上传（`shareTranscripts`）
- 播放：有 `videoId` 可切「视频 / 仅音频」；音频 RSS 经 `attach_youtube_twins` 按标题配对 YouTube；有音轨时仅音频走 `<audio>`，否则隐藏 IFrame；发行版 UI 挂 `http://localhost:14427+`
- 字幕瀑布：本地缓存 → `fetch_official_transcript`（缺 videoId 时 `fill_youtube_twin`；YouTube 选轨；中文轨对齐 blob `zh`；RSS / Podscribe / 乔木）→ `shared_transcript` → 空态 GenCard →「生成字幕」。词元等双形态新订阅优先乔木源，避免纯音频只能 ASR
- 翻译：开集 `autoTranslate`；播放头优先 + 自适应并发；youtube/shared engine 只填缺口；完成后可 `share_translation`
- 精读：`qiaomu_detail` 写 blob `deep-read`；`episodes.deep`；右栏 Tab；与导读分离
- 导读：右栏 `SummaryPane`；blob `summary` / `summary-from`；共享查找+上传；豆包朗读；与问答共用 chat 模型
- 离线：`offline.rs` 下载单集音频；事件 `offline`；前端 `lib/offline.ts`
- 问答：整集带时间戳文稿进上下文；回答要求 `[mm:ss]`；blob `chat` / `chat-archive`；快捷提示词与全局指令在 settings
- 学英语：`settings.learn*` 默认关；ECDICT（`public/dict/en.json`）；生词本 blob `learn/words` + FSRS；`learn_clip` / `export_anki` / `save_text`

## 数据表
`shows` · `episodes` · `transcripts` · `blobs` · `settings` · `tr_cache` · `listens`

## 对照说明
产品理念与布局可参考 SubCast；本仓库实现为原创代码，标识符 `app.subpodcast.desktop`。
