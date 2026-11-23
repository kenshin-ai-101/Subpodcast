/**
 * [INPUT]: api.listEpisodes / refreshShow / removeShow；MonthFilter；queue.playAll；store.shows.episodeCount
 * [OUTPUT]: 订阅节目详情页（封面头图、筛选计数、月份轴、分组单集）；打开时回写侧栏单集总数
 * [POS]: Sidebar 点选订阅后的主面板；单集列表走 EpFeed，悬停不挡页面滚动
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  BookOpen,
  ChevronDown,
  ListVideo,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { api, errText, type Episode, type Show } from "../lib/api";
import { ask } from "../lib/confirm";
import { groupLabel, plainText } from "../lib/format";
import { alreadySubscribedDeep, deepPickFor } from "../lib/deepPicks";
import { playAll } from "../lib/queue";
import { useStore } from "../store";
import { EpFeed, EpisodeRow } from "./HomeView";
import { MonthFilter, useMonthFilter } from "./MonthFilter";

type Filter = "all" | "unplayed" | "subs";

/** 「未听」筛选：进度不足 5 秒视为未听（仅筛选条，不进侧栏角标）。 */
const UNPLAYED_SEC = 5;

function kindLabel(show: Show): string {
  if (show.kind === "youtube") return "YouTube 频道";
  if (show.kind === "xiaoyuzhou") return "小宇宙";
  if (show.kind === "qiaomu") return "乔木精读";
  return "播客";
}

function isUnplayed(ep: Episode): boolean {
  return ep.progress < UNPLAYED_SEC;
}

function isFinished(ep: Episode): boolean {
  return !!(ep.duration && ep.progress >= ep.duration * 0.97);
}

function isPlayable(ep: Episode): boolean {
  return !!(ep.audioUrl || ep.videoId) && !isFinished(ep);
}

export function ShowView({ showId }: { showId: string }) {
  const { shows, openEpisode, notify, reloadShows, go, set } = useStore(
    useShallow((s) => ({
      shows: s.shows,
      openEpisode: s.openEpisode,
      notify: s.notify,
      reloadShows: s.reloadShows,
      go: s.go,
      set: s.set,
    })),
  );
  const show = shows.find((s) => s.id === showId);
  const [eps, setEps] = useState<Episode[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState("");
  const searchBox = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setEps(null);
    setFilter("all");
    setExpanded(false);
    setMenu(false);
    setQuery("");
    void api
      .listEpisodes(showId, 10_000)
      .then((list) => {
        setEps(list);
        // 打开详情时用列表长度回写侧栏，避免刷新后角标与本页「全部」漂移
        const n = list.length;
        const cur = useStore.getState().shows;
        if (cur.some((s) => s.id === showId && (s.episodeCount ?? 0) !== n)) {
          useStore.getState().set({
            shows: cur.map((s) => (s.id === showId ? { ...s, episodeCount: n } : s)),
          });
        }
      })
      .catch((e) => notify(errText(e)));
  }, [showId, notify]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchBox.current?.focus();
        searchBox.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const desc = useMemo(() => plainText(show?.description), [show?.description]);

  const counts = useMemo(() => {
    if (!eps) return { all: 0, unplayed: 0, subs: 0 };
    let unplayed = 0;
    let subs = 0;
    for (const e of eps) {
      if (isUnplayed(e)) unplayed += 1;
      if (e.hasTranscript || e.transcriptUrl) subs += 1;
    }
    return { all: eps.length, unplayed, subs };
  }, [eps]);

  const byFilter = useMemo(() => {
    if (!eps) return null;
    return eps.filter((e) => {
      if (filter === "unplayed") return isUnplayed(e);
      if (filter === "subs") return e.hasTranscript || !!e.transcriptUrl;
      return true;
    });
  }, [eps, filter]);

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !eps) return null;
    return eps.filter((e) => {
      const hay = `${e.title}\n${e.notes ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [eps, query]);

  const { month, setMonth, filtered: shown } = useMonthFilter(byFilter);
  useEffect(() => {
    setMonth(null);
  }, [showId, setMonth]);
  const list = hits ?? shown;
  const playable = (shown ?? []).filter(isPlayable);

  if (!show) return <div className="page muted">节目不存在</div>;

  const refresh = async () => {
    setBusy(true);
    try {
      const n = await api.refreshShow(showId);
      const list = await api.listEpisodes(showId, 10_000);
      setEps(list);
      await reloadShows();
      notify(
        n > 0
          ? `更新了 ${n} 期，当前共 ${list.length} 期`
          : `已是最新，当前共 ${list.length} 期`,
      );
    } catch (e) {
      notify(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setMenu(false);
    const ok = await ask(`取消订阅「${show.title}」？已生成的字幕和收听进度会保留。`);
    if (!ok) return;
    await api.removeShow(showId);
    await reloadShows();
    go({ kind: "home" });
  };

  const meta =
    show.author && show.author !== show.title
      ? `${kindLabel(show)} · ${show.author}`
      : kindLabel(show);
  const deepPick =
    show.kind !== "qiaomu" ? deepPickFor(show.title) : undefined;
  const deepReady =
    deepPick && !alreadySubscribedDeep(deepPick.input, shows) ? deepPick : undefined;

  const subscribeDeep = async () => {
    if (!deepReady) return;
    setBusy(true);
    try {
      const s = await api.addSubscription(deepReady.input);
      await reloadShows();
      notify(`已订阅精读版「${s.title}」`);
      go({ kind: "show", id: s.id });
    } catch (e) {
      notify(errText(e));
      set({ addOpen: true, addTab: "link" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="show-head">
        {show.cover ? (
          <img src={show.cover} alt="" />
        ) : (
          <div className="cover-fallback">{show.title.slice(0, 1)}</div>
        )}
        <div className="show-info">
          <p className="meta-line">{meta}</p>
          <h1 className="show-title-h">{show.title}</h1>
          {desc && (
            <>
              <p className={`show-desc ${expanded ? "" : "clamp3"}`}>{desc}</p>
              <div className="row-actions tight">
                <button type="button" className="link-btn" onClick={() => setExpanded(!expanded)}>
                  {expanded ? "收起" : "展开"}
                  <ChevronDown size={12} className={expanded ? "flip" : ""} />
                </button>
              </div>
            </>
          )}
          <div className="row-actions">
            <button type="button" className="btn sm" onClick={() => void refresh()} disabled={busy}>
              {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
              检查更新
            </button>
            {playable.length > 1 && (
              <button
                type="button"
                className="btn sm"
                title={`按列表顺序连着播放没听完的 ${playable.length} 集`}
                onClick={() => playAll(playable)}
              >
                <ListVideo size={14} /> 播放全部
              </button>
            )}
            <div className="menu-wrap">
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => setMenu(!menu)}
                aria-haspopup="menu"
                aria-expanded={menu}
              >
                <MoreHorizontal size={14} /> 更多
              </button>
              {menu && (
                <div className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
                  <button type="button" role="menuitem" className="danger" onClick={() => void remove()}>
                    取消订阅
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {deepReady && (
        <button type="button" className="deep-hint" onClick={() => void subscribeDeep()} disabled={busy}>
          <BookOpen size={16} />
          <div>
            <p className="deep-hint-t">这档节目有乔木精读版</p>
            <p className="muted small">中文标题、每期精读长文和原文文稿，点击订阅</p>
          </div>
        </button>
      )}

      <div className="list-head">
        <h2 className="section-title flush">{hits ? "搜索结果" : "全部单集"}</h2>
        <label className={`show-search ${query ? "on" : ""}`}>
          <Search size={14} />
          <input
            ref={searchBox}
            value={query}
            spellCheck={false}
            placeholder="搜索本节目（⌘F）"
            aria-label="搜索本节目的单集与简介"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              }
            }}
          />
          {query && (
            <button
              type="button"
              className="icon-btn sm"
              onClick={() => {
                setQuery("");
                searchBox.current?.focus();
              }}
              aria-label="清除搜索"
            >
              <X size={13} />
            </button>
          )}
        </label>
        {!hits && (
          <div className="seg-control">
            {(
              [
                ["all", "全部", counts.all],
                ["unplayed", "未听", counts.unplayed],
                ["subs", "有字幕", counts.subs],
              ] as [Filter, string, number][]
            ).map(([k, label, n]) => (
              <button
                key={k}
                type="button"
                className={filter === k ? "on" : ""}
                onClick={() => setFilter(k)}
              >
                {label}
                {eps && <span className="seg-n">{n}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {hits ? (
        hits.length ? (
          <>
            <p className="muted small search-count">找到 {hits.length} 集</p>
            <EpFeed>
              {hits.map((ep) => (
                <EpisodeRow key={ep.id} ep={ep} onOpen={() => openEpisode(ep)} />
              ))}
            </EpFeed>
          </>
        ) : (
          <div className="panel-empty soft">
            <p className="lead">没有找到「{query.trim()}」</p>
            <p className="muted">搜索范围是本节目的标题与简介</p>
          </div>
        )
      ) : (
        <>
          <MonthFilter episodes={byFilter} month={month} onChange={setMonth} />
          <EpisodeList episodes={list} onOpen={openEpisode} />
        </>
      )}
    </div>
  );
}

function EpisodeList({
  episodes,
  onOpen,
}: {
  episodes: Episode[] | null;
  onOpen: (ep: Episode) => void;
}) {
  if (episodes == null) return <p className="muted">加载中…</p>;
  if (!episodes.length) {
    return (
      <div className="panel-empty soft">
        <p className="lead">这里还没有内容</p>
        <p className="muted">新的内容到了，会出现在这里</p>
      </div>
    );
  }

  const groups: { label: string; items: Episode[] }[] = [];
  for (const ep of episodes) {
    const label = groupLabel(ep.published);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(ep);
    else groups.push({ label, items: [ep] });
  }

  return (
    <EpFeed>
      {groups.map((g) => (
        <section key={g.label} className="ep-group">
          <h3 className="ep-group-h">{g.label}</h3>
          {g.items.map((ep) => (
            <EpisodeRow key={ep.id} ep={ep} onOpen={() => onOpen(ep)} />
          ))}
        </section>
      ))}
    </EpFeed>
  );
}
