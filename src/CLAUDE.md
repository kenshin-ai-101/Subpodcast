# src/
> L2 | 父级: /CLAUDE.md

成员清单
App.tsx: 应用壳；首页/发现/统计/频道路由；收藏 + 离线清单加载与收听 flush
main.tsx: React 挂载入口
store.ts: Zustand（View: home/discover/stats/recent/channel/show/episode；history/back；播放；settings）
styles.css: 暖纸底 + 橙强调；单集页 yt-strip / 右四 Tab / 叠字幕
lib/api.ts: Tauri invoke（sharedGuide / shareGuide / ttsSpeak；sharedTranscript；saveDownload；离线下载）
lib/exportTranscript.ts: 字幕导出 MD/PDF（按显示模式组装；PDF 画布分页；落盘 saveDownload）
lib/feeds.ts: looksLikeLink / sameFeed
lib/settings.ts: Settings / PRESETS / VOICES；shareTranscripts；ttsVoice
lib/reading.ts: 字幕/问答 CSS 变量
lib/fonts.ts: 字幕可选字体与按需加载
lib/layout.ts: 侧栏/右栏几何（sideOpen → 72px 图标轨；localStorage）
lib/shortcuts.ts: 快捷键注册表与录制校验
lib/jobs.ts: 字幕瀑布（缓存/官方/共享库）+ 播放头优先自适应机翻 + switchYoutubeTrack + ASR + llmReady
lib/asrModels.ts: 本机模型列表/下载/删除进度
lib/ai.ts: 问答/导读提示词与文稿打包
lib/guides.ts: 导读任务态；共享查找/上传；blob summary + summary-from
lib/tts.ts: 豆包朗读切块与播控
lib/chats.ts: 问答会话/历史持久化 + 流式 ask
lib/llmGate.ts: 串行化 llm-delta
lib/playback.ts: 进度心跳 track/flush、缓冲 waiting、playSoon（就绪后开播）、activeIndex
lib/listening.ts: 墙钟收听累计 noteListening / flushListening
lib/youtube.ts: YouTube IFrame API + 关闭自带 CC
lib/format.ts: 日期/时长/clock/parseClock/月份文案
lib/confirm.ts: 应用内确认替代 window.confirm
lib/queue.ts: 会话级连播 + settings.autoNext
lib/volume.ts: 全局音量
lib/library.ts: 收藏（blob `_app`/`favorites`）
lib/offline.ts: 单集音频离线下载进度与清单
lib/picks.ts: Discover 精选目录与 Topic
lib/deepPicks.ts: 原版 → 乔木精读入口映射（ShowView banner）
lib/recommend.ts: 首页「为你推荐」本地打分
lib/showLinks.ts: 主推节目站外链接；mayHaveYoutubeTwin 触发单集页配对刷新
components/Chrome.tsx: Sidebar（首页/发现/统计；收起为图标轨）/ TopBar / Toast
components/Splitter.tsx: 列宽拖条（左栏 / 单集右栏；过 snap 收起 / 双击恢复）
components/HomeView.tsx: 继续收听 / 接下来听 / 最新 / 推荐；共享 EpisodeRow
components/RecentView.tsx: 最近播放 / 收藏
components/DiscoverView.tsx: Topic + 精选网格 + 横幅
components/ChannelView.tsx: 订阅前预览（cached/preview）
components/PromoBanner.tsx: HomeShowBanner / YtButton / YtVideoStrip（单集订阅条）
components/StatsView.tsx: 收听统计 + AI 画像
components/ShowView.tsx: 订阅详情；侧栏单集总数同源；精读入口 banner
components/MonthFilter.tsx: 按年月热力筛选单集
components/AddDialog.tsx: 添加节目
components/ImportPanel.tsx: 浏览器 YouTube + OPML 导入
components/BrowserAccess.tsx: macOS 浏览器权限引导
components/SettingsDialog.tsx: 设置壳（字幕 / AI / 通用）
components/LocalAsrSettings.tsx: 本机 Qwen3/Whisper
components/ReadingSettings.tsx: 阅读预览与字号/字体
components/ModelSettings.tsx: AI 模型分栏
components/ShortcutSettings.tsx: 快捷键
components/PlayerBar.tsx: 视频/仅音频（media-switch-row 靠右短条；有文件走 audio，否则隐藏 YT）
components/SubtitleOverlay.tsx: 视频舞台双语叠字幕
components/Illustrations.tsx: 空态手绘（WaveToText / Tray / Cassette / Page / Plug / NightNote）
components/TranscriptPane.tsx: 查找/模型下载/GenCard+插画（开播自启）/导出 MD·PDF / 实时识别行 + YouTube 语言切换 + 行列表
components/EpisodeView.tsx: 开集 ensureTranscript/autoTranslate；右栏拖宽/收起；标题动作 + 简介 + 右四 Tab
components/DeepRead.tsx: 乔木精读 HTML（右栏精读 Tab）
components/SummaryPane.tsx: 右栏导读（共享查找 / 生成 / 朗读脚注）
components/ReadAloud.tsx: 豆包朗读按钮 + 音色/Key 弹层
components/Markdown.tsx: 轻量 Markdown（时间戳区间 + timeline 竖脊）
components/ChatTools.tsx: 模型/提示词菜单（fixed 上弹，避 overflow 裁切）
components/ChatPane.tsx: 问答

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
