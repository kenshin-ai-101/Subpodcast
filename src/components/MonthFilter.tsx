/**
 * [INPUT]: Episode.published（Unix 秒）
 * [OUTPUT]: useMonthFilter / MonthFilter — 按年月热力筛选单集
 * [POS]: 节目页时间轴控件；与 ShowView 的筛选条并列
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import type { Episode } from "../lib/api";
import { monthLabel, monthName } from "../lib/format";
import { useT } from "../lib/i18n";

function monthKey(sec: number): string {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** 在「全部 / 未听 / 有字幕」结果上再叠一层月份过滤。 */
export function useMonthFilter(eps: Episode[] | null) {
  const [month, setMonth] = useState<string | null>(null);
  const filtered = useMemo(() => {
    if (!month || !eps) return eps;
    return eps.filter((e) => e.published != null && monthKey(e.published) === month);
  }, [eps, month]);
  return { month, setMonth, filtered };
}

/**
 * 一年十二格：有更新的月份可点选，再点取消；跨年用左右箭头切换。
 * 少于两月有内容时不渲染——没有筛选价值。
 */
export function MonthFilter({
  episodes,
  month,
  onChange,
}: {
  episodes: Episode[] | null;
  month: string | null;
  onChange: (m: string | null) => void;
}) {
  const t = useT();
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of episodes ?? []) {
      if (e.published == null) continue;
      const k = monthKey(e.published);
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return map;
  }, [episodes]);

  const years = useMemo(
    () => [...new Set([...counts.keys()].map((k) => Number(k.slice(0, 4))))].sort((a, b) => b - a),
    [counts],
  );

  const [year, setYear] = useState<number | null>(null);
  const y = year ?? (month ? Number(month.slice(0, 4)) : years[0]) ?? new Date().getFullYear();

  if (!episodes?.length || counts.size < 2) return null;

  const max = Math.max(...counts.values());
  const yearTotal = [...counts.entries()]
    .filter(([k]) => k.startsWith(`${y}-`))
    .reduce((n, [, c]) => n + c, 0);
  const idx = years.indexOf(y);

  return (
    <div className="month-filter" role="group" aria-label={t("按月份筛选")}>
      <div className="mf-head">
        <CalendarDays size={14} />
        <button
          type="button"
          className="icon-btn sm"
          disabled={idx < 0 || idx >= years.length - 1}
          onClick={() => setYear(years[idx + 1])}
          aria-label={t("上一年")}
        >
          <ChevronLeft size={14} />
        </button>
        <span className="mf-year">{y}</span>
        <button
          type="button"
          className="icon-btn sm"
          disabled={idx <= 0}
          onClick={() => setYear(years[idx - 1])}
          aria-label={t("下一年")}
        >
          <ChevronRight size={14} />
        </button>
        <span className="muted small">{t("{n} 期", { n: yearTotal })}</span>
        <span className="spacer" />
        {month && (
          <button type="button" className="chip sm on" onClick={() => onChange(null)}>
            {monthName(Number(month.slice(5)), true)} <X size={11} />
          </button>
        )}
      </div>
      <div className="mf-grid">
        {Array.from({ length: 12 }, (_, i) => {
          const k = `${y}-${String(i + 1).padStart(2, "0")}`;
          const n = counts.get(k) ?? 0;
          const heat = n ? 0.18 + 0.6 * (n / max) : 0;
          return (
            <button
              key={k}
              type="button"
              className={`mf-cell ${month === k ? "on" : ""} ${n / max > 0.6 ? "hot" : ""}`}
              disabled={!n}
              onClick={() => onChange(month === k ? null : k)}
              style={{ "--heat": heat } as React.CSSProperties}
              title={
                n
                  ? `${monthLabel(i + 1, y)} · ${t("{n} 期", { n })}`
                  : t("{month}没有节目", { month: monthLabel(i + 1) })
              }
            >
              <span className="mf-m">{monthName(i + 1)}</span>
              <span className="mf-n">{n || "·"}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
