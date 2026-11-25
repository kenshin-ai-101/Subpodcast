/**
 * [INPUT]: store.settings（字幕缩放/位移/显示/样式/快捷键）；ReadingSettings.SubSizeSliders；PlayerBar.toggleTheater
 * [OUTPUT]: SubtitleTune — 视频画中右上角 Aa 快捷调字幕弹层
 * [POS]: 挂载在视频舞台容器内（由 SubtitleOverlay 渲染）；改动与设置 › 字幕实时共用同一份偏好
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState } from "react";
import { ALargeSmall } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useT } from "../lib/i18n";
import { resetSubtitleTuning } from "../lib/reading";
import { ACTIONS, prettyCombo, type ActionId } from "../lib/shortcuts";
import { useStore } from "../store";
import { toggleTheater } from "./PlayerBar";
import { Seg, SubSizeSliders } from "./ReadingSettings";

export function SubtitleTune() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const {
    subtitleScale,
    subtitleOrigScale,
    subtitleLift,
    subtitleMode,
    subtitleLook,
    shortcuts,
    saveSettings,
  } = useStore(
    useShallow((s) => ({
      subtitleScale: s.settings.subtitleScale,
      subtitleOrigScale: s.settings.subtitleOrigScale,
      subtitleLift: s.settings.subtitleLift,
      subtitleMode: s.settings.subtitleMode,
      subtitleLook: s.settings.subtitleLook,
      shortcuts: s.settings.shortcuts,
      saveSettings: s.saveSettings,
    })),
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!hostRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const modified =
    Boolean(subtitleLift) || subtitleScale != null || subtitleOrigScale != null;

  const comboLabel = (id: ActionId) => {
    const raw = shortcuts?.[id] ?? ACTIONS.find((a) => a.id === id)?.keys ?? [];
    return raw[0] ? prettyCombo(raw[0]) : "";
  };
  const scaleKeys = [comboLabel("subBigger"), comboLabel("subSmaller")]
    .filter(Boolean)
    .join(" / ");

  return (
    <div
      className={`sub-tune${open ? " open" : ""}`}
      ref={hostRef}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="sub-tune-btn"
        title={t("调整字幕")}
        aria-label={t("调整字幕")}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ALargeSmall size={17} />
      </button>
      {open && (
        <div className="sub-tune-pop" role="dialog" aria-label={t("调整字幕")}>
          <SubSizeSliders />
          <div className="sub-tune-row">
            <span>{t("显示")}</span>
            <Seg
              value={subtitleMode}
              options={[
                ["bilingual", t("双语")],
                ["translation", t("中文")],
                ["original", t("原文")],
              ]}
              onChange={(v) => void saveSettings({ subtitleMode: v })}
            />
          </div>
          <div className="sub-tune-row">
            <span>{t("样式")}</span>
            <Seg
              value={subtitleLook ?? "outline"}
              options={[
                ["box", t("半透明底")],
                ["outline", t("描边，无底")],
              ]}
              onChange={(v) => void saveSettings({ subtitleLook: v })}
            />
          </div>
          <p className="sub-tune-hint">
            {t("拖动字幕可以上下移动，双击字幕回到原位。")}
            {scaleKeys ? ` ${t("快捷键 {keys} 调大小。", { keys: scaleKeys })}` : ""}
          </p>
          <div className="sub-tune-foot">
            <button
              type="button"
              className="link-btn"
              disabled={!modified}
              onClick={() => resetSubtitleTuning()}
            >
              {t("恢复默认")}
            </button>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setOpen(false);
                if (useStore.getState().theater) toggleTheater(false);
                useStore.getState().set({ settingsOpen: true, settingsSection: "subtitles" });
              }}
            >
              {t("更多字幕设置…")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
