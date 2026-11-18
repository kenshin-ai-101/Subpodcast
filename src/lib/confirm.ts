/**
 * [INPUT]: 无
 * [OUTPUT]: ask(message) Promise<boolean>
 * [POS]: 替代 window.confirm；WebView 禁用原生对话框
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

let host: ((message: string) => Promise<boolean>) | null = null;

export function registerConfirmHost(fn: (message: string) => Promise<boolean>) {
  host = fn;
}

export function ask(message: string): Promise<boolean> {
  if (host) return host(message);
  return Promise.resolve(false);
}
