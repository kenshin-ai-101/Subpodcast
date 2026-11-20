# 发布 Subpodcast · 声译

给人或 Agent 的发货手册。流程变了就改这份。

MVP **不含** OTA / 界面热更新。macOS 外发必须 **Developer ID 签名 + 公证**，否则 Gatekeeper 会拦。

## 渠道

| 改动 | 渠道 | 命令 |
|---|---|---|
| 任意可运行改动，给本机 / 内测 | 本地 ad-hoc 包 | `MACOSX_DEPLOYMENT_TARGET=11.0 npm run tauri build -- --bundles app,dmg` |
| 给别人装的正式包 | **macOS 签名发布** | `scripts/macos-sign-setup.sh` 一次 → `scripts/macos-release.sh` |

Windows / Linux / 自动更新以后再加；先把 macOS 公证做对。

## 一次性：本机签名环境

需要：

1. [Apple Developer Program](https://developer.apple.com/programs/) 会员
2. 证书 **Developer ID Application**（不是 Mac Development / Mac App Distribution）
3. App Store Connect API Key（推荐）或 Apple ID + [App 专用密码](https://appleid.apple.com/account/manage)

```bash
# 1) 在 developer.apple.com 创建证书，导出 .p12，双击导入「登录」钥匙串
security find-identity -v -p codesigning   # 应出现 Developer ID Application: …

# 2) 写入 notary 配置 + release/signing.env（均不进 git）
scripts/macos-sign-setup.sh --notary-api
# 或
scripts/macos-sign-setup.sh --notary-apple-id

# 3) 复查
scripts/macos-sign-setup.sh --check
```

凭据落点（**禁止提交**）：

| 东西 | 位置 |
|---|---|
| 签名身份名 / Team ID | `release/signing.env` |
| App Store Connect `.p8` 路径 | `release/apple-api.env`（仅 API 路径） |
| 公证密码 | 钥匙串 profile `notary`（`notarytool store-credentials`） |

## 打正式包

屏幕解锁（钥匙串可读）：

```bash
scripts/macos-release.sh              # 当前架构
scripts/macos-release.sh --universal  # aarch64 + x86_64 各一份
```

产物：`release/<version>/Subpodcast_<version>_<arch>.dmg`（已 staple）。

验证：

```bash
spctl -a -t open --context context:primary-signature -v release/<version>/Subpodcast_*.dmg
# 期望: accepted … source=Notarized Developer ID
```

只签不公证（调试）：`scripts/macos-release.sh --skip-notarize`。

## 版本号

发货前 bump 三处同一版本：`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`。

## 已知陷阱

- whisper.cpp 要求 `MACOSX_DEPLOYMENT_TARGET≥10.15`；仓库已设 `minimumSystemVersion: 11.0`，脚本也导出该环境变量。
- `notarytool … | grep -q` 在 `pipefail` 下可能因 SIGPIPE(141) 误杀成功步骤；脚本先捕获输出再匹配。
- ad-hoc / 未公证包：`secrets.rs` 走本机 `secrets.json`；正式 Developer ID 包才写钥匙串（ACL 绑 CDHash）。
- 证书、API Key、App 专用密码：**永不**进仓库、日志、聊天、提示词。

## 脚本

| 脚本 | 职责 |
|---|---|
| `scripts/macos-sign-setup.sh` | 检查身份、写入 notary profile 与 `release/signing.env` |
| `scripts/macos-release.sh` | 签名构建 → 公证 → staple → 收口到 `release/<ver>/` |

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
