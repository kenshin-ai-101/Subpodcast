/**
 * [INPUT]: children、title、onClose
 * [OUTPUT]: 通用居中 Modal（.modal-back / .modal）
 * [POS]: 学英语本期生词 / 听写等小对话框
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

export function LearnModal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
