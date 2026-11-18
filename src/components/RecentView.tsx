/**
 * [INPUT]: api.recentEpisodes、library favorites
 * [OUTPUT]: RecentView — 最近播放 / 收藏
 * [POS]: 首页「接下来听 › 全部」
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { api, type Episode } from "../lib/api";
import { clearQueue, playAll, useQueue } from "../lib/queue";
import { useLibrary } from "../lib/library";
import { useStore } from "../store";
import { EpisodeRow } from "./HomeView";

function EpisodeList({ episodes }: { episodes: Episode[] | null }) {
  const openEpisode = useStore((s) => s.openEpisode);
  if (episodes == null) return <p className="muted">加载中…</p>;
  if (!episodes.length) return <p className="muted">这里还没有内容</p>;
  return (
    <div className="ep-feed">
      {episodes.map((ep) => (
        <EpisodeRow key={ep.id} ep={ep} showShow onOpen={() => openEpisode(ep)} />
      ))}
    </div>
  );
}

export function RecentView() {
  const favorites = useLibrary((s) => s.favorites);
  const queued = useQueue((s) => s.queue.length);
  const [tab, setTab] = useState<"recent" | "saved">("recent");
  const [eps, setEps] = useState<Episode[] | null>(null);
  const [saved, setSaved] = useState<Episode[] | null>(null);

  useEffect(() => {
    void api.recentEpisodes().then(setEps);
  }, []);

  useEffect(() => {
    let live = true;
    void Promise.all(favorites.map((f) => api.getEpisode(f.id).catch(() => null))).then((r) => {
      if (live) setSaved(r.filter((x): x is Episode => !!x));
    });
    return () => {
      live = false;
    };
  }, [favorites]);

  const playable = (saved ?? []).filter((e) => !e.duration || e.progress < e.duration * 0.97);

  return (
    <div className="page">
      <div className="page-head row-actions">
        <h1 className="page-title">接下来听</h1>
        <div className="seg-control" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "recent"}
            className={tab === "recent" ? "on" : ""}
            onClick={() => setTab("recent")}
          >
            最近播放
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "saved"}
            className={tab === "saved" ? "on" : ""}
            onClick={() => setTab("saved")}
          >
            收藏{favorites.length ? ` ${favorites.length}` : ""}
          </button>
        </div>
        <span className="spacer" />
        {tab === "saved" && playable.length > 0 && (
          <button type="button" className="btn primary sm" onClick={() => playAll(playable)}>
            <Play size={13} fill="currentColor" /> 全部播放（{playable.length} 集）
          </button>
        )}
        {tab === "saved" && queued > 0 && (
          <button type="button" className="btn ghost sm" onClick={clearQueue}>
            清空待播（{queued}）
          </button>
        )}
      </div>
      {tab === "recent" ? (
        <EpisodeList episodes={eps} />
      ) : saved && !saved.length ? (
        <p className="muted">还没有收藏。在单集页点书签即可加入收藏。</p>
      ) : (
        <EpisodeList episodes={saved} />
      )}
    </div>
  );
}