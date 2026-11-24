/**
 * [INPUT]: store.settings 的阅读相关字段；lib/fonts
 * [OUTPUT]: SUB_SCALE / SUB_FONTS、useReadingSettings（根节点 --sub-scale / --chat-scale / --sub-font）
 * [POS]: 设置 › 字幕 的阅读项生效入口；消费者为 styles.css 中视频叠字 / 音频台 / 字幕列表 / 预览
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { loadCss, SUB_FONT_DEFS } from "./fonts";
import { resolveLocale } from "./i18n";
import { useStore } from "../store";

export const SUB_SCALE = { s: 0.86, m: 1, l: 1.18, xl: 1.38 } as const;
export const SUB_FONTS = { system: "system", serif: "serif", kai: "kai", sans: "sans" } as const;

export function useReadingSettings() {
  const s = useStore(
    useShallow((x) => ({
      subtitleSize: x.settings.subtitleSize,
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
    root.setProperty("--sub-scale", String(SUB_SCALE[s.subtitleSize ?? "m"]));
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
  }, [s.subtitleSize, s.subtitleFont, s.subtitleLook, s.chatSize, s.audioNextLine, s.theme, s.uiLang]);
}
