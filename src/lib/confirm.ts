/**
 * [INPUT]: 无
 * [OUTPUT]: ask(message | opts) Promise<boolean>；registerConfirmHost
 * [POS]: 替代 window.confirm；WebView 禁用原生对话框
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export interface ConfirmOpts {
  title?: string;
  message: string;
  ok?: string;
  danger?: boolean;
}

export type ConfirmRequest = ConfirmOpts & {
  resolve: (v: boolean) => void;
};

type Host = (req: ConfirmOpts) => Promise<boolean>;

let host: Host | null = null;

export function registerConfirmHost(fn: Host) {
  host = fn;
}

/** 应用内确认。传字符串时作正文；危险操作可设 danger，焦点落在取消。 */
export function ask(messageOrOpts: string | ConfirmOpts): Promise<boolean> {
  const opts: ConfirmOpts =
    typeof messageOrOpts === "string" ? { message: messageOrOpts } : messageOrOpts;
  if (host) return host(opts);
  return Promise.resolve(false);
}
