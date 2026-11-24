/**
 * [INPUT]: store.current / view / playing / player / time / length / loadingSince
 * [OUTPUT]: MiniPlayer — 非单集页时的音频迷你条
 * [POS]: App 根挂载；纯音频离页续听入口（对齐 Subcast 迷你条行为）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useShallow } from "zustand/react/shallow";
import { Loader2, Pause, Play, X } from "lucide-react";
import { pauseAudioHost, releaseAudioHost } from "../lib/audioHost";
import { useT } from "../lib/i18n";
import { showName } from "../lib/picks";
import { pauseYoutubeHost } from "../lib/ytHost";
import { useStore } from "../store";

export function MiniPlayer() {
  const t = useT();
  const { current, view, playing, player, time, length, loadingSince, theater, openEpisode, set } = useStore(
    useShallow((s) => ({
      current: s.current,
      view: s.view,
      playing: s.playing,
      player: s.player,
      time: Math.floor(s.rawTime ?? s.time),
      length: s.length,
      loadingSince: s.loadingSince,
      theater: s.theater,
      openEpisode: s.openEpisode,
      set: s.set,
    })),
  );

  // 全屏舞台或正在当前单集页时不显示；离页播放（含视频离页后台播）始终保留控播与返回入口
  if (!current || theater) return null;
  if (view.kind === "episode" && view.id === current.id) return null;

  const pct = length ? Math.min(100, (time / length) * 100) : 0;
  const busy = !!loadingSince;
  const dismiss = () => {
    pauseAudioHost();
    releaseAudioHost();
    pauseYoutubeHost();
    set({ current: null, playing: false, loadingSince: null, playWhenReady: null, player: null });
  };

  return (
    <div className="mini">
      <button
        type="button"
        className="play-btn sm"
        onClick={() => player?.toggle()}
        disabled={!player}
        aria-busy={busy}
        aria-label={playing ? t("暂停") : t("播放")}
      >
        {busy ? <Loader2 size={16} className="spin" /> : playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
      </button>
      {current.cover && <img className="mini-cover" src={current.cover} alt="" />}
      <div
        className="mini-meta"
        role="button"
        tabIndex={0}
        title={t("返回单集")}
        onClick={() => openEpisode(current)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openEpisode(current);
          }
        }}
      >
        <p className="ep-name">{current.title}</p>
        {current.showTitle && <p className="meta-line">{showName(current.showTitle)}</p>}
        <div className="bar">
          <div style={{ width: `${pct}%` }} />
        </div>
      </div>
      <button
        type="button"
        className="icon-btn sm"
        title={t("关闭迷你播放器")}
        aria-label={t("关闭迷你播放器")}
        onClick={dismiss}
      >
        <X size={15} />
      </button>
    </div>
  );
}
