/**
 * [INPUT]: store.settings.shortcuts；lib/shortcuts
 * [OUTPUT]: ShortcutSettings 可录制快捷键表
 * [POS]: 设置 › 通用 › 快捷键折叠区
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Plus, RotateCcw, X } from "lucide-react";
import { useT } from "../lib/i18n";
import { ACTIONS, checkCombo, comboOf, keymap, prettyCombo, type ActionId } from "../lib/shortcuts";
import { useStore } from "../store";

export function ShortcutSettings() {
  const t = useT();
  const { settings, saveSettings } = useStore(useShallow((s) => ({ settings: s.settings, saveSettings: s.saveSettings })));
  const map = keymap(settings.shortcuts);
  const [rec, setRec] = useState<{ id: ActionId; index: number } | null>(null);
  const [note, setNote] = useState<{ id: ActionId; text: string; swap?: { combo: string; from: ActionId } } | null>(null);

  const save = (next: Partial<Record<ActionId, string[]>>) => void saveSettings({ shortcuts: { ...settings.shortcuts, ...next } });
  const setKeys = (id: ActionId, keys: string[]) => save({ [id]: keys });

  useEffect(() => {
    if (!rec) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRec(null);
        return;
      }
      const keys = [...map[rec.id]];
      if (e.key === "Backspace" || e.key === "Delete") {
        if (rec.index >= 0) keys.splice(rec.index, 1);
        setKeys(rec.id, keys);
        setRec(null);
        return;
      }
      const combo = comboOf(e);
      if (!combo) return;
      const { reserved, takenBy } = checkCombo(combo, rec.id, settings.shortcuts);
      if (reserved) {
        setNote({ id: rec.id, text: t("{combo} 是系统快捷键，不能用", { combo: prettyCombo(combo) }) });
        setRec(null);
        return;
      }
      if (takenBy) {
        setNote({
          id: rec.id,
          text: t("{combo} 已经用于「{action}」", {
            combo: prettyCombo(combo),
            action: t(ACTIONS.find((a) => a.id === takenBy)!.label),
          }),
          swap: { combo, from: takenBy },
        });
        setRec(null);
        return;
      }
      if (rec.index >= 0) keys[rec.index] = combo;
      else if (!keys.includes(combo)) keys.push(combo);
      setKeys(rec.id, keys);
      setNote(null);
      setRec(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rec, settings.shortcuts]);

  const swap = (id: ActionId, combo: string, from: ActionId) => {
    save({
      [from]: map[from].filter((k) => k !== combo),
      [id]: [...map[id].filter((k) => k !== combo), combo],
    });
    setNote(null);
  };
  const changed = (id: ActionId) =>
    settings.shortcuts?.[id] != null && JSON.stringify(settings.shortcuts[id]) !== JSON.stringify(ACTIONS.find((a) => a.id === id)!.keys);
  const groups = [...new Set(ACTIONS.map((a) => a.group))];

  return (
    <div className="shortcuts">
      <div className="shortcuts-head">
        <p className="muted small">{t("点按键可以改成你习惯的组合，按 Esc 取消，按 ⌫ 删除。单个字母只在没有输入文字时生效。")}</p>
        {settings.shortcuts && Object.keys(settings.shortcuts).length > 0 && (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              void saveSettings({ shortcuts: {} });
              setNote(null);
            }}
          >
            <RotateCcw size={13} /> {t("全部恢复默认")}
          </button>
        )}
      </div>
      {groups.map((g) => (
        <section key={g} className="shortcut-group">
          <p className="setup-title">{t(g)}</p>
          {ACTIONS.filter((a) => a.group === g).map((a) => (
            <div key={a.id} className="shortcut-row">
              <span className="shortcut-label">{t(a.label)}</span>
              <span className="shortcut-keys">
                {map[a.id].map((k, i) => (
                  <button
                    key={k + i}
                    type="button"
                    className={`shortcut-recorder ${rec?.id === a.id && rec.index === i ? "recording" : ""}`}
                    onClick={() => setRec({ id: a.id, index: i })}
                    title={t("点击后按下新的组合")}
                  >
                    {rec?.id === a.id && rec.index === i ? t("请按键…") : <kbd>{prettyCombo(k)}</kbd>}
                  </button>
                ))}
                {rec?.id === a.id && rec.index === -1 ? (
                  <button type="button" className="shortcut-recorder recording">
                    {t("请按键…")}
                  </button>
                ) : (
                  map[a.id].length < 3 && (
                    <button type="button" className="icon-btn sm" title={t("再加一个")} aria-label={t("再加一个")} onClick={() => setRec({ id: a.id, index: -1 })}>
                      <Plus size={13} />
                    </button>
                  )
                )}
                {changed(a.id) && (
                  <button
                    type="button"
                    className="icon-btn sm"
                    title={t("恢复默认")}
                    aria-label={t("恢复默认")}
                    onClick={() => {
                      const next = { ...settings.shortcuts };
                      delete next[a.id];
                      void saveSettings({ shortcuts: next });
                    }}
                  >
                    <RotateCcw size={12} />
                  </button>
                )}
              </span>
              {note?.id === a.id && (
                <p className="shortcut-note small">
                  {note.text}
                  {note.swap && (
                    <button type="button" className="link-btn" onClick={() => swap(a.id, note.swap!.combo, note.swap!.from)}>
                      {t("改给这里用")}
                    </button>
                  )}
                  <button type="button" className="icon-btn sm" aria-label={t("关闭")} onClick={() => setNote(null)}>
                    <X size={12} />
                  </button>
                </p>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
