/**
 * [INPUT]: registerConfirmHost
 * [OUTPUT]: 应用内确认对话框
 * [POS]: 全局挂一次
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useState } from "react";
import { registerConfirmHost } from "../lib/confirm";

export function ConfirmHost() {
  const [msg, setMsg] = useState<string | null>(null);
  const [resolve, setResolve] = useState<((v: boolean) => void) | null>(null);

  useEffect(() => {
    registerConfirmHost(
      (message) =>
        new Promise<boolean>((res) => {
          setMsg(message);
          setResolve(() => res);
        }),
    );
  }, []);

  if (!msg) return null;

  const finish = (v: boolean) => {
    resolve?.(v);
    setMsg(null);
    setResolve(null);
  };

  return (
    <div className="modal-back">
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>确认</h3>
        </div>
        <div className="modal-body">
          <p style={{ lineHeight: 1.55 }}>{msg}</p>
          <div className="modal-actions">
            <button className="btn" onClick={() => finish(false)}>
              取消
            </button>
            <button className="btn primary" onClick={() => finish(true)}>
              确定
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
