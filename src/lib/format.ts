/**
 * [INPUT]: Unix 秒时间戳、时长秒、可选 HTML 简介
 * [OUTPUT]: date / duration / clock / parseClock / groupLabel / monthName / monthLabel / plainText
 * [POS]: 展示格式化，无业务状态；月份文案供 MonthFilter 与单集分组共用
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { resolveLocale, tNow } from "./i18n";
import { useStore } from "../store";

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function date(ts?: number | null): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return tNow("今天");
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return tNow("昨天");
  const loc = resolveLocale(useStore.getState().settings.uiLang);
  if (d.getFullYear() === now.getFullYear()) {
    if (loc === "en") return `${EN_MONTHS[d.getMonth()]} ${d.getDate()}`;
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function duration(sec?: number | null): string {
  if (!sec || sec <= 0) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return tNow("{h} 小时 {m} 分钟", { h, m });
  return tNow("{m} 分钟", { m: Math.max(1, m) });
}

export function clock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 解析 `m:ss` / `h:mm:ss`；非法返回 null。 */
export function parseClock(text: string): number | null {
  const m = text.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const a = +m[1];
  const b = +m[2];
  const c = m[3] != null ? +m[3] : null;
  if (c != null) {
    if (b >= 60 || c >= 60) return null;
    return a * 3600 + b * 60 + c;
  }
  if (b >= 60) return null;
  return a * 60 + b;
}

export function groupLabel(sec?: number | null): string {
  if (!sec) return tNow("更早");
  const d = new Date(sec * 1000);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return tNow("今天");
  if (diff === 1) return tNow("昨天");
  if (diff < 7) return tNow("本周");
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return tNow("本月");
  return monthLabel(d.getMonth() + 1, d.getFullYear() === now.getFullYear() ? undefined : d.getFullYear());
}

/** 日历格：`3月` / 选中芯片用 `3 月`；英文返回 `Mar`。 */
export function monthName(m: number, spaced = false): string {
  const loc = resolveLocale(useStore.getState().settings.uiLang);
  if (loc === "en") return EN_MONTHS[m - 1] ?? String(m);
  return spaced ? `${m} 月` : `${m}月`;
}

/** 分组标题：`3 月` / `2025 年 3 月`；英文返回 `Mar` / `Mar 2025`。 */
export function monthLabel(m: number, year?: number): string {
  const loc = resolveLocale(useStore.getState().settings.uiLang);
  if (loc === "en") {
    const name = EN_MONTHS[m - 1] ?? String(m);
    return year ? `${name} ${year}` : name;
  }
  return year ? `${year} 年 ${m} 月` : `${m} 月`;
}

/** 节目简介：剥 HTML，保留段落断行，截断到合理长度。 */
export function plainText(html?: string | null, max = 1500): string {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(
    html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d)>/gi, "\n"),
    "text/html",
  );
  return (doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}
