# src-tauri/
> L2 | 父级: /CLAUDE.md

成员清单
tauri.conf.json: 应用标识 / 打包；assetProtocol=$DATA/Subpodcast/downloads·clips·work/clips·tts-cache；macOS 11.0 + hardenedRuntime + Entitlements.plist
Entitlements.plist: Developer ID 公证用 Hardened Runtime（JIT 等）
capabilities/default.json: 命令 ACL（含 video_clip_* / reveal_file / file_exists / clipboard_write）+ dialog:allow-save|open + localhost UI 端口
Cargo.toml / build.rs: Rust 依赖与命令清单
icons/: 应用图标
src/: 见 src/CLAUDE.md（含 videoclip/）

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
