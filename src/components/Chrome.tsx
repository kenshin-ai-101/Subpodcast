/**
 * [INPUT]: store、api
 * [OUTPUT]: Sidebar / TopBar / Toast — 与 SubCast 壳层信息架构对齐
 * [POS]: 全局导航与搜索订阅入口
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronLeft, Inbox, Link2, Loader2, Plus, Search, Settings as Cog } from "lucide-react";
import { api, errText, type Show } from "../lib/api";
import { looksLikeLink } from "../lib/feeds";
import { useStore, type View } from "../store";

function isView(view: View, v: View) {
  if (view.kind !== v.kind) return false;
  if (v.kind === "show" && view.kind === "show") return view.id === v.id;
  if (v.kind === "episode" && view.kind === "episode") return view.id === v.id;
  return true;
}

export function Sidebar() {
  const { shows, view, go, set } = useStore(
    useShallow((s) => ({ shows: s.shows, view: s.view, go: s.go, set: s.set })),
  );

  return (
    <aside className="sidebar">
      <div className="traffic-space" data-tauri-drag-region />
      <div className="brand" data-tauri-drag-region>
        <div className="logo-mark">声</div>
        <div>
          <p className="brand-name">声译</p>
          <p className="brand-sub">Subpodcast</p>
        </div>
      </div>
      <nav>
        <button className={`nav ${isView(view, { kind: "home" }) ? "on" : ""}`} onClick={() => go({ kind: "home" })}>
          <Inbox size={16} />
          <span>首页</span>
        </button>
      </nav>
      <div className="side-sep" />
      <div className="side-head">
        <span>订阅</span>
        <button className="icon-btn" title="添加节目" onClick={() => set({ addOpen: true })}>
          <Plus size={14} />
        </button>
      </div>
      <div className="show-list">
        {shows.map((s) => (
          <button
            key={s.id}
            className={`show-item ${isView(view, { kind: "show", id: s.id }) ? "on" : ""}`}
            onClick={() => go({ kind: "show", id: s.id })}
            title={s.title}
          >
            <span className="show-cover">
              {s.cover ? <img src={s.cover} alt="" /> : <span className="cover-fallback">{s.title.slice(0, 1)}</span>}
            </span>
            <span className="show-title">{s.title}</span>
            {(s.unplayed ?? 0) > 0 && <span className="unplayed">{(s.unplayed ?? 0) > 99 ? "99+" : s.unplayed}</span>}
          </button>
        ))}
        {!shows.length && <p className="muted small" style={{ padding: "4px 10px" }}>还没有订阅</p>}
      </div>
      <div className="side-foot">
        <button className="nav" onClick={() => set({ settingsOpen: true })}>
          <Cog size={16} />
          <span>设置</span>
        </button>
      </div>
    </aside>
  );
}

export function TopBar() {
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
      notify(`已订阅「${show.title}」`);
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
      <button className="round-btn" onClick={back} disabled={!history.length} aria-label="返回">
        <ChevronLeft size={18} />
      </button>
      <div className="search-wrap">
        <div className={`top-search ${open ? "focus" : ""}`}>
          {link ? <Link2 size={16} /> : <Search size={16} />}
          <input
            value={q}
            placeholder="粘贴 YouTube / 小宇宙 / 播客链接，或搜索节目名"
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
            <span className="kbd-hint">回车订阅</span>
          ) : (
            !open && !q && <kbd className="kbd-hint">⌘L</kbd>
          )}
        </div>
        {open && results && (
          <div className="search-drop">
            {results.length === 0 ? (
              <p className="muted small" style={{ padding: 12, textAlign: "center" }}>
                没有找到，换个关键词试试
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
                      <span className="muted small">已订阅</span>
                    ) : (
                      <button className="btn sm" onClick={() => void subscribe(r.feedUrl)} disabled={adding != null}>
                        {adding === r.feedUrl ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} 订阅
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
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  return <div className="toast">{toast}</div>;
}
