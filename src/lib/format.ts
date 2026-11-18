/**
 * [INPUT]: Unix 秒时间戳、时长秒、可选 HTML 简介
 * [OUTPUT]: date / duration / clock / groupLabel / monthName / monthLabel / plainText
 * [POS]: 展示格式化，无业务状态；月份文案供 MonthFilter 与单集分组共用
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export function date(ts?: number | null): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "今天";
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "昨天";
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function duration(sec?: number | null): string {
  if (!sec || sec <= 0) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h} 小时 ${m} 分钟`;
  return `${Math.max(1, m)} 分钟`;
}

export function clock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function groupLabel(sec?: number | null): string {
  if (!sec) return "更早";
  const d = new Date(sec * 1000);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff < 7) return "本周";
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return "本月";
  return monthLabel(d.getMonth() + 1, d.getFullYear() === now.getFullYear() ? undefined : d.getFullYear());
}

/** 日历格：`3月` / 选中芯片用 `3 月`。 */
export function monthName(m: number, spaced = false): string {
  return spaced ? `${m} 月` : `${m}月`;
}

/** 分组标题：`3 月` / `2025 年 3 月`。 */
export function monthLabel(m: number, year?: number): string {
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
