/**
 * [INPUT]: settings.uiLang、src/locales/{zh-TW,en}.json
 * [OUTPUT]: resolveLocale、t(key, vars?)、useT() — 轻量零依赖三语国际化引擎
 * [POS]: 简体中文为基准 key（零查表开销）；繁體中文与 English 查静态词典
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useCallback } from "react";
import type { LangSetting } from "./settings";
import zhTW from "../locales/zh-TW.json";
import en from "../locales/en.json";
import { useStore } from "../store";

export type Locale = "zh-CN" | "zh-TW" | "en";

const DICTS: Record<Exclude<Locale, "zh-CN">, Record<string, string>> = {
  "zh-TW": zhTW,
  en,
};

export function resolveLocale(setting?: LangSetting): Locale {
  if (setting === "zh-CN" || setting === "zh-TW" || setting === "en") return setting;
  const nav = (typeof navigator !== "undefined" ? navigator.language : "zh-CN").toLowerCase();
  if (nav.startsWith("zh-tw") || nav.startsWith("zh-hk") || nav.startsWith("zh-hant")) return "zh-TW";
  if (nav.startsWith("zh")) return "zh-CN";
  return "en";
}

function interpolate(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}

export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const raw = locale === "zh-CN" ? key : (DICTS[locale][key] ?? key);
  return interpolate(raw, vars);
}

/** 响应式翻译函数；随 settings.uiLang 变更即时重渲。 */
export function useT() {
  const uiLang = useStore((s) => s.settings.uiLang);
  const locale = resolveLocale(uiLang);
  return useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale],
  );
}

/** 非组件场景使用的即时翻译函数。 */
export function tNow(key: string, vars?: Record<string, string | number>): string {
  return translate(resolveLocale(useStore.getState().settings.uiLang), key, vars);
}
