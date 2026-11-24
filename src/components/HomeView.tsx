/**
 * [INPUT]: api、recommend、library、queue.playAll
 * [OUTPUT]: HomeView；共享 EpisodeRow / EpFeed（WKWebView 悬停不吞滚轮）
 * [POS]: 默认首页；卡片只打开，▶ / 继续听走 playAll（load+导航+playSoon）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, ChevronRight, Loader2, Play, Plus } from "lucide-react";
import { api, errText, type Episode, type Show } from "../lib/api";
import { date, duration } from "../lib/format";
import { useT } from "../lib/i18n";
import { useLibrary } from "../lib/library";
import { isSubscribed, pickName, showName, type Pick } from "../lib/picks";
import { playAll } from "../lib/queue";
import { recommend, type Recommendation } from "../lib/recommend";
import { useStore } from "../store";

function ContinueHero({ ep }: { ep: Episode }) {
  const t = useT();
  const pct = ep.duration ? Math.min(100, (ep.progress / ep.duration) * 100) : 0;
  const left = ep.duration ? Math.max(1, Math.round((ep.duration - ep.progress) / 60)) : 0;
  const resume = () => {
    playAll([ep]);
  };
  return (
    <div
      className="hero"
      role="button"
      tabIndex={0}
      onClick={resume}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          resume();
        }
      }}
    >
      <div className={`hero-cover ${ep.videoId ? "wide" : ""}`}>
        {ep.cover ? <img src={ep.cover} alt="" /> : <div className="cover-fallback" />}
        {pct > 0 && (
          <span className="hero-bar">
            <span style={{ width: `${pct}%` }} />
          </span>
        )}
      </div>
      <div className="hero-meta">
        <p className="meta-line">
          {t("继续收听")}{ep.showTitle ? ` · ${showName(ep.showTitle)}` : ""}
        </p>
        <p className="hero-title">{ep.title}</p>
        <div className="hero-foot">
          <span className="btn primary hero-play">
            <Play size={15} fill="currentColor" /> {t("继续播放")}
          </span>
          {left > 0 && <span className="hero-left">{t("还剩 {n} 分钟", { n: left })}</span>}
        </div>
      </div>
    </div>
  );
}

function EpisodeCard({ ep }: { ep: Episode }) {
  const t = useT();
  const openEpisode = useStore((s) => s.openEpisode);
  const pct = ep.duration && ep.progress > 5 ? Math.min(100, (ep.progress / ep.duration) * 100) : 0;
  const left = ep.duration && pct > 0 ? Math.max(1, Math.round((ep.duration - ep.progress) / 60)) : 0;
  const play = (e: React.MouseEvent) => {
    e.stopPropagation();
    playAll([ep]);
  };
  const subsReady = ep.hasTranscript || ep.videoId || !!ep.transcriptUrl;
  return (
    <div
      className="ep-card"
      role="button"
      tabIndex={0}
      onClick={() => openEpisode(ep)}
      onKeyDown={(e) => e.key === "Enter" && openEpisode(ep)}
    >
      <div className={`ep-thumb ${ep.videoId ? "wide" : "square"}`}>
        {ep.cover && !ep.videoId && <img className="thumb-bg" src={ep.cover} alt="" aria-hidden loading="lazy" />}
        {ep.cover ? (
          <img className="thumb-img" src={ep.cover} alt="" loading="lazy" />
        ) : (
          <div className="cover-fallback" />
        )}
        {pct > 0 && (
          <span className="thumb-bar">
            <span style={{ width: `${pct}%` }} />
          </span>
        )}
        {subsReady && <span className="thumb-subs">{t("有字幕")}</span>}
        <button type="button" className="card-play" title={t("播放")} onClick={play}>
          <Play size={16} fill="currentColor" />
        </button>
      </div>
      <p className="ep-kicker">
        {ep.showTitle && <span className="show-name">{showName(ep.showTitle)}</span>}
        <span>{left ? t("剩 {n} 分钟", { n: left }) : date(ep.published)}</span>
      </p>
      <p className="card-title">{ep.title}</p>
    </div>
  );
}

function ShowTile({ show }: { show: Show }) {
  useT();
  const go = useStore((s) => s.go);
  return (
    <div
      className="show-tile"
      role="button"
      tabIndex={0}
      onClick={() => go({ kind: "show", id: show.id })}
      onKeyDown={(e) => e.key === "Enter" && go({ kind: "show", id: show.id })}
    >
      <div className="tile-cover">
        {show.cover ? <img src={show.cover} alt="" loading="lazy" /> : <div className="cover-fallback">{show.title.slice(0, 1)}</div>}
      </div>
      <p className="tile-name clamp1">{showName(show.title)}</p>
    </div>
  );
}

function RecRow({
  r,
  onAdd,
  adding,
  done,
}: {
  r: Recommendation;
  onAdd: () => void;
  adding: boolean;
  done: boolean;
}) {
  const t = useT();
  const go = useStore((s) => s.go);
  return (
    <div
      className="rec-row"
      role="button"
      tabIndex={0}
      onClick={() => go({ kind: "channel", input: r.pick.input })}
      onKeyDown={(e) => e.key === "Enter" && go({ kind: "channel", input: r.pick.input })}
    >
      <img src={r.pick.cover} alt="" loading="lazy" />
      <div className="rec-text">
        <p className="rec-name clamp1">{pickName(r.pick)}</p>
        <p className="muted small clamp1">
          {r.because ? t("因为你在听「{show}」", { show: showName(r.because) }) : t(r.pick.intro)}
        </p>
      </div>
      {done ? (
        <span className="tile-done">
          <Check size={14} />
        </span>
      ) : (
        <button
          type="button"
          className="icon-btn sm rec-add"
          title={t("订阅")}
          disabled={adding}
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
        >
          {adding ? <Loader2 size={14} className="spin" /> : <Plus size={16} />}
        </button>
      )}
    </div>
  );
}

export function HomeView() {
  const t = useT();
  const { shows, go, reloadShows, notify, set } = useStore(
    useShallow((s) => ({
      shows: s.shows,
      go: s.go,
      reloadShows: s.reloadShows,
      notify: s.notify,
      set: s.set,
    })),
  );
  const favorites = useLibrary((s) => s.favorites);
  const [eps, setEps] = useState<Episode[] | null>(null);
  const [recent, setRecent] = useState<Episode[]>([]);
  const [favEps, setFavEps] = useState<Episode[]>([]);
  const [all, setAll] = useState(false);
  const limit = 24;
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    void api.listEpisodes(null, 200).then(setEps);
    void api.recentEpisodes().then(setRecent).catch(() => setRecent([]));
  }, [shows.length]);

  useEffect(() => {
    void Promise.all(favorites.slice(0, 30).map((f) => api.getEpisode(f.id).catch(() => null))).then((r) =>
      setFavEps(r.filter((x): x is Episode => !!x)),
    );
  }, [favorites]);

  const unfinished = (e: Episode) => e.progress > 5 && (!e.duration || e.progress < e.duration * 0.97);
  const hero = recent.find(unfinished) ?? null;
  const upNext = [...recent.filter((e) => unfinished(e) && e.id !== hero?.id), ...favEps.filter((e) => !unfinished(e))]
    .filter((e, i, a) => a.findIndex((x) => x.id === e.id) === i)
    .slice(0, 12);

  const unheard = (eps ?? []).filter((e) => !(e.duration && e.progress >= e.duration * 0.97));
  const fresh = useMemo(() => {
    const head = unheard.slice(0, 36);
    const ready = head.filter((e) => e.hasTranscript || e.videoId || e.transcriptUrl);
    const rest = head.filter((e) => !(e.hasTranscript || e.videoId || e.transcriptUrl));
    return [...ready, ...rest, ...unheard.slice(36)];
  }, [unheard]);

  const recs = useMemo(() => recommend({ shows, recent, favorites: favEps }, 6), [shows, recent, favEps]);
  const gridEps = all ? fresh : fresh.slice(0, limit);

  const subscribe = async (input: string, pick: Pick) => {
    setAdding(input);
    try {
      await api.addSubscription(input);
      await reloadShows();
      notify(t("已订阅「{title}」", { title: pickName(pick) }));
    } catch (e) {
      notify(errText(e));
    } finally {
      setAdding(null);
    }
  };

  if (!shows.length) {
    return (
      <div className="page">
        <div className="empty-home">
          <h2>{t("声译")}</h2>
          <p>{t("订阅海外播客与 YouTube，对照双语字幕听，还能直接问这一集。")}</p>
          <button type="button" className="btn primary" onClick={() => go({ kind: "discover" })}>
            {t("去发现节目")}
          </button>
          <button type="button" className="btn" onClick={() => set({ addOpen: true })}>
            {t("粘贴链接订阅")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page home">
      {hero && <ContinueHero ep={hero} />}
      {(upNext.length > 0 || hero) && (
        <section>
          <div className="module-head">
            <h2 className="module-title">{t("接下来听")}</h2>
            <button type="button" className="link-btn" onClick={() => go({ kind: "recent" })}>
              {t("全部")}{favorites.length ? ` · ${t("收藏 {n}", { n: favorites.length })}` : ""} <ChevronRight size={13} />
            </button>
          </div>
          {upNext.length > 0 && (
            <div className="card-strip">
              {upNext.map((e) => (
                <EpisodeCard key={e.id} ep={e} />
              ))}
            </div>
          )}
        </section>
      )}
      <div className="home-grid">
        <div>
          <section>
            <div className="module-head">
              <h2 className="module-title">{t("最新单集")}</h2>
            </div>
            {!eps ? (
              <p className="muted">{t("加载中…")}</p>
            ) : (
              <>
                <div className="card-grid">{gridEps.map((e) => (e ? <EpisodeCard key={e.id} ep={e} /> : null))}</div>
                {!all && fresh.length > limit && (
                  <button type="button" className="btn sm" style={{ marginTop: 12 }} onClick={() => setAll(true)}>
                    {t("显示更多")}
                  </button>
                )}
              </>
            )}
          </section>
        </div>
        <aside className="home-side">
          {recs.length > 0 && (
            <section>
              <div className="module-head">
                <h2 className="module-title">{t("为你推荐")}</h2>
                <button type="button" className="link-btn" onClick={() => go({ kind: "discover" })}>
                  {t("更多")}
                </button>
              </div>
              <div className="rec-list">
                {recs.map((r) => (
                  <RecRow
                    key={r.pick.id}
                    r={r}
                    adding={adding === r.pick.input}
                    done={isSubscribed(r.pick, shows)}
                    onAdd={() => void subscribe(r.pick.input, r.pick)}
                  />
                ))}
              </div>
            </section>
          )}
          <section>
            <div className="module-head">
              <h2 className="module-title">{t("订阅节目")}</h2>
              <button type="button" className="link-btn" onClick={() => set({ addOpen: true })}>
                <Plus size={13} /> {t("添加")}
              </button>
            </div>
            <div className="show-grid">
              {shows.slice(0, 16).map((s) => (
                <ShowTile key={s.id} show={s} />
              ))}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

/**
 * 单集列表容器：把滚轮显式交给最近的 `.page`。
 * WKWebView 在悬停 overflow 子节点时经常不链式滚动，仅靠 CSS 不够稳。
 */
export function EpFeed({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.defaultPrevented) return;
      const page = root.closest(".page");
      if (!(page instanceof HTMLElement)) return;
      const dy =
        e.deltaMode === 1
          ? e.deltaY * 16
          : e.deltaMode === 2
            ? e.deltaY * page.clientHeight
            : e.deltaY;
      if (!dy) return;
      const max = page.scrollHeight - page.clientHeight;
      if (max <= 0) return;
      const next = Math.min(max, Math.max(0, page.scrollTop + dy));
      if (next === page.scrollTop) return;
      page.scrollTop = next;
      e.preventDefault();
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, []);
  return (
    <div className="ep-feed" ref={ref}>
      {children}
    </div>
  );
}

export function EpisodeRow({
  ep,
  showShow,
  onOpen,
}: {
  ep: Episode;
  showShow?: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const playing = useStore((s) => s.current?.id === ep.id);
  const pct = ep.duration && ep.progress > 5 ? Math.min(100, (ep.progress / ep.duration) * 100) : 0;
  const done = pct >= 97;
  const left =
    ep.duration && pct > 0 && !done ? Math.max(1, Math.round((ep.duration - ep.progress) / 60)) : 0;
  const square = !ep.videoId;
  const thumb = ep.videoId
    ? `https://i.ytimg.com/vi/${ep.videoId}/mqdefault.jpg`
    : ep.cover ?? undefined;

  return (
    <div
      className={`ep-item ${playing ? "playing" : ""} ${done ? "played" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className={`ep-thumb ${square ? "square" : "wide"}`}>
        {ep.cover && square && <img className="thumb-bg" src={ep.cover} alt="" aria-hidden loading="lazy" />}
        {thumb ? (
          <img
            className="thumb-img"
            src={thumb}
            alt=""
            loading="lazy"
            onError={(e) => {
              const img = e.currentTarget;
              if (ep.videoId && !img.dataset.f && ep.cover) {
                img.dataset.f = "1";
                img.src = ep.cover;
              } else {
                img.style.visibility = "hidden";
              }
            }}
          />
        ) : (
          <div className="cover-fallback">{ep.title.slice(0, 1)}</div>
        )}
        {pct > 0 && (
          <span className="thumb-bar">
            <span style={{ width: `${pct}%` }} />
          </span>
        )}
      </div>
      <div className="ep-body-col">
        <p className="ep-kicker">
          {showShow && ep.showTitle && <span className="show-name">{showName(ep.showTitle)}</span>}
          <span>{date(ep.published)}</span>
          {ep.duration ? <span>{duration(ep.duration)}</span> : null}
        </p>
        <p className="ep-title2">{ep.title}</p>
        {(ep.hasTranscript || ep.videoId || left > 0 || done) && (
          <p className="ep-tags">
            {ep.hasTranscript && <span className="tag has-cc">{t("字幕")}</span>}
            {ep.videoId && <span className="tag">{t("视频")}</span>}
            {left > 0 && <span className="tag progress">{t("剩 {n} 分钟", { n: left })}</span>}
            {done && <span className="tag">{t("已听完")}</span>}
          </p>
        )}
      </div>
    </div>
  );
}