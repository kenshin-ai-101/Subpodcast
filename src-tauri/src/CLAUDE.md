# src-tauri/src/
> L2 | 父级: /CLAUDE.md

成员清单
lib.rs: Tauri 命令面与启动（含 video_clip_* / fetch_cover_data_url / db_data_version / cli_status / cli_install / reveal_file / file_exists / clipboard_write；首启静默同步 CLI 软链）
main.rs: 桌面端 GUI 二进制入口
bin/subpodcast-cli.rs: 独立无头 CLI 二进制入口（`subpodcast mcp` / `shows` / `episodes` / `doctor` / `--asr-worker`）
mcp.rs: MCP over stdio（JSON-RPC 2.0，2024-11-05；13 工具 + 3 资源 + progressToken 进度通知 + 无订阅直达与歧义消解）
mcp_connect.rs: 本机外部 AI 工具探测与无损写入/移除 MCP 配置（JSON + Codex TOML）
cli_install.rs: 跨平台 `subpodcast-cli` 软链探测、一键安装与过期自动更新
model.rs: Show/Episode/Segment/Transcript 契约
db.rs: SQLite WAL；tr_cache；sync_episodes / dedupe_show_episodes；data_version（跨连接同步）；count_episodes / list_shows.episode_count；listens / recent
feeds.rs: 订阅解析与搜索（全量入库，LIST_EPISODES_CAP 仅限一次 list）；xyz ACL 时 iTunes≤200 单集目录 + 精读合并；catalog_partial 只合并；refresh_with_title
qiaomu.rs: 精读频道 + detail / rss_rewrite（分页拉满，不截 300）；qiaomu_detail 写 deep-read
import.rs: YouTube 浏览器订阅导入、隐私设置入口、OPML 导出
ytdlp.rs: find_tool + yt-dlp 定位/镜像安装；ytdlp_command（proxy、socket-timeout、js-runtimes、bot fallback）
asr.rs: 本机模型；ASR 选源（双形态优先 YouTube、纯播客复用 downloads/audio-cache 并落盘 audio-cache）；16k 解码进度 + encode_wav_bytes + decode_mono_stream；Qwen3/Whisper
align.rs: Chromaprint 声纹提取/分段匹配 + 本机 ASR 语音探针对齐（TimeMap / AudioRef）
clip.rs: 英语学习原声剪辑（Range / 本地文件 → 16k WAV）与 extract_raw 精确切片
anki.rs: 英语学习 .apkg 导出（schema-11；guid subpodcast:{id}）
videoclip/: 高光视频切片（fastclip / ffmpeg / inspect / render）；见 videoclip/CLAUDE.md
captions.rs: YouTube video_info/选轨/script_hint/official_chinese/align；VTT；resegment 重叠截断
shared.rs: 共享字幕（小宇宙/乔木 key 归一 + audio-ref / fingerprint）+ 导读；命中则跳过 ASR 下载
tts.rs: 豆包 unidirectional TTS → WAV，兼容旧 tts_speak
speech.rs: 统一合成；Key 回落；tts-cache（500 MiB 上限）；系统音色与音频时长
edge_tts.rs: Edge Read Aloud，免 Key WebSocket 语音合成
edge_gec.rs: Edge Sec-MS-GEC v2 握手摘要
local_tts.rs: sherpa-onnx；Melo / Kokoro 状态、下载、校验、取消与离线推理
local_tts_models.json: 固定版本的语音模型清单与哈希
ui.rs: 发行版 localhost:14427 挂载内嵌前端
translate.rs: 谷歌 / LLM 翻译批次
llm.rs: OpenAI/Anthropic 对话；ChatOpts（max_tokens / json_mode / quick）
net.rs: 统一 HTTP 客户端；设置代理优先，留空直连，失败再试系统/环境代理（禁幽灵 system-proxy）
secrets.rs: API Key（正式签名→钥匙串；debug/ad-hoc→本机 secrets.json + 内存缓存）
offline.rs: 单集音频离线（downloads/，命中 audio-cache 自动转正）+ 对齐缓存（audio-cache/，2 GB 真实 LRU）；ASR 复用 find/find_cached

命令补充：shared_* / align_audio / save_time_map / list_audio_cache / clear_audio_cache / tts_* / local_tts_* / clear_downloads / learn_clip / export_anki / save_text / video_clip_env|warm|prepare|prepare_audio|render / fetch_cover_data_url / db_data_version / cli_status / cli_install / reveal_file / file_exists / clipboard_write

storage_info 计入 audioCache、ttsCache 与 ttsModels；open_data_folder 支持 audio-cache / tts-cache / tts-models / models；assetProtocol 含 audio-cache 与 work/clips。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
