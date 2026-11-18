# Subpodcast · 声译 — 双语播客桌面端

Tauri 2 + React/TypeScript + Rust + SQLite

> 让中文用户对照字幕听海外播客与 YouTube，并能和每一集对话。  
> 设计可对照 [`../Subcast`](../Subcast)，**代码全部原创，禁止照抄**。

<directory>
src/ — WebView 前端（组件、状态、样式）
src-tauri/ — Rust 宿主（订阅、字幕、翻译、LLM、SQLite）
docs/ — PRD / 架构 / 发布说明
</directory>

<config>
package.json — 前端依赖与脚本
src-tauri/Cargo.toml — Rust 依赖
src-tauri/tauri.conf.json — 应用标识 app.subpodcast.desktop
src-tauri/capabilities/default.json — 命令 ACL
</config>

## MVP 范围
订阅 → 播放 → 官方字幕 / 云端识别 → 双语翻译 → AI 问答 → 设置（字幕 / AI / 通用）。  
不含：本机 Whisper/Qwen3、设置「关于」、共享字幕库、乔木精读、海报、OTA。

## 法则
- 网络请求只在 Rust；Key 只进钥匙串
- 界面文案说结果（「生成字幕」），云端上传须明示
- 禁止 window.confirm/alert；用 `src/lib/confirm.ts`
- store 用 `useShallow` 切片；不在组件内定义组件
- [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
