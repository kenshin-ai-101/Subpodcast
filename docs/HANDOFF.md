# SubCast 交接（2026-11-16）

分支 `feat/ux-redesign`（未合入 main）。构建：`npm run tauri build -- --bundles app`，产物 `src-tauri/target/release/bundle/macos/SubCast.app`。
自测：`cd src-tauri && cargo test --lib <name> -- --ignored --nocapture`（live 测试：qiaomu_channels、qiaomu_rss_sources、captions、sources、discover_picks）。

## 上一轮已完成
- 精读面板去掉说明文字；收起字幕栏图标放大；月份日历改为中性色+细强调条
- 乔木精读去重：订阅了原版节目则侧栏不再重复显示，原版节目页顶部出现「这档节目有乔木精读版」入口（`deepPickFor`）
- 本集简介移到播放器下方；去掉「导读」tab，AI 导读改为左侧可折叠卡片（`GuideCard`）
- 划线工具条（复制带出处 / 翻译 / 生成海报），海报移植自 elon.qiaomu.ai kit.js（`src/lib/poster.ts`、`components/SelectionTools.tsx`、Rust `save_image` 存到「下载」）
- 新增 rss.qiaomu.ai 普通源 + 乔木改写（`qiaomu.rs`：`rss_channel`、`rss_rewrite`（Markdown→HTML）、`podscribe_transcript`（带时间戳）；Podscribe 源无音频时按标题从原 RSS 借音频）。live 测试已通过（nexttoken、podscribe-pivot）
- 发现页新增：Next Token、Joe Rogan、80k、Pivot、Freakonomics、ILTB、DOAC

## 本轮已完成（2026-11-16 第二轮）
- **乔木改写频道接入前端**：发现页里 Next Token、半拿铁、Latent Space、Acquired、Pivot、Freakonomics、Invest Like the Best、Diary of a CEO 改为订阅 `https://rss.qiaomu.ai/sources/<id>`，标为精读（`picks.ts`；Rust `title_for` / `cover_for` 已补）。
  - 单集新增 `deep` 字段（`episodes.deep` 列，旧库启动时自动加列，原 `qiaomu` 单集置 1）。精读站单集恒为 true；rss 单集取接口的 `rewriteReady`，所以只有真有改写的单集才显示「精读」tab 和列表「精读」标签（Podscribe 源不少单集还没改写，如 Freakonomics 3/10）。
  - rss 普通源跳过没音频也没视频的条目（Latent Space 混着 AINews 文章，100 条剩 44 条可播）。
  - Podscribe 借音频改为读该节目自己的原始 RSS（`original_feed`，全量不截 300 条），按「标题完全一致 → 36 小时内且标题相近 → 12 小时内唯一一集 → 标题几乎一致」匹配（`find_audio`，有单测）。可播：Acquired 9/9、Pivot 22/22、Freakonomics 10/10、ILTB 10/10（之前 0）、DOAC 22/28（之前 7）。DOAC 原始 RSS 6.7 MB，订阅/刷新约多 5 秒。
  - 改写 Markdown 里的图片语法 `![..](..)` 不再漏出「!」。
- **字幕空状态重做**：`TranscriptPanel` 的无字幕 / 下载模型 / 识别失败改为居中卡片（`GenCard`：图标 + 衬线标题 + 一句说明 + 主按钮「生成字幕」+ 模型大小小字 + 可折叠识别设置，设置可换行）。错误文字去掉网址、最多三行，完整内容在悬停提示里。用 headless Chrome 在 340/460/760 px、浅色/深色下截图检查过。
- **The Builders**（Walter Isaacson，iHeart）加入发现页，RSS 为 omnycontent `…/51d9281c-e886-4139-b940-b4c0011494bc/podcast.rss`（Apple 按 "The Builders iHeart" 能搜到，id 6820674378）。

## 本轮已完成（2026-11-16 第三轮）
- **⌘, 打开设置**：macOS 默认菜单里没有「设置」项，现在在应用菜单加了「设置…」（⌘,，`lib.rs` 里 `Menu::default` + `on_menu_event` 发 `open-settings` 事件），页面里也兜底监听 ⌘,。
- **⌘L 聚焦搜索框**：顶部搜索框拉长到接近整个中间栏（最宽 1100px），右侧显示「⌘L」提示。
- **AI 问答**（参考 qiaomu-clipper）：
  - 输入框下方可随时切换模型（`ChatTools.tsx::ModelPicker`）：列出已保存 Key 的服务（本机服务只在已使用时列出），按服务分组、可搜索、可用方向键选择，从下一个问题开始生效。选中的模型存在 `settings.chatModel`；每条回答下方标注是哪个模型回答的。
  - 快捷提示词：10 条内置（三分钟看懂这期、最有价值的观点、嘉宾是谁、反直觉和有争议的地方、数据和预测、提到的书和资源、我能用上什么、术语和黑话、值得追问的问题、写一段分享）。空对话时以列表显示，对话中可从输入框的提示词按钮随时调出。
  - 「问答设置」对话框：全局指令（开关、示例短语），快捷提示词的新建、编辑、隐藏、删除和恢复内置。存在 `settings.chatPrompt / chatPromptOn / quickPrompts`（`quickPrompts` 为 null 表示用内置）。
- **本集简介**：打开页面就在后台用谷歌翻译成中文，展开时直接显示中文，并注明「谷歌翻译」。新增魔棒按钮，可用设置里的翻译模型重新翻译，结果按单集保存（blob `notes-zh`）。
- **AI 导读**：提示词改为「一句话总结 / 时间线 / 核心观点 / 值得记住的原话」，时间戳都能点击跳转。Markdown 渲染新增时间线样式（每项以时间戳开头的列表）、表格和引用。
- **左栏滚动**：卡片不再被压扁（`.ep-left > * { flex-shrink: 0 }`），左栏整体滚动；左栏、问答、简介、导读的滚动条只在滚动时出现（App 给正在滚动的元素加 `.is-scrolling`）。
- **自动检查更新**：启动时检查一次，之后每 30 分钟检查一次；窗口离开超过 10 分钟后回到前台也会检查。`refresh_all` 返回新单集数，有新节目时提示「订阅有 N 期新节目」；重叠的检查会跳过。
- **配色**：去掉蓝色（palette v5）。导航、选中、焦点状态用黑色和灰色；橙色只用于播放进度、时间戳、精读、进度条这类内容上的强调。
- **发现页**新增 28 个节目：16 个小宇宙中文播客（忽左忽右、声东击西、东腔西调、文化有限、无人知晓、商业就是这样、起朱楼宴宾客、乱翻书、科技早知道、疯投圈、厚雪长波、史蒂夫说、卫诗婕｜漫谈、罗永浩的十字路口、贝望录、纵横四海），12 个 YouTube 视频播客（Huberman、MLST、BG2、My First Million、Modern Wisdom、Tim Ferriss、Big Technology、Knowledge Project、Cheeky Pint、Peter Attia、Moonshots、Every AI & I）。新增分类「人文社科」「个人成长」。YouTube 节目用 `channel` 字段记频道名，订阅后能正确显示「已订阅」和中文名。live 测试 `discover_picks` 全部能解析并有可播单集，28 个封面都返回 200。
## 未完成（按优先级）
0. **在 app 里实测第三轮改动**：⌘, / ⌘L、问答模型切换和提示词、简介魔棒重新翻译、导读时间线、滚动条自动隐藏、自动检查更新提示（都只做了类型检查、构建和静态 CSS 截图）。
1. **在 app 里实测第二轮改动**（本轮只做了接口 live 测试和 CSS 截图，没能在 app 里点过：构建时旧版 SubCast 正在运行，没有替用户退出）。重启 app 后看：
   - 发现 › 乔木精读：订阅 Pivot / Next Token，列表里只有真有改写的单集带「精读」标签，点开默认在「精读」tab；没有改写的单集不显示精读 tab。
   - 已订阅原版 Acquired 等节目的老用户：节目页顶部出现「这档节目有乔木精读版」入口。
   - 一集没字幕的 YouTube / 播客：字幕栏是居中卡片，拖窄字幕栏到最窄（340）不溢出；下载模型、识别失败两种状态也是卡片。
   - 订阅 DOAC 会多等约 5 秒（读原始 RSS 借音频）。
2. 未实测（沿用上一轮）：窄面板图标 tab、骨架屏、视频失败自动切音频、云端识别/TTS（需 Key）、海报保存与复制。
3. The Builders 中文名「造物者」是暂定，需要确认；用户要求「在 app 里订阅一次」也还没做（需要在 app 里点订阅）。
4. 发布：合入 main 前按全局 git 流程（worktree、diff 审阅、验证后删分支）。release 分支 `release/macos-sign`（PR joeseesun/subcast#1）独立。
## 关键位置
- 精读站频道：`qiaomu.rs::channel/detail`；rss 源：`qiaomu.rs::rss_*`；命令在 `lib.rs`（`preview_show`、`cached_show`、`qiaomu_detail`、`fetch_official_transcript`）
- 设置（Capwise 移植）：`SettingsDialog.tsx`、`lib/settings.ts`（PRESETS/ASR_SERVICES/VOICES）、`cloud.rs`
- 布局：`lib/layout.ts`、`Splitter.tsx`；样式全部在 `src/styles.css`（后追加的块覆盖前面）
- 研究笔记：`docs/rss-qiaomu-integration.md`
