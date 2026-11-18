# src-tauri/src/
> L2 | 父级: /CLAUDE.md

成员清单
lib.rs: Tauri 命令面与启动（shared_* / share_guide / tts_speak / translate_texts；youtube_tracks；ASR 上传共享库）
main.rs: 二进制入口
model.rs: Show/Episode/Segment/Transcript 契约
db.rs: SQLite WAL；tr_cache；sync_episodes / dedupe_show_episodes；listens / recent
feeds.rs: 订阅解析与搜索；词元入口优先乔木源；fill_youtube_twin；小宇宙也 attach twin
qiaomu.rs: 精读频道 + detail / rss_rewrite；qiaomu_detail 写 deep-read
import.rs: YouTube 浏览器订阅导入、隐私设置入口、OPML 导出
ytdlp.rs: 定位或下载 yt-dlp
asr.rs: 本机模型、下载、16k 解码、Qwen3/Whisper
captions.rs: YouTube video_info/选轨/script_hint/official_chinese/align；VTT
shared.rs: 共享字幕 + 共享导读（guides API）；匿名 install id
tts.rs: 豆包 unidirectional TTS → WAV
ui.rs: 发行版 localhost:14427 挂载内嵌前端
translate.rs: 谷歌 / LLM 翻译批次
llm.rs: OpenAI/Anthropic 对话
net.rs: 统一 HTTP 客户端与代理
secrets.rs: 钥匙串 API Key
offline.rs: 单集音频离线下载

命令补充：shared_guide / share_guide / tts_speak；shared_transcript / share_translation / translate_texts

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
