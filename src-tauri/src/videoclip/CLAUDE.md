# src-tauri/src/videoclip/
> L2 | 父级: ../CLAUDE.md

「高光」与选区视频切片管线：支持 YouTube 视频取段与纯音频播客（封面/纯色底 + 截取音频 → 1080×1080 MP4），叠上 WebView 画好的双语字幕 / 标题 / 封面 PNG，导出 H.264 + AAC MP4；并提供安全远程封面拉取 data URL。
依赖方向单向：mod.rs 编排 → fastclip / inspect / render → ffmpeg；外部经 ytdlp.rs / net.rs / offline.rs / asr.rs。
缓存在 `<data>/work/clips/<video_id|audio-ep>/`：`<起ms>-<止ms>.mp4` + 旁路 `.lead`（正文在文件里的起点）/ `.meta.json` / `.frames.json`；
「清理临时文件」会整体清掉。tauri.conf 的 assetProtocol 放行此目录，供预览 `<video>` 播放。

成员清单
mod.rs: 命令契约类型（camelCase）与编排；prepare_segment 取段顺序 = 同名缓存 → 覆盖缓存重编截取 → fastclip 快速分片 → yt-dlp --download-sections 兜底；prepare_audio_ranges 纯音频取段（离线/对齐缓存优先 → 远端直截 → 下载兜底）；fetch_image_data_url 安全封面拉取；finish 在锁外发 inspect；prepare_montage concat；warm 预解析；keyed_lock 只罩写入 dest；commit 先写旁路再 rename
ffmpeg.rs: FFmpeg 边界层；find（复用 ytdlp::find_tool）/ ensure（镜像 → 上游静态包下到 data/bin，`-version` 验活）/ hardware_h264（VideoToolbox 探测缓存）；run 走 `-progress pipe:1` 按行进度 + 取消杀进程；encode_h264 硬编失败退 libx264；mux_copy（画面原样拷贝）/ normalize（重编截取）
fastclip.rs: 快速取段；yt-dlp -j 选 avc1≤1080 + mp4a 直链（进程内缓存到 expire，403 视为失效重解析一次）；解析 sidx 只取覆盖分片，1MB × 8 路并发 Range（单连接会被限到播放速率）；层级 sidx / 无索引即报错交回兜底
inspect.rs: 画面体检，只在正文 [lead, lead+span] 内并发抽帧；硬字幕 = 底部 35% 条带「亮邻暗」字形边缘的帧间 Jaccard 中位数 < 0.5（台标不动不算）；候选封面 5 张 JPEG data URL，最大者为默认
render.rs: 导出；旧 layout 字符串与 Frame 归一为 Canvas 单一几何路径（fill 裁切 / card 盒子 + 模糊或纯色底）；倍速 setpts + atempo；静态层与定时字幕 overlay；封面 flash 0.14s / hold 1s（tpad + adelay）/ 内嵌 attached_pic；图层 PNG 落 work 目录以相对名入参；封面旁路 -封面.png / -横版封面.png
tests.rs: 离线全链路冒烟（种子缓存 → 覆盖截取 → 体检 → 闪现 / 停留 / 倍速导出，无 FFmpeg 则跳过）；live_* 需网络，--ignored 手动跑

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
