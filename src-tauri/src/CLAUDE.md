# src-tauri/src/
> L2 | 父级: /CLAUDE.md

成员清单
lib.rs: Tauri 命令面与启动（shared_* / share_guide / tts_speak / translate_texts；save_download；youtube_tracks；ASR 上传共享库；learn_clip / export_anki / save_text）
main.rs: 二进制入口
model.rs: Show/Episode/Segment/Transcript 契约
db.rs: SQLite WAL；tr_cache；sync_episodes / dedupe_show_episodes；count_episodes / list_shows.episode_count；listens / recent
feeds.rs: 订阅解析与搜索（全量入库，LIST_EPISODES_CAP 仅限一次 list）；xyz ACL 时 iTunes≤200 单集目录 + 精读合并；catalog_partial 只合并；refresh_with_title
qiaomu.rs: 精读频道 + detail / rss_rewrite（分页拉满，不截 300）；qiaomu_detail 写 deep-read
import.rs: YouTube 浏览器订阅导入、隐私设置入口、OPML 导出
ytdlp.rs: yt-dlp 定位/镜像安装；ytdlp_command（proxy、socket-timeout、js-runtimes、bot fallback）
asr.rs: 本机模型；ASR 选源 enclosure 优先 / youtube_audio（-N8 无 -x）；16k 解码进度；Qwen3/Whisper
clip.rs: 英语学习原声剪辑（Range / 本地文件 → 16k WAV）
anki.rs: 英语学习 .apkg 导出（schema-11；guid subpodcast:{id}）
captions.rs: YouTube video_info/选轨/script_hint/official_chinese/align；VTT
shared.rs: 共享字幕（小宇宙/乔木 key 归一）+ 导读；命中则跳过 ASR 下载
tts.rs: 豆包 unidirectional TTS → WAV
ui.rs: 发行版 localhost:14427 挂载内嵌前端
translate.rs: 谷歌 / LLM 翻译批次
llm.rs: OpenAI/Anthropic 对话
net.rs: 统一 HTTP 客户端；设置代理优先，留空直连，失败再试系统/环境代理（禁幽灵 system-proxy）
secrets.rs: API Key（正式签名→钥匙串；debug/ad-hoc→本机 secrets.json + 内存缓存）
offline.rs: 单集音频离线；ASR 复用 find()

命令补充：shared_guide / share_guide / tts_speak；shared_transcript / share_translation / translate_texts；save_download；learn_clip / export_anki / save_text

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
