/**
 * [INPUT]: settings.providers / chatProvider / quickPrompts；api.hasApiKey
 * [OUTPUT]: ModelPicker、PromptMenu、ChatPrefsDialog、useFixedUpMenu
 * [POS]: 问答面板附属控件；菜单用 fixed 锚定避开 ep-right overflow 裁切
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown, Settings2, Sparkles } from "lucide-react";
import { shortModel } from "../lib/ai";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { BUILTIN_PROMPTS, PROMPT_HINTS, quickPrompts, type QuickPrompt } from "../lib/settings";
import { useStore } from "../store";

/** 向上弹出的 fixed 菜单位置：躲开父级 overflow:hidden 裁切。 */
export function useFixedUpMenu(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  width: number,
  align: "left" | "right" = "left",
): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties | undefined>();
  useLayoutEffect(() => {
    if (!open) {
      setStyle(undefined);
      return;
    }
    const place = () => {
      const el = anchor.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const left =
        align === "right"
          ? Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))
          : Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      const bottom = Math.max(8, window.innerHeight - r.top + 6);
      const maxHeight = Math.max(120, Math.min(360, r.top - 12));
      setStyle({ position: "fixed", left, bottom, width, maxHeight, zIndex: 40 });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, width, align, anchor]);
  return style;
}

export function ModelPicker({ disabled }: { disabled?: boolean }) {
  const t = useT();
  const { settings, saveSettings } = useStore(
    useShallow((s) => ({ settings: s.settings, saveSettings: s.saveSettings })),
  );
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  const btn = useRef<HTMLButtonElement>(null);
  const menuStyle = useFixedUpMenu(open, btn, 240, "left");
  const provider = settings.providers[settings.chatProvider];

  useEffect(() => {
    const list = Object.values(settings.providers).filter((p) => p.needsKey);
    void Promise.all(list.map(async (p) => [p.id, await api.hasApiKey(p.id)] as const)).then((r) =>
      setKeys(Object.fromEntries(r)),
    );
  }, [settings.providers, open]);

  const options = useMemo(() => {
    return Object.values(settings.providers).filter((p) => {
      if (!p.model) return false;
      if (!p.needsKey) return p.group === "local" ? settings.chatProvider === p.id : true;
      return !!keys[p.id] || p.id === settings.chatProvider;
    });
  }, [settings.providers, settings.chatProvider, keys]);

  return (
    <div className="model-picker">
      <button
        ref={btn}
        type="button"
        className="btn ghost sm"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        title={t("切换问答模型")}
        aria-expanded={open}
      >
        {provider ? shortModel(provider.model) : t("选模型")}
        <ChevronDown size={12} />
      </button>
      {open && menuStyle && (
        <>
          <div className="mp-backdrop" onClick={() => setOpen(false)} />
          <div className="mp-menu mp-fixed" role="listbox" style={menuStyle}>
            {options.map((p) => (
              <button
                key={p.id}
                type="button"
                className={p.id === settings.chatProvider ? "on" : ""}
                onClick={() => {
                  void saveSettings({ chatProvider: p.id, chatModel: p.model });
                  setOpen(false);
                }}
              >
                <span className="mp-name">{t(p.name)}</span>
                <span className="mp-model">{shortModel(p.model)}</span>
              </button>
            ))}
            {!options.length && <p className="muted small">{t("先在设置 › AI 填好 Key")}</p>}
          </div>
        </>
      )}
    </div>
  );
}

export function PromptMenu({
  onPick,
  onManage,
  disabled,
}: {
  onPick: (body: string) => void;
  onManage: () => void;
  disabled?: boolean;
}) {
  const t = useT();
  const settings = useStore((s) => s.settings);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menuStyle = useFixedUpMenu(open, btn, 260, "left");
  const items = quickPrompts(settings).filter((p) => p.enabled);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  return (
    <div className="prompt-menu">
      <button
        ref={btn}
        type="button"
        className="btn ghost sm"
        disabled={disabled}
        title={t("快捷提示词")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Sparkles size={13} />
      </button>
      {open && menuStyle && (
        <>
          <div className="mp-backdrop" onClick={() => setOpen(false)} />
          <div className="mp-menu prompt-pop mp-fixed" role="menu" style={menuStyle}>
            {!items.length && <p className="muted small">{t("还没有快捷提示词")}</p>}
            {items.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                title={t(p.body)}
                onClick={() => {
                  onPick(t(p.body));
                  setOpen(false);
                }}
              >
                <span className="mp-name">{t(p.title)}</span>
              </button>
            ))}
            <button
              type="button"
              className="mp-manage"
              onClick={() => {
                setOpen(false);
                onManage();
              }}
            >
              <Settings2 size={13} /> {t("管理提示词")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function ChatPrefsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { settings, saveSettings } = useStore(
    useShallow((s) => ({ settings: s.settings, saveSettings: s.saveSettings })),
  );
  const list = quickPrompts(settings);
  const save = (next: QuickPrompt[]) => void saveSettings({ quickPrompts: next });

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal chat-prefs" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{t("问答设置")}</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("关闭")}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="cp-block">
            <div className="cp-row">
              <strong>{t("全局指令")}</strong>
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.chatPromptOn}
                  onChange={(e) => void saveSettings({ chatPromptOn: e.target.checked })}
                />
                {t("启用")}
              </label>
            </div>
            <textarea
              className="cp-instr"
              rows={3}
              maxLength={4000}
              disabled={!settings.chatPromptOn}
              value={settings.chatPrompt}
              placeholder={t("例如：先给结论，再展开；多用列表")}
              onChange={(e) => void saveSettings({ chatPrompt: e.target.value })}
            />
            <div className="cp-hints">
              {PROMPT_HINTS.map((h) => (
                <button
                  key={h}
                  type="button"
                  className="chip"
                  disabled={!settings.chatPromptOn}
                  onClick={() => {
                    const cur = settings.chatPrompt.trim();
                    const text = t(h);
                    void saveSettings({
                      chatPrompt: cur ? `${cur}\n${text}` : text,
                      chatPromptOn: true,
                    });
                  }}
                >
                  {t(h)}
                </button>
              ))}
            </div>
          </div>
          <div className="cp-block">
            <div className="cp-row">
              <strong>{t("快捷提示词")}</strong>
              {settings.quickPrompts && (
                <button type="button" className="btn sm ghost" onClick={() => void saveSettings({ quickPrompts: null })}>
                  {t("恢复内置")}
                </button>
              )}
            </div>
            <ul className="cp-list">
              {list.map((p, i) => (
                <li key={p.id}>
                  <div className="cp-row">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={p.enabled}
                        onChange={(e) => {
                          const next = list.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x));
                          save(next);
                        }}
                      />
                    </label>
                    <input
                      className="cp-title"
                      value={t(p.title)}
                      onChange={(e) => {
                        const next = list.map((x, j) => (j === i ? { ...x, title: e.target.value } : x));
                        save(next);
                      }}
                    />
                    <button
                      type="button"
                      className="link-btn"
                      disabled={list.length <= 1}
                      onClick={() => save(list.filter((_, j) => j !== i))}
                    >
                      {t("删除")}
                    </button>
                  </div>
                  <textarea
                    className="cp-body"
                    rows={2}
                    value={t(p.body)}
                    onChange={(e) => {
                      const next = list.map((x, j) => (j === i ? { ...x, body: e.target.value } : x));
                      save(next);
                    }}
                  />
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn sm"
              onClick={() =>
                save([
                  ...list,
                  {
                    id: `custom-${Date.now()}`,
                    title: t("新提示词"),
                    body: t("在这里写下你想问的问题…"),
                    enabled: true,
                  },
                ])
              }
            >
              {t("新建提示词")}
            </button>
            <p className="muted small">{t("内置共 {n} 条；自定义后可随时恢复。", { n: BUILTIN_PROMPTS.length })}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
