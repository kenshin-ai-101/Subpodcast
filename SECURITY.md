# 安全策略 / Security Policy

## 报告安全漏洞

如发现安全隐患（包括但不限于 WebView XSS/CSP 绕过、Tauri IPC 越权读写、API Key 泄露、二进制下载校验漏洞等），请**不要**在公开 Issue 中披露细节。

请通过本仓库的私密安全通告渠道（GitHub Repository › Security › Advisories › Report a vulnerability）提交，或直接联系项目维护者，并尽量提供：

1. 受影响的版本与操作系统平台
2. 最小复现步骤或 PoC
3. 潜在影响范围评估

我们会在确认后尽快修复并发布安全版本，随后再公开漏洞细节。仅最新发布的稳定版本获得安全更新支持。

## 内建安全防线概览

- Tauri WebView 启用显式 CSP 策略，远端精读 HTML 经 DOMPurify 清洗。
- Tauri 外部链接打开强制校验 `http://` / `https://` 协议；`reveal_file` 对 macOS `.app`/`.pkg` 等 Bundle 仅定位不执行；`export_anki` 仅允许打包应用 `clips/` 目录内音频；`save_text` / `save_download` 执行扩展名白名单校验。
- API Key 仅发往用户已持久化保存的服务 `baseUrl`（强制 `https://`，仅本机回环允许 `http://`）；正式签名包密钥存储于系统钥匙串。
