/**
 * [INPUT]: shortcuts.ACTIONS / keymap / prettyCombo / useKeysHelp；store.settings.shortcuts
 * [OUTPUT]: ShortcutsHelpModal — ⌘/ 唤出的全站快捷键速查浮层
 * [POS]: App 根挂载；支持 Esc 关闭与直达快捷键设置
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect } from "react";
import { Keyboard, X } from "lucide-react";
import { useT } from "../lib/i18n";
import { ACTIONS, keymap, prettyCombo, useKeysHelp } from "../lib/shortcuts";
import { useStore } from "../store";

export function ShortcutsHelpModal() {
  const t = useT();
  const open = useKeysHelp((s) => s.open);
  const custom = useStore((s) => s.settings.shortcuts);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        useKeysHelp.setState({ open: false });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  const map = keymap(custom);
  const groups = Array.from(new Set(ACTIONS.map((a) => a.group)));
  const close = () => useKeysHelp.setState({ open: false });

  return (
    <div
      className="modal-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="keys-help-title">
        <div className="modal-head">
          <h3 id="keys-help-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Keyboard size={16} /> {t("快捷键速查")}
          </h3>
          <button type="button" className="icon-btn" aria-label={t("关闭")} onClick={close}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body" style={{ maxHeight: "65vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
          {groups.map((g) => (
            <div key={g} className="shortcut-group">
              <div className="muted small" style={{ fontWeight: 600, marginBottom: 4 }}>
                {t(g)}
              </div>
              {ACTIONS.filter((a) => a.group === g).map((a) => (
                <div key={a.id} className="shortcut-row">
                  <span className="shortcut-label">{t(a.label)}</span>
                  <span className="shortcut-keys">
                    {(map[a.id] ?? []).map((c) => (
                      <kbd key={c} className="kbd">
                        {prettyCombo(c)}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
          <div className="modal-actions" style={{ marginTop: 4 }}>
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                close();
                useStore.getState().set({ settingsOpen: true, settingsSection: "general" });
              }}
            >
              {t("自定义快捷键")}
            </button>
            <button type="button" className="btn sm primary" onClick={close}>
              {t("知道了")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
