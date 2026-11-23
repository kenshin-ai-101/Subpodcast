# src/
> L2 | 父级: /CLAUDE.md

成员清单
App.tsx: 应用壳；AudioEngine + YtEngine + MiniPlayer；预热 YouTube API；路由 / 收藏 / remindReview（离线清单在 store.init）
main.tsx: React 挂载入口
store.ts: Zustand；load→prepareEngines（先停另一路引擎再装载）；init 并行拉离线清单
styles.css: 暖纸底 + 橙强调；yt-dock（舞台 z>dock 透出）；theater；mini；单集右四 Tab / 叠字幕
lib/media.ts: preferAudio / initialAudioOnly（断网已下载 YouTube→仅音频）/ usesAudioEngine / usesYtEngine
lib/audioHost.ts: 单例 Audio；takeAudioEngine；换集前 pauseYoutubeHost；本地失败回退远端
lib/ytHost.ts: registerYtHost / pauseYoutubeHost — 与 audioHost 互斥停声
lib/ytKick.ts: load 投递换片（默认不播）；起播由 playSoon
lib/playback.ts: track/flush、waiting（20s 看门狗）、playSoon、armPlayerIntentListener、activeIndex
lib/offline.ts: 离线下载；clearDownloads；audioSrc 本地优先 / remoteAudioSrc 回退；清单 store.init 预拉
lib/api.ts: Tauri invoke（sharedGuide / shareGuide / ttsSynthesize / 朗读缓存与本地模型；sharedTranscript；saveDownload；learnClip / exportAnki / saveText）
lib/exportTranscript.ts: 字幕导出 SRT/WebVTT/ASS/LRC/TXT/Markdown（按内容模式组装；落盘 saveDownload）
lib/feeds.ts: looksLikeLink / sameFeed
lib/settings.ts: Settings / LearnLevel / PRESETS / TTS_SERVICES；shareTranscripts；ttsEngine / ttsServices / ttsRate；learn*；clipExportDir
lib/dict.ts: 离线 ECDICT（/dict/en.json）；lookup / isNew / looksEnglish / useDict
lib/words.ts: 生词本 FSRS（ts-fsrs）；blob learn/words；日学习 log / known；reviewQueue / toCsv
lib/clip.ts: 句级原声 prepare/play/toggle/prefetch；缺失原声与生词走统一朗读
lib/highlights.ts: 高光金句抽取（分窗同原站 + quick/超时 + progress）；blob `highlights`；试看/文案/手动 clip/蒙太奇
lib/clipboard.ts: writeClipboardText；WebView 手势失效时走 clipboard_write
lib/clipLines.ts: 剪视频字幕短句切分与可选 AI 标点分行
lib/videoClipCanvas.ts: 剪视频 WYSIWYG 几何、静帧叠层、字幕条画布
lib/videoCoverCanvas.ts: 剪视频封面模板渲染（8 款 × 多比例）
lib/sfx.ts: 拼写复习按键/对错/完成音效（受 learnSounds 控制）
lib/reading.ts: 字幕/问答 CSS 变量（--sub-scale 乘基准 px；列表/音频台/叠字共用）
lib/fonts.ts: 字幕可选字体与按需加载
lib/layout.ts: 侧栏/右栏几何（sideOpen → 72px 图标轨；localStorage）
lib/shortcuts.ts: 快捷键注册表与录制校验
lib/jobs.ts: 字幕瀑布（缓存/官方/共享库）+ 播放头优先自适应机翻 + switchYoutubeTrack + ASR + llmReady
lib/asrModels.ts: 本机模型列表/下载/删除进度
lib/ai.ts: 问答/导读提示词与文稿打包
lib/guides.ts: 导读任务态；共享查找/上传；blob summary + summary-from
lib/tts.ts: 统一朗读、试听、切块预取；本机 Web Speech / 磁盘合成音频播控
lib/localTts.ts: Melo / Kokoro 状态、下载进度、取消与删除
lib/chats.ts: 问答会话/历史持久化 + 流式 ask
lib/llmGate.ts: 串行化 llm-delta
lib/listening.ts: 墙钟收听累计 noteListening / flushListening
lib/youtube.ts: YouTube IFrame API + loadVideoById 换片 + 关自带 CC
lib/format.ts: 日期/时长/clock/parseClock/月份文案
lib/confirm.ts: 应用内确认替代 window.confirm
lib/queue.ts: start=load+openEpisode+playSoon；连播 / autoNext
lib/volume.ts: 全局音量
lib/library.ts: 收藏（blob `_app`/`favorites`）
lib/picks.ts: Discover 精选目录与 Topic
lib/deepPicks.ts: 原版 → 乔木精读入口映射（ShowView banner）
lib/recommend.ts: 首页「为你推荐」本地打分
lib/showLinks.ts: 主推节目站外链接；mayHaveYoutubeTwin 后台配对（不堵起播）
components/Chrome.tsx: Sidebar（首页/发现/统计/生词本；收起为图标轨）/ TopBar / Toast
components/Splitter.tsx: 列宽拖条（左栏 / 单集右栏；过 snap 收起 / 双击恢复）
components/HomeView.tsx: 卡片只打开；▶ / 继续听走 playAll；EpisodeRow + EpFeed（滚轮交给 .page）
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
components/SettingsDialog.tsx: 设置壳（字幕 / AI / 朗读 / 通用 / 学英语）；通用 › 存储对齐原站（离线清空 / 高光导出 / TTS 缓存）
components/LearnSettings.tsx: 设置 › 学英语
components/Learn.tsx: 标词 / 词卡 / LearnTip / EmptyState·ClipIcon·ClipLabel·dueLabel
components/LearnPractice.tsx: 本期生词 / 跟读 / 听写
components/LearnStats.tsx: 生词本统计卡 + 贡献热力（点天开词）
components/WordsBook.tsx: 生词本列表 / 词详情（听原声可暂停）/ 回想·拼写复习 / Anki·CSV / remindReview
components/LearnModal.tsx: 学英语小对话框（portal 到 body；可选 head / foot 钉底）
components/LocalAsrSettings.tsx: 本机 Qwen3/Whisper
components/ReadingSettings.tsx: 阅读预览与字号/字体
components/ModelSettings.tsx: AI 模型分栏
components/ShortcutSettings.tsx: 快捷键
components/AudioEngine.tsx: App 根哨兵；prepareAudio 预缓冲；订阅 savedPath（播中锁源）
components/YtEngine.tsx: App 根持久 iframe；registerYtHost；激活时 releaseAudio；失活 pauseVideo
components/MiniPlayer.tsx: 非单集页音频迷你条
components/PlayerBar.tsx: 绑页内 episode；switchTo 用 takeAudioEngine；视频双击/角标/F→theater
components/SubtitleOverlay.tsx: 视频舞台双语叠字幕
components/Illustrations.tsx: 空态手绘（WaveToText / Tray / Cassette / Page / Plug / NightNote）
components/TranscriptPane.tsx: GenCard/导出/学英语/行列表；「高光」子模式 + 行内 hl-head
components/HighlightViews.tsx: HighlightsPanel / SeekHighlights / useClipWarm
components/VideoClipDialog.tsx: 剪视频工作室（左 WYSIWYG 预览 / 右正片·封面·文案；开窗 auto-prepare 一次、失败不空转重试；预热走 HighlightViews.useClipWarm）；App 挂 VideoClipDialogHost
lib/webfonts.ts: 封面可选开源中文字体（ensureFont / familyOf）
lib/videoClipCanvas.ts: 正片叠层与水印（assets/logo.png +「声译」）
lib/videoCoverCanvas.ts: 封面模板画布（8 款 + 高亮/字号/字间距）
components/SelectionTools.tsx: 划词条（复制出处 / 翻译 / 剪视频；不做海报）
components/SubtitleExport.tsx: 字幕导出弹窗（格式 SRT·VTT·ASS·LRC·TXT·MD + 内容模式 + 预览）
components/EpisodeView.tsx: 打开不抢播；后台配对/字幕；右栏拖宽/收起
components/DeepRead.tsx: 乔木精读 HTML（右栏精读 Tab）
components/SummaryPane.tsx: 右栏导读（共享查找 / 生成 / 朗读脚注）
components/ReadAloud.tsx: 导读与精读统一朗读、引擎与音色快捷设置
components/TtsSettings.tsx: 系统增强语音、本地模型、云端提供商、试听和 Key
components/RatePicker.tsx: 语速分段控件与紧凑弹层
components/Markdown.tsx: 轻量 Markdown（时间戳区间 + timeline 竖脊）
components/ChatTools.tsx: 模型/提示词菜单（fixed 上弹，避 overflow 裁切）
components/ChatPane.tsx: 问答

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
