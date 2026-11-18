/**
 * [INPUT]: api.listeningStats、llmChat、settings、picks
 * [OUTPUT]: StatsView — 收听统计与可选 AI 画像
 * [POS]: 侧栏「收听统计」
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { api, errText, type ListenRow } from "../lib/api";
import { PICKS, showName } from "../lib/picks";
import type { Settings } from "../lib/settings";
import { useStore } from "../store";
import { Markdown } from "./Markdown";

const DAY = 86_400_000;
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const cjk = (s: string) => /[一-鿿]/.test(s);

function span(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
}

const dayLabel = (day: string) => {
  const d = new Date(`${day}T00:00:00`);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
};

type Range = "week" | "month" | "year" | "all";
const RANGES: [Range, string, number][] = [
  ["week", "近 7 天", 7],
  ["month", "近 30 天", 30],
  ["year", "近一年", 365],
  ["all", "全部", 3650],
];

const EQUIV = [
  { secs: 13 * 3600, one: "一次北京直飞纽约", many: (n: number) => `${n} 次北京直飞纽约`, basis: "按单程约 13 小时" },
  { secs: 4.5 * 3600, one: "一趟京沪高铁", many: (n: number) => `${n} 趟京沪高铁`, basis: "按单程约 4.5 小时" },
  { secs: 2 * 3600, one: "一部电影", many: (n: number) => `${n} 部电影`, basis: "按每部约 2 小时" },
  { secs: 4 * 60, one: "一首歌", many: (n: number) => `${n} 首歌`, basis: "按每首约 4 分钟" },
];

function equivalent(total: number) {
  const e = EQUIV.find((x) => total >= x.secs) ?? EQUIV[EQUIV.length - 1]!;
  const n = Math.round((total / e.secs) * 10) / 10;
  const text = n < 1.15 ? e.one : e.many(n >= 10 ? Math.round(n) : n);
  return { text, basis: e.basis };
}

const PERSONAS = [
  { from: 0, name: "深夜守灯人", line: "世界睡着的时候，你在听别人讲话。" },
  { from: 5, name: "晨读者", line: "一天还没开始，你已经先听了一段。" },
  { from: 9, name: "上午派", line: "你把最清醒的时间留给了耳朵。" },
  { from: 12, name: "午后漫步者", line: "午饭之后，是你和节目的约会。" },
  { from: 17, name: "归途听客", line: "天色暗下来，你在回家的路上听完一集。" },
  { from: 20, name: "夜航者", line: "夜里安静，最适合把一期长对谈听完。" },
];
const personaOf = (h: number) => [...PERSONAS].reverse().find((p) => h >= p.from)!;

function chatProvider(settings: Settings) {
  return settings.providers[settings.chatProvider];
}

async function portraitReady() {
  const settings = useStore.getState().settings;
  const p = chatProvider(settings);
  if (!p) return false;
  if (!p.needsKey) return true;
  return api.hasApiKey(p.id);
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat-tile">
      <span className="muted small">{label}</span>
      <b className="num">{value}</b>
      {sub && <span className="muted small">{sub}</span>}
    </div>
  );
}

function Clock({ hours, peak }: { hours: number[]; peak: number }) {
  const max = Math.max(1, ...hours);
  const c = 110;
  const r0 = 46;
  const len = 54;
  const inPeak = (h: number) => (h - peak + 24) % 24 < 3;
  return (
    <svg className="clock" viewBox="0 0 220 220" role="img" aria-label="收听时钟">
      <circle cx={c} cy={c} r={r0 - 6} className="clock-face" />
      {hours.map((v, h) => {
        const a = (h / 24) * Math.PI * 2 - Math.PI / 2 + Math.PI / 24;
        const l = v ? 6 + (len - 6) * Math.sqrt(v / max) : 3;
        return (
          <line
            key={h}
            x1={c + Math.cos(a) * r0}
            y1={c + Math.sin(a) * r0}
            x2={c + Math.cos(a) * (r0 + l)}
            y2={c + Math.sin(a) * (r0 + l)}
            className={`clock-bar ${v ? "" : "zero"} ${inPeak(h) && v ? "peak" : ""}`}
          >
            <title>{`${h}:00 · ${v ? span(v) : "没有收听"}`}</title>
          </line>
        );
      })}
      {[0, 6, 12, 18].map((h) => {
        const a = (h / 24) * Math.PI * 2 - Math.PI / 2;
        return (
          <text key={h} x={c + Math.cos(a) * (r0 - 16)} y={c + Math.sin(a) * (r0 - 16) + 4} className="clock-label">
            {h}
          </text>
        );
      })}
    </svg>
  );
}

function Topics({ topics }: { topics: Map<string, number> }) {
  const list = [...topics.entries()].sort((a, b) => b[1] - a[1]);
  const total = list.reduce((n, [, v]) => n + v, 0) || 1;
  return (
    <div className="topic-map">
      {list.map(([k, v], i) => (
        <div key={k} className={`topic-tile t${Math.min(i, 5)}`} style={{ flexGrow: v }} title={`${k} · ${span(v)}`}>
          <span className="topic-name">{k}</span>
          <span className="topic-pct num">{Math.round((v / total) * 100)}%</span>
        </div>
      ))}
    </div>
  );
}

function Ears({ weeks }: { weeks: { label: string; total: number; plain: number }[] }) {
  const has = weeks.filter((w) => w.total > 300);
  if (has.length < 2) return <p className="muted small">多听几周，这里会画出你不靠字幕的时间怎么变化。</p>;
  const share = (w: { total: number; plain: number }) => (w.total ? w.plain / w.total : 0);
  const first = share(has[0]!);
  const last = share(has[has.length - 1]!);
  return (
    <>
      <div className="ears">
        {weeks.map((w, i) => (
          <div
            key={i}
            className="ears-col"
            title={`${w.label} · ${w.total ? `${Math.round(share(w) * 100)}%` : "没有收听"}`}
          >
            <span className="ears-bar" style={{ height: `${Math.max(w.total ? 4 : 0, share(w) * 100)}%` }} />
            <span className="ears-x">{i % 3 === 0 ? w.label : ""}</span>
          </div>
        ))}
      </div>
      <p className="muted small ears-note">
        {last > first + 0.05
          ? `不开中文字幕听的比例，从 ${Math.round(first * 100)}% 升到了 ${Math.round(last * 100)}%。耳朵在悄悄变好。`
          : "柱子是每周不开中文字幕听外语节目的比例。字幕是拐杖，也是梯子。"}
      </p>
    </>
  );
}

function Heatmap({ byDay }: { byDay: Map<string, number> }) {
  const today = new Date();
  const start = new Date(today.getTime() - 364 * DAY);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const cells: { day: string; secs: number; future: boolean }[] = [];
  for (let d = new Date(start); ; d = new Date(d.getTime() + DAY)) {
    cells.push({ day: ymd(d), secs: byDay.get(ymd(d)) ?? 0, future: d > today });
    if (d > today && ((d.getDay() + 6) % 7) === 6) break;
    if (cells.length > 380) break;
  }
  const level = (s: number) => (s <= 0 ? 0 : s < 900 ? 1 : s < 1800 ? 2 : s < 3600 ? 3 : 4);
  const months: { col: number; label: string }[] = [];
  cells.forEach((c, i) => {
    if (i % 7 === 0) {
      const d = new Date(`${c.day}T00:00:00`);
      if (d.getDate() <= 7) months.push({ col: i / 7, label: `${d.getMonth() + 1}月` });
    }
  });
  return (
    <div className="heatmap-wrap">
      <div className="heatmap-months" style={{ gridTemplateColumns: `repeat(${Math.ceil(cells.length / 7)}, 1fr)` }}>
        {months.map((m) => (
          <span key={m.col} style={{ gridColumn: `${m.col + 1} / span 4` }}>
            {m.label}
          </span>
        ))}
      </div>
      <div className="heatmap" style={{ gridTemplateColumns: `repeat(${Math.ceil(cells.length / 7)}, 1fr)` }}>
        {cells.map((c) => (
          <span
            key={c.day}
            className={`hm l${level(c.secs)} ${c.future ? "future" : ""}`}
            title={c.future ? "" : `${c.day} · ${c.secs ? span(c.secs) : "没有收听"}`}
          />
        ))}
      </div>
      <div className="heatmap-legend muted small">
        少
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className={`hm l${l}`} />
        ))}
        多
      </div>
    </div>
  );
}

function Portrait({ rows, range, rangeName }: { rows: ListenRow[]; range: Range; rangeName: string }) {
  const settings = useStore((s) => s.settings);
  const provider = chatProvider(settings);
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState<boolean | null>(null);

  useEffect(() => {
    void portraitReady().then(setReady);
  }, [settings.chatProvider, settings.chatModel]);

  useEffect(() => {
    setText(null);
    setError("");
    void api.getBlob("stats", `portrait-${range}`).then((v) => setText(v || null));
  }, [range]);

  const brief = () => {
    const shows = new Map<string, number>();
    const titles = new Map<string, number>();
    const hours = Array(24).fill(0) as number[];
    for (const r of rows) {
      shows.set(r.showTitle || "单集", (shows.get(r.showTitle || "单集") ?? 0) + r.seconds);
      titles.set(r.episodeTitle, (titles.get(r.episodeTitle) ?? 0) + r.seconds);
      hours[r.hour] += r.seconds;
    }
    const top = <K,>(m: Map<K, number>, n: number) =>
      [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([k, v]) => `${k}（${Math.round(v / 60)} 分钟）`);
    return `时间范围：${rangeName}\n节目：${top(shows, 8).join("；")}\n单集标题：${top(titles, 25).join("；")}\n每小时收听分钟：${hours.map((v) => Math.round(v / 60)).join(",")}`;
  };

  const run = async () => {
    if (!provider) return;
    setBusy(true);
    setError("");
    try {
      const model = settings.chatModel || provider.model;
      const out = await api.llmChat({
        provider: provider.id,
        baseUrl: provider.baseUrl,
        model,
        protocol: provider.protocol,
        messages: [
          {
            role: "user",
            content: `${brief()}\n\n请根据收听数据写一段中文收听画像：第一行 4–8 字称号（加粗）；第二行 3 个兴趣标签用「·」分隔；然后 80–140 字画像；最后一行以「下一步：」开头给建议。只依据数据，不编造。`,
          },
        ],
      });
      if (!out.trim()) throw new Error("模型没有返回内容");
      setText(out);
      await api.setBlob("stats", `portrait-${range}`, out);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="stats-card portrait">
      <div className="stats-card-h">
        <h2>
          <Sparkles size={14} className="accent" /> AI 收听画像
        </h2>
        {text && !busy && (
          <button type="button" className="link-btn small" onClick={() => void run()}>
            <RefreshCw size={12} /> 重新生成
          </button>
        )}
      </div>
      {busy ? (
        <p className="muted small">
          <Loader2 size={13} className="spin" /> 正在读你的收听…
        </p>
      ) : text ? (
        <div className="portrait-text">
          <Markdown text={text} onSeek={() => {}} />
        </div>
      ) : ready === false ? (
        <p className="muted small">
          在设置里配好模型后，可以让 AI 读一读你的收听，写一段只属于你的画像。{" "}
          <button
            type="button"
            className="link-btn small"
            onClick={() => useStore.getState().set({ settingsOpen: true, settingsSection: "ai" })}
          >
            去设置
          </button>
        </p>
      ) : (
        <div className="portrait-cta">
          <p className="muted small">
            会把节目名、单集标题和收听时段发给{provider ? ` ${provider.name}` : "你选的模型"}，只在点按钮时发送。
          </p>
          <button type="button" className="btn primary sm" onClick={() => void run()} disabled={!ready}>
            生成我的收听画像
          </button>
        </div>
      )}
      {error && <p className="error-text small">{error}</p>}
    </section>
  );
}

export function StatsView() {
  const { go, shows: subscribed } = useStore(useShallow((s) => ({ go: s.go, shows: s.shows })));
  const [rows, setRows] = useState<ListenRow[] | null>(null);
  const [range, setRange] = useState<Range>("month");

  useEffect(() => {
    void api.listeningStats(ymd(new Date(Date.now() - 3650 * DAY))).then(setRows).catch(() => setRows([]));
  }, []);

  const s = useMemo(() => {
    if (!rows) return null;
    const days = RANGES.find((r) => r[0] === range)![2];
    const since = ymd(new Date(Date.now() - (days - 1) * DAY));
    const inRange = rows.filter((r) => r.day >= since);
    const total = inRange.reduce((n, r) => n + r.seconds, 0);
    const translated = inRange.filter((r) => r.translated).reduce((n, r) => n + r.seconds, 0);

    const eps = new Map<string, { duration: number; progress: number; secs: number; title: string }>();
    for (const r of inRange) {
      const e = eps.get(r.episodeId) ?? { duration: r.duration, progress: r.progress, secs: 0, title: r.episodeTitle };
      e.secs += r.seconds;
      eps.set(r.episodeId, e);
    }
    const heard = [...eps.values()].filter((e) => e.secs > 60);
    const finished = heard.filter((e) => e.duration > 0 && e.progress >= e.duration * 0.9);

    const byDay = new Map<string, number>();
    for (const r of rows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.seconds);
    let streak = 0;
    for (let d = new Date(), first = true; ; d = new Date(d.getTime() - DAY), first = false) {
      if ((byDay.get(ymd(d)) ?? 0) >= 300) streak++;
      else if (!first) break;
      if (streak > 3650) break;
    }
    let best = 0;
    let run = 0;
    let prev = "";
    for (const day of [...byDay.keys()].filter((d) => (byDay.get(d) ?? 0) >= 300).sort()) {
      run = prev && ymd(new Date(new Date(`${prev}T00:00:00`).getTime() + DAY)) === day ? run + 1 : 1;
      best = Math.max(best, run);
      prev = day;
    }

    const shows = new Map<string, { id: string; title: string; cover: string; seconds: number; episodes: Set<string>; single: boolean; first: string }>();
    for (const r of inRange) {
      const single = !r.showTitle || r.showId === "single";
      const key = single ? `ep:${r.episodeId}` : r.showId;
      const x = shows.get(key) ?? {
        id: single ? "" : r.showId,
        title: single ? r.episodeTitle : r.showTitle,
        cover: r.cover,
        seconds: 0,
        episodes: new Set<string>(),
        single,
        first: r.day,
      };
      x.seconds += r.seconds;
      x.episodes.add(r.episodeId);
      shows.set(key, x);
    }
    const top = [...shows.values()]
      .map((x) => ({ ...x, cover: x.cover || subscribed.find((sh) => sh.id === x.id)?.cover || "" }))
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 6);

    const topics = new Map<string, number>();
    for (const r of inRange) {
      const pick = PICKS.find(
        (p) => p.title === r.showTitle || p.channel === r.showTitle || p.zh === r.showTitle,
      );
      const topic = pick?.topics[0] ?? "其他";
      topics.set(topic, (topics.get(topic) ?? 0) + r.seconds);
    }

    const hours = Array(24).fill(0) as number[];
    let weekday = 0;
    let weekend = 0;
    const weekdayDays = new Set<string>();
    const weekendDays = new Set<string>();
    for (const r of inRange) {
      hours[r.hour] += r.seconds;
      const wd = new Date(`${r.day}T00:00:00`).getDay();
      if (wd === 0 || wd === 6) {
        weekend += r.seconds;
        weekendDays.add(r.day);
      } else {
        weekday += r.seconds;
        weekdayDays.add(r.day);
      }
    }
    let peak = 0;
    for (let h = 0; h < 24; h++) {
      const sum = hours[h]! + hours[(h + 1) % 24]! + hours[(h + 2) % 24]!;
      const peakSum = hours[peak]! + hours[(peak + 1) % 24]! + hours[(peak + 2) % 24]!;
      if (sum > peakSum) peak = h;
    }

    const weeks: { label: string; total: number; plain: number }[] = [];
    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    for (let i = 11; i >= 0; i--) {
      const start = new Date(monday.getTime() - i * 7 * DAY);
      const end = new Date(start.getTime() + 7 * DAY);
      const w = rows.filter((r) => r.day >= ymd(start) && r.day < ymd(end) && !cjk(r.episodeTitle));
      weeks.push({
        label: `${start.getMonth() + 1}/${start.getDate()}`,
        total: w.reduce((n, r) => n + r.seconds, 0),
        plain: w.filter((r) => !r.translated).reduce((n, r) => n + r.seconds, 0),
      });
    }

    const foreign = inRange.filter((r) => !cjk(r.episodeTitle)).reduce((n, r) => n + r.seconds, 0);
    const facts: { big: string; line: string }[] = [];
    const longest = [...new Set(inRange.map((r) => r.day))]
      .map((d) => [d, inRange.filter((r) => r.day === d).reduce((n, r) => n + r.seconds, 0)] as const)
      .sort((a, b) => b[1] - a[1])[0];
    if (longest && longest[1] >= 1200) {
      facts.push({ big: span(longest[1]), line: `${dayLabel(longest[0])}是你听得最久的一天。` });
    }
    if (best >= 3) facts.push({ big: `${best} 天`, line: `你最长连续 ${best} 天每天都听了至少 5 分钟。` });

    return {
      total,
      translated,
      heard: heard.length,
      finished: finished.length,
      streak,
      best,
      top,
      topics,
      hours,
      peak,
      weekdayDays: weekdayDays.size,
      weekendDays: weekendDays.size,
      weekday,
      weekend,
      weeks,
      foreign,
      facts,
      byDay,
      inRange,
    };
  }, [rows, range, subscribed]);

  if (!rows || !s) return <div className="page stats" />;
  if (!rows.length) {
    return (
      <div className="page stats">
        <h1 className="page-title">收听统计</h1>
        <p className="muted">还没有收听记录。从这一版开始，听过的每一分钟都会记在这里，只存在你的电脑上。</p>
        <button type="button" className="btn primary" onClick={() => go({ kind: "home" })}>
          去听一集
        </button>
      </div>
    );
  }

  const rangeName = RANGES.find((r) => r[0] === range)![1];
  const eq = equivalent(s.total);
  const words = Math.round((s.foreign / 60) * 150);
  const persona = personaOf(s.peak);
  const perWeekday = s.weekdayDays ? s.weekday / s.weekdayDays : 0;
  const perWeekend = s.weekendDays ? s.weekend / s.weekendDays : 0;

  return (
    <div className="page stats">
      <div className="stats-head">
        <h1 className="page-title">收听统计</h1>
        <div className="seg-control" role="radiogroup">
          {RANGES.map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={range === k}
              className={range === k ? "on" : ""}
              onClick={() => setRange(k)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {s.total < 60 ? (
        <p className="stats-lede">{rangeName}还没有收听。挑一集，从这里开始。</p>
      ) : (
        <section className="stats-lede-card">
          <p className="stats-lede">
            {rangeName}，你听了 <b>{span(s.total)}</b>，相当于 <b title={eq.basis}>{eq.text}</b>。
          </p>
          {words >= 1000 && (
            <p className="stats-lede-sub" title="按对谈每分钟约 150 个英文单词估算">
              你的耳朵大约接住了 {words.toLocaleString()} 个外语单词。
            </p>
          )}
          <div className="stat-tiles">
            <Tile label="听过的单集" value={`${s.heard} 集`} sub={s.finished ? `听完 ${s.finished} 集` : undefined} />
            <Tile
              label="借助字幕"
              value={`${Math.round((s.translated / Math.max(1, s.total)) * 100)}%`}
              sub="开着中文或双语字幕"
            />
            <Tile label="连续收听" value={`${s.streak} 天`} sub={s.best > s.streak ? `最长 ${s.best} 天` : "每天至少 5 分钟"} />
            <Tile
              label="外语时间"
              value={span(s.foreign)}
              sub={`占 ${Math.round((s.foreign / Math.max(1, s.total)) * 100)}%`}
            />
          </div>
        </section>
      )}

      {s.total >= 60 && (
        <>
          <div className="stats-grid">
            <section className="stats-card">
              <div className="stats-card-h">
                <h2>你把时间给了谁</h2>
              </div>
              <ol className="top-shows">
                {s.top.map((x, i) => (
                  <li
                    key={x.id || x.title}
                    role="button"
                    tabIndex={0}
                    onClick={() => x.id && go({ kind: "show", id: x.id })}
                    onKeyDown={(e) => e.key === "Enter" && x.id && go({ kind: "show", id: x.id })}
                  >
                    <span className="top-rank num">{i + 1}</span>
                    {x.cover ? <img src={x.cover} alt="" loading="lazy" /> : <span className="top-ph" />}
                    <span className="top-name">
                      <span className="top-title">
                        <span className="clamp1">{x.single ? x.title : showName(x.title)}</span>
                        {x.single && <em className="top-badge plain">单集</em>}
                      </span>
                      <span className="top-bar">
                        <span style={{ width: `${(x.seconds / (s.top[0]?.seconds || 1)) * 100}%` }} />
                      </span>
                      <span className="top-meta muted small">{x.episodes.size} 集</span>
                    </span>
                    <span className="top-time small num">{span(x.seconds)}</span>
                  </li>
                ))}
              </ol>
            </section>
            <section className="stats-card clock-card">
              <div className="stats-card-h">
                <h2>你的收听生物钟</h2>
              </div>
              <Clock hours={s.hours} peak={s.peak} />
              <p className="persona">
                <b>{persona.name}</b>
              </p>
              <p className="muted small persona-line">
                {persona.line} 最常在 {s.peak}:00–{(s.peak + 3) % 24}:00 之间听。
              </p>
              {perWeekday > 0 && perWeekend > 0 && (
                <p className="muted small persona-line">
                  {perWeekend > perWeekday * 1.15
                    ? `周末平均每天比工作日多听 ${Math.round((perWeekend / perWeekday - 1) * 100)}%。`
                    : perWeekday > perWeekend * 1.15
                      ? `工作日平均每天比周末多听 ${Math.round((perWeekday / perWeekend - 1) * 100)}%。`
                      : "工作日和周末听得差不多多。"}
                </p>
              )}
            </section>
          </div>

          {s.facts.length > 0 && (
            <section className="facts">
              {s.facts.map((f, i) => (
                <div key={i} className="fact">
                  <b className="num">{f.big}</b>
                  <p>{f.line}</p>
                </div>
              ))}
            </section>
          )}

          <div className="stats-grid">
            <section className="stats-card">
              <div className="stats-card-h">
                <h2>话题版图</h2>
                <span className="muted small">按节目归类</span>
              </div>
              <Topics topics={s.topics} />
            </section>
            <section className="stats-card">
              <div className="stats-card-h">
                <h2>耳朵的成长</h2>
                <span className="muted small">近 12 周</span>
              </div>
              <Ears weeks={s.weeks} />
            </section>
          </div>

          <Portrait rows={s.inRange} range={range} rangeName={rangeName} />
        </>
      )}

      <section className="stats-card">
        <div className="stats-card-h">
          <h2>一年的样子</h2>
          <span className="muted small">每一格是一天</span>
        </div>
        <Heatmap byDay={s.byDay} />
      </section>
      <p className="muted small stats-foot">只统计真正在播放的时间，拖动进度条不算。数据只保存在这台电脑上。</p>
    </div>
  );
}