/**
 * [INPUT]: store.settings 的阅读与字幕样式字段；lib/fonts；lib/i18n
 * [OUTPUT]: SUB_SCALE / SUB_FONTS / SCALE_MIN / SCALE_MAX；字号与位移读写；useReadingSettings
 * [POS]: 统一向根节点注入 --sub-scale / --sub-orig-scale / --sub-lift / --chat-scale / --sub-font，供视频叠字、音频台、字幕栏与预览共用
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { loadCss, SUB_FONT_DEFS } from "./fonts";
import { resolveLocale, tNow } from "./i18n";
import type { Settings } from "./settings";
import { useStore } from "../store";

export const SUB_SCALE = { s: 0.86, m: 1, l: 1.18, xl: 1.38 } as const;
export const SUB_FONTS = { system: "system", serif: "serif", kai: "kai", sans: "sans" } as const;

export const SCALE_MIN = 0.7;
export const SCALE_MAX = 2.0;
export const LIFT_MIN = -4;
export const LIFT_MAX = 70;

export function clampScale(value: number): number {
  const bounded = Math.min(SCALE_MAX, Math.max(SCALE_MIN, value));
  return Math.round(bounded * 20) / 20;
}

export function clampLift(value: number): number {
  const bounded = Math.min(LIFT_MAX, Math.max(LIFT_MIN, value));
  return Math.round(bounded * 10) / 10;
}

/** 生效中的中文字幕倍率：优先连续值，否则回退四档预设。 */
export function resolveSubScale(
  s: Pick<Settings, "subtitleScale" | "subtitleSize">,
): number {
  return s.subtitleScale ?? SUB_SCALE[s.subtitleSize ?? "m"];
}

/** 生效中的原文字幕倍率：独立设过则用独立值，否则跟随中文。 */
export function resolveOrigScale(
  s: Pick<Settings, "subtitleScale" | "subtitleSize" | "subtitleOrigScale">,
): number {
  return s.subtitleOrigScale ?? resolveSubScale(s);
}

/** 调整中文字幕倍率（未独立调过原文时，原文自然跟随）。 */
export function updateSubScale(value: number): number {
  const next = clampScale(value);
  void useStore.getState().saveSettings({ subtitleScale: next }, true);
  return next;
}

/** 独立调整原文字幕倍率。 */
export function updateOrigScale(value: number): number {
  const next = clampScale(value);
  void useStore.getState().saveSettings({ subtitleOrigScale: next }, true);
  return next;
}

/** 快捷键 ⌘= / ⌘- 同步步进字幕大小，并弹轻提示。 */
export function stepSubScale(direction: 1 | -1): number {
  const st = useStore.getState();
  const s = st.settings;
  const nextZh = clampScale(resolveSubScale(s) + direction * 0.1);
  const patch: Partial<Settings> = { subtitleScale: nextZh };
  if (s.subtitleOrigScale != null) {
    patch.subtitleOrigScale = clampScale(s.subtitleOrigScale + direction * 0.1);
  }
  void st.saveSettings(patch, true);
  st.notify(tNow("字幕大小 {n}%", { n: Math.round(nextZh * 100) }));
  return nextZh;
}

/** 拖拽视频叠字幕更新垂直位置（单位 cqh）。 */
export function updateSubLift(value: number): number {
  const next = clampLift(value);
  void useStore.getState().saveSettings({ subtitleLift: next }, true);
  return next;
}

/** 重置画中调过的字号与垂直位置。 */
export function resetSubtitleTuning() {
  void useStore.getState().saveSettings({
    subtitleScale: undefined,
    subtitleOrigScale: undefined,
    subtitleLift: undefined,
  });
}

export function useReadingSettings() {
  const s = useStore(
    useShallow((x) => ({
      subtitleSize: x.settings.subtitleSize,
      subtitleScale: x.settings.subtitleScale,
      subtitleOrigScale: x.settings.subtitleOrigScale,
      subtitleLift: x.settings.subtitleLift,
      subtitleFont: x.settings.subtitleFont,
      subtitleLook: x.settings.subtitleLook,
      chatSize: x.settings.chatSize,
      audioNextLine: x.settings.audioNextLine,
      theme: x.settings.theme ?? "system",
      uiLang: x.settings.uiLang,
    })),
  );
  useEffect(() => {
    const html = document.documentElement;
    const root = html.style;
    root.setProperty("--sub-scale", String(resolveSubScale(s)));
    root.setProperty("--sub-orig-scale", String(resolveOrigScale(s)));
    root.setProperty("--sub-lift", `${s.subtitleLift ?? 0}cqh`);
    root.setProperty("--chat-scale", s.chatSize === "l" ? "1.12" : "1");
    const f = SUB_FONT_DEFS.find((x) => x.id === (s.subtitleFont ?? "sans"));
    if (f?.css) void loadCss(f.css).catch(() => {});
    root.setProperty("--sub-font", f && f.id !== "system" ? `${f.family}, var(--font)` : "inherit");
    html.dataset.subLook = s.subtitleLook ?? "outline";
    html.dataset.nextLine = s.audioNextLine ? "on" : "off";
    if (s.theme === "light" || s.theme === "dark") {
      html.dataset.theme = s.theme;
    } else {
      delete html.dataset.theme;
    }
    html.lang = resolveLocale(s.uiLang);
  }, [
    s.subtitleSize,
    s.subtitleScale,
    s.subtitleOrigScale,
    s.subtitleLift,
    s.subtitleFont,
    s.subtitleLook,
    s.chatSize,
    s.audioNextLine,
    s.theme,
    s.uiLang,
  ]);
}
