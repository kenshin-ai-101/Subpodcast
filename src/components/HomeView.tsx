/**
 * [INPUT]: api.listEpisodes、store.openEpisode
 * [OUTPUT]: HomeView；共享 EpisodeRow（16:9 缩略图 + 字幕/进度标签）
 * [POS]: 默认着陆页；EpisodeRow 亦被 ShowView 复用
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useMemo, useState } from "react";
import { api, type Episode } from "../lib/api";
import { date, duration, groupLabel } from "../lib/format";
import { useStore } from "../store";

export function HomeView() {
  const { shows, openEpisode, set } = useStore();
  const [eps, setEps] = useState<Episode[] | null>(null);

  useEffect(() => {
    void api.listEpisodes(null, 60).then(setEps);
  }, [shows.length]);

  const groups = useMemo(() => {
    if (!eps) return [];
    const out: { label: string; items: Episode[] }[] = [];
    for (const ep of eps) {
      const label = groupLabel(ep.published);
      const last = out[out.length - 1];
      if (last?.label === label) last.items.push(ep);
      else out.push({ label, items: [ep] });
    }
    return out;
  }, [eps]);

  if (!shows.length) {
    return (
      <div className="page">
        <div className="empty-home">
          <h2>声译</h2>
          <p>订阅海外播客与 YouTube，对照双语字幕听，还能直接问这一集。</p>
          <button className="btn primary" onClick={() => set({ addOpen: true })}>
            订阅第一档节目
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <h1 className="page-title">首页</h1>
      <p className="page-lead">最近更新的单集。点开后会自动查找字幕并翻译成中文。</p>
      {!eps ? (
        <p className="muted">加载中…</p>
      ) : (
        <div className="ep-feed">
          {groups.map((g) => (
            <div key={g.label} className="ep-group">
              <p className="ep-group-h">{g.label}</p>
              {g.items.map((ep) => (
                <EpisodeRow key={ep.id} ep={ep} showShow onOpen={() => openEpisode(ep)} />
              ))}
            </div>
          ))}
        </div>
      )}
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
  const playing = useStore((s) => s.current?.id === ep.id);
  const pct = ep.duration && ep.progress > 5 ? Math.min(100, (ep.progress / ep.duration) * 100) : 0;
  const done = pct >= 97;
  const left =
    ep.duration && pct > 0 && !done
      ? Math.max(1, Math.round((ep.duration - ep.progress) / 60))
      : 0;
  const square = !ep.videoId;

  return (
    <button
      type="button"
      className={`ep-item ${playing ? "playing" : ""} ${done ? "played" : ""}`}
      onClick={onOpen}
    >
      <div className={`ep-thumb ${square ? "square" : "video"}`}>
        {ep.cover && square && <img className="thumb-bg" src={ep.cover} alt="" aria-hidden loading="lazy" />}
        {ep.cover ? (
          <img
            className="thumb-img"
            src={ep.cover}
            alt=""
            loading="lazy"
            onError={(e) => {
              const img = e.currentTarget;
              if (ep.videoId && !img.dataset.f) {
                img.dataset.f = "1";
                img.src = `https://i.ytimg.com/vi/${ep.videoId}/mqdefault.jpg`;
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
          {showShow && ep.showTitle && <span className="show-name">{ep.showTitle}</span>}
          <span>{date(ep.published)}</span>
          {ep.duration ? <span>{duration(ep.duration)}</span> : null}
        </p>
        <p className="ep-title2">{ep.title}</p>
        {(ep.hasTranscript || ep.videoId || left > 0 || done) && (
          <p className="ep-tags">
            {ep.hasTranscript && <span className="tag has-cc">字幕</span>}
            {ep.videoId && <span className="tag">视频</span>}
            {left > 0 && <span className="tag progress">剩 {left} 分钟</span>}
            {done && <span className="tag">已听完</span>}
          </p>
        )}
      </div>
    </button>
  );
}
