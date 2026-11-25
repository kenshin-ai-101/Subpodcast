/**
 * [INPUT]: registerConfirmHost / ask
 * [OUTPUT]: 应用内确认对话框（alertdialog、Tab 陷阱、Esc 关闭）
 * [POS]: 全局挂一次
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { registerConfirmHost, type ConfirmOpts } from "../lib/confirm";
import { useT } from "../lib/i18n";

interface PendingAsk extends ConfirmOpts {
  resolve: (v: boolean) => void;
}

export function ConfirmHost() {
  const t = useT();
  const [queue, setQueue] = useState<PendingAsk[]>([]);
  const head = queue[0] ?? null;
  const ok = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    registerConfirmHost(
      (opts) =>
        new Promise<boolean>((resolve) => {
          setQueue((prev) => [...prev, { ...opts, resolve }]);
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
    const prev = document.activeElement as HTMLElement | null;
    // 危险操作优先落在取消，避免误触确认
    (head.danger ? cancel.current : ok.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const next = document.activeElement === cancel.current ? ok.current : cancel.current;
        next?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [head, finish]);

  if (!head) return null;

  const title = head.title ?? t("确认");
  const okLabel = head.ok ?? t("确定");

  return (
    <div
      className="modal-back confirm-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) finish(false);
      }}
    >
      <div
        className="modal confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-msg"
      >
        <div className="modal-head">
          <h3 id="confirm-title">{title}</h3>
        </div>
        <div className="modal-body">
          <p id="confirm-msg" style={{ lineHeight: 1.55 }}>
            {head.message}
          </p>
          <div className="modal-actions">
            <button ref={cancel} type="button" className="btn" onClick={() => finish(false)}>
              {t("取消")}
            </button>
            <button
              ref={ok}
              type="button"
              className={`btn ${head.danger ? "danger" : "primary"}`}
              onClick={() => finish(true)}
            >
              {okLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
