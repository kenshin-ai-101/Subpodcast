# src/
> L2 | 父级: /CLAUDE.md

成员清单
App.tsx: 应用壳；非单集页顶栏 + Sidebar
main.tsx: React 挂载入口
store.ts: Zustand（导航 history/back、播放、设置、settingsSection）
styles.css: 与 SubCast 对齐的原创令牌与布局（暖纸底 + v5 橙强调；节目页头图/月份轴；设置三栏）
lib/api.ts: Tauri invoke 类型化封装
lib/feeds.ts: looksLikeLink / sameFeed（订阅入口共用）
lib/settings.ts: Settings / PRESETS / ASR_SERVICES、默认值与持久化（三栏字段对齐 SubCast）
lib/reading.ts: 字幕/问答 CSS 变量（字号、字体、描边）
lib/fonts.ts: 字幕可选字体与按需加载
lib/shortcuts.ts: 快捷键注册表与录制校验
lib/jobs.ts: 字幕瀑布与翻译长任务
lib/format.ts: 日期/时长/月份文案/简介剥 HTML
lib/confirm.ts: 应用内确认替代 window.confirm
lib/queue.ts: 会话级连播 + settings.autoNext
components/Chrome.tsx: Sidebar / TopBar / Toast
components/ShowView.tsx: 订阅详情（封面、检查更新/播放全部/更多、筛选、⌘F、月份轴）
components/MonthFilter.tsx: 按年月热力筛选单集
components/HomeView.tsx: 首页 + 共享 EpisodeRow
components/AddDialog.tsx: 添加节目（搜索 / 链接或 RSS / 导入）
components/ImportPanel.tsx: 浏览器 YouTube + OPML 等文件导入
components/BrowserAccess.tsx: macOS 浏览器数据权限引导
components/SettingsDialog.tsx: 设置壳（字幕 / AI / 通用；不做关于）
components/ReadingSettings.tsx: 设置 › 字幕 阅读预览与字号/字体/播放
components/ModelSettings.tsx: 设置 › AI 模型分栏
components/ShortcutSettings.tsx: 设置 › 通用 › 快捷键
components/: Episode（左媒体+右 Tab）/Player/Transcript/Chat

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
