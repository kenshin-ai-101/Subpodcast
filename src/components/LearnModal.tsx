/**
 * [INPUT]: children、title、onClose；可选 head / foot；createPortal → document.body
 * [OUTPUT]: 通用居中 Modal（.modal-back / .modal）；foot 钉在列表外
 * [POS]: 学英语本期生词 / 听写 / 词详情；portal 躲开右栏 overflow:hidden 裁切
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useT } from "../lib/i18n";

export function LearnModal({
  title,
  onClose,
  children,
  wide,
  head,
  foot,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** 替代默认 h3 标题（如词详情的翻页）。 */
  head?: ReactNode;
  /** 钉在滚动区外的底栏（取消 / 加入等），避免被列表或右栏裁切。 */
  foot?: ReactNode;
}) {
  const t = useT();
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  return createPortal(
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`modal${wide ? " wide" : ""}${foot != null ? " has-foot" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          {head ?? <h3>{title}</h3>}
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("关闭")}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {foot != null && <div className="modal-foot">{foot}</div>}
      </div>
    </div>,
    document.body,
  );
}
