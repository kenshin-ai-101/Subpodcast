# src-tauri/src/
> L2 | 父级: /CLAUDE.md

成员清单
lib.rs: Tauri 命令面与启动（shared_* / tts_* / local_tts_* / clear_downloads / learn_clip / export_anki / video_clip_* / reveal_file / file_exists / clipboard_write）
main.rs: 二进制入口
model.rs: Show/Episode/Segment/Transcript 契约
db.rs: SQLite WAL；tr_cache；sync_episodes / dedupe_show_episodes；count_episodes / list_shows.episode_count；listens / recent
feeds.rs: 订阅解析与搜索（全量入库，LIST_EPISODES_CAP 仅限一次 list）；xyz ACL 时 iTunes≤200 单集目录 + 精读合并；catalog_partial 只合并；refresh_with_title
qiaomu.rs: 精读频道 + detail / rss_rewrite（分页拉满，不截 300）；qiaomu_detail 写 deep-read
import.rs: YouTube 浏览器订阅导入、隐私设置入口、OPML 导出
ytdlp.rs: find_tool + yt-dlp 定位/镜像安装；ytdlp_command（proxy、socket-timeout、js-runtimes、bot fallback）
asr.rs: 本机模型；ASR 选源 enclosure 优先 / youtube_audio（-N8 无 -x）；16k 解码进度；Qwen3/Whisper
clip.rs: 英语学习原声剪辑（Range / 本地文件 → 16k WAV）
anki.rs: 英语学习 .apkg 导出（schema-11；guid subpodcast:{id}）
videoclip/: 高光视频切片（fastclip / ffmpeg / inspect / render）；见 videoclip/CLAUDE.md
captions.rs: YouTube video_info/选轨/script_hint/official_chinese/align；VTT
shared.rs: 共享字幕（小宇宙/乔木 key 归一）+ 导读；命中则跳过 ASR 下载
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
offline.rs: 单集音频离线；ASR 复用 find()

命令补充：shared_* / tts_* / local_tts_* / clear_downloads / learn_clip / export_anki / save_text / video_clip_env|warm|prepare|render / reveal_file / file_exists / clipboard_write

storage_info 计入 ttsCache 与 ttsModels（audioCache 占位 0）；open_data_folder 支持 tts-cache / tts-models / models；assetProtocol 含 work/clips。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
