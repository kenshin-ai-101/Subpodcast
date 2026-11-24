/**
 * [INPUT]: registerConfirmHost
 * [OUTPUT]: 应用内确认对话框
 * [POS]: 全局挂一次
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useCallback, useEffect, useState } from "react";
import { registerConfirmHost } from "../lib/confirm";
import { useT } from "../lib/i18n";

interface PendingAsk {
  message: string;
  resolve: (v: boolean) => void;
}

export function ConfirmHost() {
  const t = useT();
  const [queue, setQueue] = useState<PendingAsk[]>([]);
  const head = queue[0] ?? null;

  useEffect(() => {
    registerConfirmHost(
      (message) =>
        new Promise<boolean>((resolve) => {
          setQueue((prev) => [...prev, { message, resolve }]);
        }),
    );
  }, []);

  const finish = useCallback((v: boolean) => {
    setQueue((prev) => {
      const [first, ...rest] = prev;
      first?.resolve(v);
      return rest;
    });
  }, []);

  useEffect(() => {
    if (!head) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [head, finish]);

  if (!head) return null;

  return (
    <div
      className="modal-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) finish(false);
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className="modal-head">
          <h3 id="confirm-title">{t("确认")}</h3>
        </div>
        <div className="modal-body">
          <p style={{ lineHeight: 1.55 }}>{head.message}</p>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => finish(false)}>
              {t("取消")}
            </button>
            <button type="button" className="btn primary" autoFocus onClick={() => finish(true)}>
              {t("确定")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
