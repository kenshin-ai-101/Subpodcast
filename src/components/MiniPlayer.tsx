/**
 * [INPUT]: store.current / view / playing / player / time / length / loadingSince
 * [OUTPUT]: MiniPlayer — 非单集页音频迷你条（进度条可拖/点跳转）
 * [POS]: App 根挂载；纯音频离页续听入口（对齐 Subcast 迷你条行为）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { Loader2, Pause, Play, X } from "lucide-react";
import { pauseAudioHost, releaseAudioHost } from "../lib/audioHost";
import { clock } from "../lib/format";
import { useT } from "../lib/i18n";
import { pressPlay } from "../lib/playback";
import { showName } from "../lib/picks";
import { pauseYoutubeHost } from "../lib/ytHost";
import { useStore } from "../store";
import { useVideoFloating } from "./YtEngine";

function LoadingIcon({ size }: { size: number }) {
  return (
    <span className="loading-icon">
      <Loader2 size={size} className="spin" />
      <Pause size={size} fill="currentColor" className="loading-cancel" />
    </span>
  );
}

export function MiniPlayer() {
  const t = useT();
  const floatingEpId = useVideoFloating((s) => s.epId);
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
  const [dragRatio, setDragRatio] = useState<number | null>(null);

  // 全屏舞台、视频浮窗展示本集或正在当前单集页时不显示
  if (!current || theater) return null;
  if (floatingEpId === current.id) return null;
  if (view.kind === "episode" && view.id === current.id) return null;

  const ratioFrom = (el: HTMLDivElement, clientX: number) => {
    const rect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
  };
  const onSeekDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (!player || !length) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragRatio(ratioFrom(e.currentTarget, e.clientX));
  };
  const onSeekMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRatio == null) return;
    e.stopPropagation();
    setDragRatio(ratioFrom(e.currentTarget, e.clientX));
  };
  const onSeekUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRatio == null) return;
    e.stopPropagation();
    const r = ratioFrom(e.currentTarget, e.clientX);
    setDragRatio(null);
    if (player && length) player.seek(r * length);
  };

  const shownTime = dragRatio != null && length ? Math.round(dragRatio * length) : time;
  const shownPct = dragRatio != null ? dragRatio * 100 : length ? Math.min(100, (time / length) * 100) : 0;
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
        className={`play-btn sm${busy ? " loading" : ""}`}
        onClick={() => pressPlay()}
        disabled={!player && !busy}
        aria-busy={busy}
        title={busy ? t("正在加载…（点击取消）") : playing ? t("暂停") : t("播放")}
        aria-label={busy ? t("正在加载…（点击取消）") : playing ? t("暂停") : t("播放")}
      >
        {busy ? (
          <LoadingIcon size={16} />
        ) : playing ? (
          <Pause size={16} fill="currentColor" />
        ) : (
          <Play size={16} fill="currentColor" />
        )}
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
        <div className="mini-sub">
          {current.showTitle && <p className="meta-line">{showName(current.showTitle)}</p>}
          <span className="mini-time">
            {clock(shownTime)}
            {length ? ` / ${clock(length)}` : ""}
          </span>
        </div>
        <div
          className={`mini-seek${dragRatio != null ? " dragging" : ""}`}
          role="slider"
          aria-label={t("播放进度")}
          aria-valuemin={0}
          aria-valuemax={Math.max(1, Math.round(length))}
          aria-valuenow={shownTime}
          title={t("点击或拖动跳转进度")}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={onSeekDown}
          onPointerMove={onSeekMove}
          onPointerUp={onSeekUp}
          onPointerCancel={() => setDragRatio(null)}
        >
          <div className="bar">
            <div style={{ width: `${shownPct}%` }} />
          </div>
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
