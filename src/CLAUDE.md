# src/
> L2 | 父级: /CLAUDE.md

成员清单
App.tsx: 应用壳；AudioEngine + YtEngine + MiniPlayer；预热 YouTube API；路由 / 收藏 / remindReview（离线清单在 store.init）
main.tsx: React 挂载入口
store.ts: Zustand；load→prepareEngines；align/rawTime/gapEnd/scrubTime（字幕时钟 vs 媒体时钟 / 拖拽预览）；init 并行拉离线清单
styles.css: 暖纸底 + 橙强调；yt-dock；theater；mini；asub 短句叠字；align-bar
lib/media.ts: preferAudio / initialAudioOnly（在线有 videoId 视频优先，避免 RSS 音频与 YouTube 字幕错位；纯音频或断网已下载→仅音频）/ usesAudioEngine / usesYtEngine
lib/audioHost.ts: 单例 Audio；rAF→toContent；seek→toPlay；pendingSeek 按字幕时钟重映射；对齐到达无缝切源；prepare 必硬停 YT
lib/ytHost.ts: registerYtHost / pauseYoutubeHost — stop+mute 硬停，挡 loadVideoById 迟到起播
lib/ytKick.ts: load 投递换片（默认不播）；起播由 playSoon
lib/playback.ts: track（媒体→字幕时钟）/ flush / waiting / playSoon（迟到 offer 校验 handle）/ activeIndex（开讲前返回 -1）
lib/pieces.ts: 长字幕块切短句；pieceAt / timedPieces（叠字与音频台按进度取当前句）
lib/timemap.ts: TimeMap toPlay/toContent/anchorAt；loadAlign / alignCurrent / setManualMap / registerAudioAlignBridge；YT 引擎下恒等
lib/mediaClock.ts: YouTube 粗采样墙钟外推（带 0.5s 缓冲上限）+ 异步 seek 目标锁（防 seekTo 期间旧读数回跳），供 YtEngine 驱动字幕
lib/offline.ts: 离线下载 + 对齐音频缓存（audio-cache）；clearDownloads / clearAudioCache；audioSrc 本地→对齐缓存→远端；清单 store.init 预拉
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
lib/reading.ts: 字幕/问答 CSS 变量（--sub-scale / --sub-orig-scale / --sub-lift；连续缩放、步进、拖拽位移；列表/音频台/叠字共用）
lib/fonts.ts: 字幕可选字体与按需加载
lib/layout.ts: 侧栏/右栏几何（sideOpen → 72px 图标轨；localStorage）
lib/shortcuts.ts: 快捷键注册表与录制校验
lib/jobs.ts: 字幕瀑布（缓存/官方/共享库）+ 机翻（已有 zh 译文时跳过自动翻译）+ switchYoutubeTrack + ASR（成功后 loadDownloads）+ llmReady
lib/asrModels.ts: 本机模型列表/下载/删除进度
lib/ai.ts: 问答/导读提示词与文稿打包
lib/guides.ts: 导读任务态；共享查找/上传；blob summary + summary-from
lib/tts.ts: 统一朗读、试听、切块预取；本机 Web Speech / 磁盘合成音频播控
lib/subtitleRead.ts: 外语字幕「中文」模式逐句中文朗读（预取下一句、实时语速同步、与原音频播放互斥）
lib/localTts.ts: Melo / Kokoro 状态、下载进度、取消与删除
lib/chats.ts: 问答会话/历史持久化 + 流式 ask
lib/llmGate.ts: 串行化 llm-delta
lib/listening.ts: 墙钟收听累计 noteListening / flushListening
lib/youtube.ts: YouTube IFrame API；cue 预热 / load 起播 / stopVideo；关自带 CC
lib/format.ts: 日期/时长/clock/parseClock/月份文案
lib/safeUrl.ts: openExternalUrl / isSafeHttpUrl（仅放行 http/https 外部链接）
lib/modelResolve.ts: resolveChatModel（统一消费 settings.chatModel || provider.model）
lib/i18n.ts: resolveLocale / translate / useT / tNow（简体/繁體/English 词典 locales/{zh-TW,en}.json）
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
components/ReadingSettings.tsx: 阅读预览、显示模式、中外双滑块 SubSizeSliders 与字体/样式
components/ModelSettings.tsx: AI 模型分栏
components/ShortcutSettings.tsx: 快捷键
components/AudioEngine.tsx: App 根哨兵；prepareAudio；savedPath；认领时 resumeAudioIfWanted；有字幕时自动 alignCurrent
components/YtEngine.tsx: App 根 iframe；cue/load 换片（switchingRef 挡旧片时钟）；seek 经 mediaClock.seek 防旧读数回跳；UNSTARTED/CUED 不覆写进度；滚动 clipPath 裁切；离页浮窗（含浮窗中文字幕与悬停操作条）；失活 stop+mute；倍速同步 mediaClock（上限 2×）
components/MiniPlayer.tsx: 非单集页音频迷你条（视频浮窗展示本集时自动避让；进度跟 rawTime ?? time）
components/PlayerBar.tsx: 绑页内 episode；AudioSubtitles 短句 now/next（片头/静默保留与未译回退原文）；ControlsBar（拖拽实时同步 scrubTime、窗口级 pointerup 提交）；switchTo；theater（2.5s idle 隐退控制条与底栏，拖拽中不隐退）
components/SubtitleOverlay.tsx: 视频叠字幕按块内进度只显当前短句（pieceAt；消费 scrubTime ?? time 实时同步进度条拖拽；支持指针上下拖拽移位、双击复位、未译回退原文、挂接 SubtitleTune）
components/SubtitleTune.tsx: 视频画中右上角 Aa 快捷调字幕弹层（中外双滑块、显示模式、样式、恢复默认与跳转设置）
components/AlignBar.tsx: 自动声纹/语音探针对齐进度与手动对齐（点句锚点 / ±1s / 恢复 / skipAds）
components/Illustrations.tsx: 空态手绘（WaveToText / Tray / Cassette / Page / Plug / NightNote）
components/TranscriptPane.tsx: GenCard/导出/学英语/对齐（跨源或时长错位提示条 + 手动滚动暂停跟随与回到当前位置）；panel-bar；按句订阅 active（消费 scrubTime ?? time，拖拽或大幅跳转即时居中定位）；高光
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
components/ReadAloud.tsx: 字幕/导读/精读统一朗读与快捷设置弹层（Portal fixed 防裁切，含引擎、音色、语速、试听）
components/TtsSettings.tsx: 系统增强语音、本地模型、云端提供商、试听和 Key
components/RatePicker.tsx: 语速分段控件与紧凑弹层
components/Markdown.tsx: 轻量 Markdown（时间戳区间 + timeline 竖脊）
components/ChatTools.tsx: 模型/提示词菜单（fixed 上弹，避 overflow 裁切）
components/ChatPane.tsx: 问答
components/ErrorBoundary.tsx: 主视图与复杂弹窗渲染错误兜底
components/ShortcutsHelpModal.tsx: ⌘/ 唤出的全站 21 项快捷键速查浮层

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
