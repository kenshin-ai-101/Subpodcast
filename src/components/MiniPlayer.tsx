/**
 * [INPUT]: store.current / view / playing / player / time / length / loadingSince
 * [OUTPUT]: MiniPlayer — 非单集页时的音频迷你条
 * [POS]: App 根挂载；纯音频离页续听入口（对齐 Subcast 迷你条行为）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useShallow } from "zustand/react/shallow";
import { Loader2, Pause, Play } from "lucide-react";
import { showName } from "../lib/picks";
import { useStore } from "../store";

export function MiniPlayer() {
  const { current, view, playing, player, time, length, loadingSince, audioOnly, openEpisode } = useStore(
    useShallow((s) => ({
      current: s.current,
      view: s.view,
      playing: s.playing,
      player: s.player,
      time: Math.floor(s.time),
      length: s.length,
      loadingSince: s.loadingSince,
      audioOnly: s.audioOnly,
      openEpisode: s.openEpisode,
    })),
  );

  // 视频全屏舞台不走迷你条；当前就在该集单集页也不显示
  if (!current) return null;
  if (!audioOnly && current.videoId) return null;
  if (view.kind === "episode" && view.id === current.id) return null;

  const pct = length ? Math.min(100, (time / length) * 100) : 0;
  const busy = !!loadingSince;

  return (
    <div className="mini">
      <button
        type="button"
        className="play-btn sm"
        onClick={() => player?.toggle()}
        disabled={!player}
        aria-busy={busy}
        aria-label={playing ? "暂停" : "播放"}
      >
        {busy ? <Loader2 size={16} className="spin" /> : playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
      </button>
      {current.cover && <img className="mini-cover" src={current.cover} alt="" />}
      <div
        className="mini-meta"
        role="button"
        tabIndex={0}
        onClick={() => openEpisode(current)}
        onKeyDown={(e) => e.key === "Enter" && openEpisode(current)}
      >
        <p className="ep-name">{current.title}</p>
        {current.showTitle && <p className="meta-line">{showName(current.showTitle)}</p>}
        <div className="bar">
          <div style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}
