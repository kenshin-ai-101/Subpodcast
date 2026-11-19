/**
 * [INPUT]: words.log / words；dayOf / isMastered
 * [OUTPUT]: LearnStats（连续天数、近 7 天、记住率、掌握数 + 可点热力）
 * [POS]: 生词本列表页顶部统计；点一天可打开当日词
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Flame } from "lucide-react";
import { dayOf, isMastered, useWords, type DayLog, type Word } from "../lib/words";

const DAY_MS = 86_400_000;
const CELL = 11;
const GAP = 3;
const LABEL_W = 22;

type DayBucket = { r: number; a: number; reviewed: string[]; added: string[] };

function buckets(words: Record<string, Word>, log: Record<string, DayLog>): Map<string, DayBucket> {
  const map = new Map<string, DayBucket>();
  const at = (d: string) => {
    let b = map.get(d);
    if (!b) {
      b = { r: 0, a: 0, reviewed: [], added: [] };
      map.set(d, b);
    }
    return b;
  };
  for (const [d, row] of Object.entries(log)) {
    const b = at(d);
    b.r += row.r;
    b.a += row.a;
    b.reviewed.push(...row.ids);
  }
  for (const w of Object.values(words)) at(dayOf(w.added)).added.push(w.id);
  return map;
}

const heat = (n: number) => (n === 0 ? 0 : n < 3 ? 1 : n < 10 ? 2 : n < 20 ? 3 : 4);

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return +d;
};

/** 连续有学习的天数；今天尚无记录时从昨天起算。 */
function streakDays(days: Map<string, DayBucket>, now: number): number {
  let n = 0;
  let at = startOfDay(now);
  if (!days.has(dayOf(at))) at -= DAY_MS;
  while (days.has(dayOf(at))) {
    n++;
    at = startOfDay(at - DAY_MS / 2);
  }
  return n;
}

export function LearnStats({ onOpen }: { onOpen: (id: string) => void }) {
  const { words, log } = useWords(useShallow((s) => ({ words: s.words, log: s.log })));
  const box = useRef<HTMLDivElement>(null);
  const [weeks, setWeeks] = useState(26);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () =>
      setWeeks(Math.max(8, Math.min(53, Math.floor((el.clientWidth - 8 - LABEL_W + GAP) / (CELL + GAP)))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const now = Date.now();
  const today = dayOf(now);
  const days = useMemo(() => buckets(words, log), [words, log]);

  const stats = useMemo(() => {
    let week = 0;
    let r30 = 0;
    let a30 = 0;
    for (let i = 0; i < 30; i++) {
      const d = days.get(dayOf(now - i * DAY_MS));
      if (!d) continue;
      if (i < 7) week += d.r;
      r30 += d.r;
      a30 += d.a;
    }
    return {
      streak: streakDays(days, now),
      week,
      kept: r30 >= 10 ? Math.round((1 - a30 / r30) * 100) : null,
      mastered: Object.values(words).filter(isMastered).length,
      total: Object.keys(words).length,
    };
  }, [days, words, today]);

  const grid = useMemo(() => {
    const t0 = new Date(startOfDay(now));
    const monday = +t0 - ((t0.getDay() + 6) % 7) * DAY_MS;
    const first = startOfDay(monday - (weeks - 1) * 7 * DAY_MS + DAY_MS / 2);
    const monthFmt = new Intl.DateTimeFormat("zh-CN", { month: "short" });
    const cols: { days: { key: string; n: number; future: boolean }[]; month?: string }[] = [];
    for (let c = 0; c < weeks; c++) {
      const col: (typeof cols)[number] = { days: [] };
      for (let r = 0; r < 7; r++) {
        const ms = startOfDay(first + (c * 7 + r) * DAY_MS + DAY_MS / 2);
        const key = dayOf(ms);
        const d = days.get(key);
        col.days.push({ key, n: d ? d.r + d.added.length : 0, future: ms > now });
        if (new Date(ms).getDate() === 1 && c > 0) col.month = monthFmt.format(ms);
      }
      cols.push(col);
    }
    return cols;
  }, [days, weeks, today]);

  const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "narrow" });
  const dayLabel = (key: string) =>
    new Date(`${key}T12:00:00`).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" });

  const tip = (key: string) => {
    const d = days.get(key);
    const label = dayLabel(key);
    if (!d) return `${label}：没有学习`;
    const r = d.r;
    const n = d.added.length;
    if (r && n) return `${label}：复习 ${r} 次，新加 ${n} 个词`;
    if (r) return `${label}：复习 ${r} 次`;
    return `${label}：新加 ${n} 个词`;
  };

  const sel = picked ? days.get(picked) : null;
  const chips = sel ? [...new Set([...sel.added, ...sel.reviewed])].filter((id) => words[id]) : [];

  return (
    <section className="hm-box">
      <div className="hm-nums">
        <div className="hm-num">
          <span className="hm-v">
            {stats.streak > 0 && <Flame size={16} className="hm-fire" />}
            {stats.streak}
          </span>
          <span className="hm-k">连续学习（天）</span>
        </div>
        <div className="hm-num">
          <span className="hm-v">{stats.week}</span>
          <span className="hm-k">近 7 天复习</span>
        </div>
        <div className="hm-num">
          <span className="hm-v">{stats.kept == null ? "—" : `${stats.kept}%`}</span>
          <span className="hm-k" title="近 30 天复习时没有选「忘了」的比例（至少复习 10 次后显示）">
            记住率
          </span>
        </div>
        <div className="hm-num">
          <span className="hm-v">
            {stats.mastered}
            <span className="hm-of"> / {stats.total}</span>
          </span>
          <span className="hm-k">已掌握</span>
        </div>
      </div>
      <div className="hm-map" ref={box}>
        <div className="hm-months" style={{ paddingLeft: LABEL_W }}>
          {grid.map((c, i) => (
            <span key={i} style={{ width: CELL + GAP }}>
              {c.month ?? ""}
            </span>
          ))}
        </div>
        <div className="hm-body">
          <div className="hm-wd" style={{ width: LABEL_W }}>
            {[0, 1, 2, 3, 4, 5, 6].map((r) => (
              <span key={r}>{r % 2 === 0 && r < 6 ? weekday.format(new Date(2024, 0, 1 + r)) : ""}</span>
            ))}
          </div>
          {grid.map((c, i) => (
            <div key={i} className="hm-col">
              {c.days.map((d) =>
                d.future ? (
                  <span key={d.key} className="hm-cell future" />
                ) : (
                  <button
                    key={d.key}
                    type="button"
                    className={`hm-cell l${heat(d.n)} ${d.key === today ? "today" : ""} ${d.key === picked ? "on" : ""}`}
                    title={tip(d.key)}
                    aria-label={tip(d.key)}
                    onClick={() => setPicked(picked === d.key ? null : d.key)}
                  />
                ),
              )}
            </div>
          ))}
        </div>
        <div className="hm-legend">
          <span>少</span>
          {[0, 1, 2, 3, 4].map((l) => (
            <span key={l} className={`hm-cell l${l}`} />
          ))}
          <span>多</span>
        </div>
      </div>
      {picked && (
        <div className="hm-day">
          <span className="hm-day-h">{tip(picked)}</span>
          {chips.length > 0 && (
            <div className="hm-chips">
              {chips.map((id) => (
                <button key={id} type="button" className="hm-chip" onClick={() => onOpen(id)}>
                  {id}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
