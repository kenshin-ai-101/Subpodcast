/**
 * [INPUT]: @tauri-apps/plugin-opener
 * [OUTPUT]: openExternalUrl — 强制校验 http(s) 协议后再调用系统打开外部链接
 * [POS]: 阻止 RSS / 远端 HTML 中 file:// 或自定义协议通过 openUrl 触发本机处理器
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { openUrl } from "@tauri-apps/plugin-opener";

export function isSafeHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export async function openExternalUrl(raw: string): Promise<void> {
  if (!isSafeHttpUrl(raw)) return;
  await openUrl(raw.trim());
}
