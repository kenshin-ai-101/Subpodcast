/**
 * [INPUT]: api.clipboardWrite；可选 navigator.clipboard
 * [OUTPUT]: writeClipboardText — 异步后仍可靠写入系统剪贴板
 * [POS]: WebView 在 await 后常丢失 user activation；本机命令兜底
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { api } from "./api";

/** 先试 Clipboard API，失败则走 Rust（不依赖用户手势）。 */
export async function writeClipboardText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* WKWebView：await LLM 后手势失效 → NotAllowedError */
  }
  await api.clipboardWrite(text);
}
