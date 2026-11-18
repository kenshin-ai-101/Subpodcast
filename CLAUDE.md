# Subpodcast · 声译 — 双语播客桌面端

Tauri 2 + React/TypeScript + Rust + SQLite

> 让中文用户对照字幕听海外播客与 YouTube，并能和每一集对话。  
> 设计可对照 [`../Subcast`](../Subcast)，**代码全部原创，禁止照抄**。

<directory>
src/ — WebView 前端（首页/发现/收听统计、播放器、字幕叠层、本机 ASR、导读问答）
src-tauri/ — Rust 宿主（订阅、官方字幕、本机 ASR、收听统计、频道预览、翻译、LLM、SQLite；发行版 localhost UI）
docs/ — PRD / 架构 / 发布说明
</directory>

<config>
package.json — 前端依赖与脚本
src-tauri/Cargo.toml — Rust 依赖（tiny_http、symphonia、whisper-rs）
src-tauri/tauri.conf.json — 应用标识 app.subpodcast.desktop；窗口在 setup 创建
src-tauri/capabilities/default.json — 命令 ACL + remote http://localhost:14427–14446
</config>

## MVP 范围
订阅 → 首页/发现/收听统计 → 播放（视频/仅音频 + 叠字幕）→ 官方字幕 / 本机识别（Qwen3·Whisper）或云端 → 双语翻译 → 右栏字幕/精读/导读/问答 → 收藏/离线下载/YouTube 外开 → 设置（字幕 / AI / 通用）。  
发现页不含「乔木精读」专题（精读入口仍可在节目页与单集右栏出现）。  
不含：设置「关于」、海报、OTA。

## 法则
- 网络请求只在 Rust；Key 只存本机（正式签名→钥匙串；开发/ad-hoc→Application Support 文件，不进仓库）
- 界面文案说结果（「生成字幕」），云端上传须明示
- 禁止 window.confirm/alert；用 `src/lib/confirm.ts`
- store 用 `useShallow` 切片；不在组件内定义组件
- [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
