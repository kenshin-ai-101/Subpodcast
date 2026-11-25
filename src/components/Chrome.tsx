/**
 * [INPUT]: store、api、layout（sideOpen → rail、subsOpen → 订阅折叠、subsAll → 长列表展开）；fuzzy；Show.episodeCount
 * [OUTPUT]: Sidebar（首页/发现/统计/生词本；订阅折叠展开与模糊检索；>12 档时短列表+「显示全部」；收起为图标轨；订阅角标=单集总数）/ TopBar / Toast
 * [POS]: 全局导航与搜索订阅入口
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  BookMarked,
  ChartColumn,
  ChevronDown,
  ChevronLeft,
  Clock,
  Compass,
  Inbox,
  Link2,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings as Cog,
  X,
} from "lucide-react";
import { api, errText, type Show } from "../lib/api";
import { looksLikeLink, sameFeed } from "../lib/feeds";
import { filterFuzzy } from "../lib/fuzzy";
import { useT } from "../lib/i18n";
import { useLayout } from "../lib/layout";
import { PICKS, shortName, showName } from "../lib/picks";
import { IS_MAC } from "../lib/shortcuts";
import { useStore, type View } from "../store";
import { useDueCount } from "./WordsBook";

function isView(view: View, v: View) {
  if (view.kind !== v.kind) return false;
  if (v.kind === "show" && view.kind === "show") return view.id === v.id;
  if (v.kind === "episode" && view.kind === "episode") return view.id === v.id;
  if (v.kind === "channel" && view.kind === "channel") return view.input === v.input;
  return true;
}

const SIDE_MOD = IS_MAC ? "⌘" : "Ctrl+";

function showSearchFields(s: Show): (string | null | undefined)[] {
  const display = showName(s.title);
  const short = shortName(s.title);
  const pick = PICKS.find(
    (p) =>
      sameFeed(s.feedUrl, p.input) ||
      p.title === s.title ||
      shortName(p.title) === short ||
      (!!p.channel && p.channel === s.title),
  );
  return [display, s.title, s.author, pick?.zh, pick?.title, pick?.by, pick?.channel];
}

export function Sidebar() {
  const t = useT();
  const { shows, view, go, set } = useStore(
    useShallow((s) => ({ shows: s.shows, view: s.view, go: s.go, set: s.set })),
  );
  const { sideOpen, subsOpen, subsAll, put: putLayout } = useLayout(
    useShallow((l) => ({
      sideOpen: l.sideOpen,
      subsOpen: l.subsOpen,
      subsAll: l.subsAll,
      put: l.put,
    })),
  );
  const wordsNav = useStore((s) => s.settings.learnOn && s.settings.learnSide);
  const due = useDueCount();
  const rail = !sideOpen;
  const SUBS_LONG = 12;
  const SUBS_SHORT = 8;

  const [filterOpen, setFilterOpen] = useState(false);
  const [subQuery, setSubQuery] = useState("");
  const filterInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (filterOpen && subsOpen && !rail) {
      filterInputRef.current?.focus();
    }
  }, [filterOpen, subsOpen, rail]);

  const filteredShows = useMemo(
    () => (rail || !subQuery.trim() ? shows : filterFuzzy(shows, subQuery, showSearchFields)),
    [shows, subQuery, rail],
  );
  // 长列表：前 SUBS_SHORT 档 + 当前打开的节目（无论排第几）；筛选时不截断
  const long = !rail && !subQuery.trim() && shows.length > SUBS_LONG;
  const listed =
    long && !subsAll
      ? filteredShows.filter((s, i) => i < SUBS_SHORT || isView(view, { kind: "show", id: s.id }))
      : filteredShows;

  const toggleFilter = () => {
    if (filterOpen) {
      setFilterOpen(false);
      setSubQuery("");
    } else {
      if (!subsOpen) putLayout({ subsOpen: true });
      setFilterOpen(true);
    }
  };

  const toggleSubs = () => {
    const next = !subsOpen;
    putLayout({ subsOpen: next });
    if (!next && !subQuery.trim()) setFilterOpen(false);
  };

  // 渲染函数而非子组件：避免每次 Sidebar 重渲时按钮 remount 吞掉点击
  const nav = (v: View, icon: React.ReactNode, label: string, badge?: number) => (
    <button
      key={v.kind}
      type="button"
      className={`nav ${isView(view, v) ? "on" : ""}`}
      onClick={() => go(v)}
      title={rail ? label : undefined}
      aria-label={badge ? `${label} · ${badge}` : label}
    >
      {icon}
      <span className="label">{label}</span>
      {badge ? <span className="nav-badge">{badge > 99 ? "99+" : badge}</span> : null}
    </button>
  );

  const showListVisible = rail || subsOpen;

  return (
    <aside className={`sidebar ${rail ? "rail" : ""}`}>
      <div className="traffic-space" data-tauri-drag-region />
      <div className="brand" data-tauri-drag-region>
        <div className="logo-mark">声</div>
        <div>
          <p className="brand-name">{t("声译")}</p>
          <p className="brand-sub">Subpodcast</p>
        </div>
      </div>
      <nav>
        {nav({ kind: "home" }, <Inbox size={16} />, t("首页"))}
        {nav({ kind: "discover" }, <Compass size={16} />, t("发现"))}
        {nav({ kind: "recent" }, <Clock size={16} />, t("最近与收藏"))}
        {nav({ kind: "stats" }, <ChartColumn size={16} />, t("收听统计"))}
        {(wordsNav || view.kind === "words") &&
          nav({ kind: "words" }, <BookMarked size={16} />, t("生词本"), due || undefined)}
      </nav>
      <div className="side-sep" />
      <div className="side-head">
        <button
          type="button"
          className="side-head-toggle"
          aria-expanded={subsOpen}
          aria-controls="sidebar-shows"
          title={subsOpen ? t("折叠订阅") : t("展开订阅")}
          onClick={toggleSubs}
        >
          <ChevronDown size={13} className={`side-chevron ${subsOpen ? "" : "collapsed"}`} />
          <span className="label">{t("订阅")}</span>
          {shows.length > 0 && <span className="side-count">{shows.length}</span>}
        </button>
        <div className="side-head-actions">
          {!rail && shows.length > 0 && (
            <button
              type="button"
              className={`icon-btn sm side-search-btn ${filterOpen || subQuery ? "on" : ""}`}
              title={filterOpen ? t("关闭筛选") : t("筛选订阅")}
              aria-label={filterOpen ? t("关闭筛选") : t("筛选订阅")}
              aria-pressed={filterOpen}
              onClick={toggleFilter}
            >
              <Search size={13} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn sm"
            title={t("添加节目")}
            aria-label={t("添加节目")}
            onClick={() => set({ addOpen: true })}
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
      {!rail && subsOpen && filterOpen && (
        <div className="side-filter">
          <Search size={13} className="side-filter-ico" />
          <input
            ref={filterInputRef}
            value={subQuery}
            placeholder={t("筛选订阅…")}
            aria-label={t("筛选订阅")}
            spellCheck={false}
            onChange={(e) => setSubQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setSubQuery("");
                setFilterOpen(false);
              } else if (e.key === "Enter" && filteredShows.length > 0) {
                go({ kind: "show", id: filteredShows[0]!.id });
              }
            }}
          />
          {subQuery && (
            <button
              type="button"
              className="side-filter-clear"
              title={t("清空")}
              aria-label={t("清空")}
              onClick={() => {
                setSubQuery("");
                filterInputRef.current?.focus();
              }}
            >
              <X size={12} />
            </button>
          )}
        </div>
      )}
      {showListVisible && (
        <div className="show-list" id="sidebar-shows">
          {listed.map((s) => {
            const n = s.episodeCount ?? 0;
            const activeShow = isView(view, { kind: "show", id: s.id });
            return (
              <button
                key={s.id}
                type="button"
                className={`show-item ${activeShow ? "on" : ""}`}
                onClick={() => go({ kind: "show", id: s.id })}
                title={rail ? showName(s.title) : s.title}
              >
                <span className="show-cover">
                  {s.cover ? <img src={s.cover} alt="" /> : <span className="cover-fallback">{s.title.slice(0, 1)}</span>}
                  {rail && activeShow && <span className="rail-dot" />}
                </span>
                <span className="show-title">{showName(s.title)}</span>
                {n > 0 && <span className="show-count">{n}</span>}
              </button>
            );
          })}
          {long && (
            <button
              type="button"
              className="side-more"
              aria-expanded={subsAll}
              onClick={() => putLayout({ subsAll: !subsAll })}
            >
              {subsAll ? t("收起") : t("显示全部（{n}）", { n: shows.length })}
            </button>
          )}
          {!shows.length && (
            <p className="muted small side-empty" style={{ padding: "4px 10px" }}>
              {t("还没有订阅")}
            </p>
          )}
          {shows.length > 0 && !filteredShows.length && (
            <p className="muted small side-empty" style={{ padding: "8px 10px" }}>
              {t("没有匹配的订阅")}
            </p>
          )}
        </div>
      )}
      <div className="side-foot">
        <button
          type="button"
          className="nav settings-btn"
          onClick={() => set({ settingsOpen: true })}
          title={t("设置")}
          aria-label={t("设置")}
        >
          <Cog size={16} />
        </button>
        <button
          type="button"
          className="icon-btn side-toggle"
          onClick={() => putLayout({ sideOpen: rail })}
          title={rail ? `${t("展开侧栏")}（${SIDE_MOD}B）` : `${t("收起侧栏")}（${SIDE_MOD}B）`}
          aria-label={rail ? t("展开侧栏") : t("收起侧栏")}
        >
          {rail ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>
    </aside>
  );
}

export function TopBar() {
  const t = useT();
  const { history, back, reloadShows, go, notify, shows } = useStore(
    useShallow((s) => ({
      history: s.history,
      back: s.back,
      reloadShows: s.reloadShows,
      go: s.go,
      notify: s.notify,
      shows: s.shows,
    })),
  );
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Show[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const link = looksLikeLink(q);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!q.trim() || link) {
      setResults(null);
      return;
    }
    timer.current = window.setTimeout(async () => {
      setBusy(true);
      try {
        const country = /[\u4e00-\u9fff]/.test(q) ? "CN" : "US";
        setResults((await api.searchPodcasts(q.trim(), country)).slice(0, 8));
      } catch {
        setResults([]);
      } finally {
        setBusy(false);
      }
    }, 300);
  }, [q, link]);

  const subscribe = async (input: string) => {
    setAdding(input);
    try {
      const show = await api.addSubscription(input);
      setQ("");
      setOpen(false);
      setResults(null);
      await reloadShows();
      notify(t("已订阅「{title}」", { title: show.title }));
      go({ kind: "show", id: show.id });
    } catch (e) {
      notify(errText(e));
    } finally {
      setAdding(null);
    }
  };

  const submit = () => {
    if (link) void subscribe(q.trim());
    else if (results?.[0]) void subscribe(results[0].feedUrl);
  };

  return (
    <div className="topbar" data-tauri-drag-region>
      <button className="round-btn" onClick={back} disabled={!history.length} aria-label={t("返回")}>
        <ChevronLeft size={18} />
      </button>
      <div className="search-wrap">
        <div className={`top-search ${open ? "focus" : ""}`}>
          {link ? <Link2 size={16} /> : <Search size={16} />}
          <input
            value={q}
            placeholder={t("粘贴 YouTube / 小宇宙 / 播客链接，或搜索节目名")}
            spellCheck={false}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") {
                setQ("");
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          {busy || adding ? (
            <Loader2 size={14} className="spin" />
          ) : link ? (
            <span className="kbd-hint">{t("回车订阅")}</span>
          ) : (
            !open && !q && <kbd className="kbd-hint">⌘L</kbd>
          )}
        </div>
        {open && results && (
          <div className="search-drop">
            {results.length === 0 ? (
              <p className="muted small" style={{ padding: 12, textAlign: "center" }}>
                {t("没有找到，换个关键词试试")}
              </p>
            ) : (
              results.map((r) => {
                const done = shows.some((s) => s.feedUrl === r.feedUrl);
                return (
                  <div key={r.feedUrl} className="drop-row" onMouseDown={(e) => e.preventDefault()}>
                    {r.cover ? <img src={r.cover} alt="" /> : <div className="cover-fallback">{r.title.slice(0, 1)}</div>}
                    <div className="drop-meta">
                      <p className="ep-name clamp1">{r.title}</p>
                      <p className="meta-line clamp1">{r.author}</p>
                    </div>
                    {done ? (
                      <span className="muted small">{t("已订阅")}</span>
                    ) : (
                      <button className="btn sm" onClick={() => void subscribe(r.feedUrl)} disabled={adding != null}>
                        {adding === r.feedUrl ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} {t("订阅")}
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
      <div className="spacer" data-tauri-drag-region />
    </div>
  );
}

export function Toast() {
  const { toast, action } = useStore(
    useShallow((s) => ({ toast: s.toast, action: s.toastAction })),
  );
  if (!toast) return null;
  return (
    <div className={`toast${action ? " has-action" : ""}`} role="status">
      <span>{toast}</span>
      {action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            action.run();
            useStore.setState({ toast: null, toastAction: null });
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
