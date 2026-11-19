/**
 * [INPUT]: store.current / time / audioOnly / playing；jobs 字幕；offline；YtEngine.VideoSlot
 * [OUTPUT]: 媒体切换 + 封面舞台 / 视频槽 + Controls（引擎在 App 根）
 * [POS]: 单集左栏播控 UI；音/视频由 AudioEngine / YtEngine 起播
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Pause, Play, RotateCcw, RotateCw, Volume1, Volume2, VolumeX } from "lucide-react";
import type { Episode } from "../lib/api";
import { clock } from "../lib/format";
import { useJobs } from "../lib/jobs";
import { prepareAudio, pauseAudioHost, releaseAudioHost } from "../lib/audioHost";
import { preferAudio } from "../lib/media";
import { audioSrc, useOffline } from "../lib/offline";
import { activeIndex, flushProgress, playSoon } from "../lib/playback";
import { setLevel, toggleMute, useVolume } from "../lib/volume";
import { kickYoutube } from "../lib/ytKick";
import { useStore } from "../store";
import { SubtitleOverlay } from "./SubtitleOverlay";
import { useYtUi, VideoSlot } from "./YtEngine";

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

function VolumeControl() {
  const { level, muted } = useVolume(useShallow((s) => ({ level: s.level, muted: s.muted })));
  const shown = muted ? 0 : level;
  const Icon = shown === 0 ? VolumeX : shown < 0.5 ? Volume1 : Volume2;
  const pct = Math.round(shown * 100);
  return (
    <div
      className="volume"
      onWheel={(e) => {
        if (e.deltaY) setLevel(shown - Math.sign(e.deltaY) * 0.05);
      }}
    >
      <button
        type="button"
        className="icon-btn"
        onClick={() => toggleMute()}
        title={muted ? "取消静音（M）" : "静音（M）"}
        aria-label={muted ? "取消静音" : "静音"}
      >
        <Icon size={17} />
      </button>
      <input
        className="seek volume-slider"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={shown}
        onChange={(e) => setLevel(Number(e.target.value))}
        style={{ "--fill": `${pct}%` } as React.CSSProperties}
        aria-label="音量"
        aria-valuetext={`${pct}%`}
        title={`音量 ${pct}%`}
      />
    </div>
  );
}

export function PlayerBar() {
  const { current, time, length, playing, rate, audioOnly, set } = useStore(
    useShallow((s) => ({
      current: s.current,
      time: s.time,
      length: s.length,
      playing: s.playing,
      rate: s.rate,
      audioOnly: s.audioOnly,
      set: s.set,
    })),
  );
  const [source, setSource] = useState<Episode | null>(current);
  const transcript = useJobs((s) => (current ? s.transcripts[current.id] : undefined));
  const items = useJobs((s) => (current ? s.translations[current.id]?.items : undefined));
  const mode = useStore((s) => s.settings.subtitleMode);
  const nextLine = useStore((s) => s.settings.audioNextLine === true);
  const saved = useOffline((s) => (source ? s.saved[source.id] : undefined));
  const ytError = useYtUi((s) => s.error);

  useEffect(() => {
    if (!current) {
      setSource(null);
      return;
    }
    setSource((prev) => {
      if (!prev || prev.id !== current.id) return current;
      return {
        ...current,
        videoId: current.videoId ?? prev.videoId,
        audioUrl: current.audioUrl ?? prev.audioUrl,
        cover: current.cover ?? prev.cover,
      };
    });
  }, [current?.id, current?.videoId, current?.audioUrl, current?.cover]);

  if (!current || !source) return null;

  const videoId = source.videoId ?? undefined;
  const canVideo = !!videoId;
  const hasFile = !!audioSrc(source) || !!saved;
  const canSwitch = canVideo;
  const showVideo = canVideo && !audioOnly;

  const switchTo = (audio: boolean, why?: string) => {
    if (!canVideo || audio === audioOnly) return;
    const s = useStore.getState();
    const t = s.time;
    flushProgress(source, t);
    const wanted = !!s.loadingSince || s.playing;
    // 无独立音轨：视频↔仅音频仍是同一 YT 引擎
    const sameYt = !preferAudio(source);
    const ep = { ...source, progress: t };
    set({
      current: ep,
      time: t,
      audioOnly: audio,
      playing: sameYt ? s.playing : false,
      loadingSince: null,
      playWhenReady: null,
      player: sameYt ? s.player : null,
    });
    if (sameYt) {
      if (wanted) window.setTimeout(() => useStore.getState().player?.play(), 0);
    } else if (audio && preferAudio(ep)) {
      pauseAudioHost();
      prepareAudio(ep);
      if (wanted) playSoon(ep.id);
    } else {
      pauseAudioHost();
      releaseAudioHost();
      kickYoutube(ep, { time: t, play: false });
      if (wanted) playSoon(ep.id);
    }
    if (why) s.notify(why);
  };

  const coverToggle = () => {
    const s = useStore.getState();
    if (s.current?.id === source.id) {
      s.player?.toggle();
      return;
    }
    s.load(source);
    playSoon(source.id);
  };

  const fill = `${length ? Math.min(100, (time / length) * 100) : 0}%`;
  const segs = transcript?.segments ?? [];
  const i = segs.length ? activeIndex(segs.map((s) => s.start), time) : -1;
  const showI = nextLine && i >= 0 && i + 1 < segs.length ? i + 1 : i;
  const seg = showI >= 0 ? segs[showI] : null;
  const zh = showI >= 0 ? items?.[showI] : null;

  return (
    <>
      {canSwitch && (
        <div className="media-switch-row">
          <div className="media-switch seg-control" role="radiogroup" aria-label="播放方式">
            <button
              type="button"
              role="radio"
              aria-checked={!audioOnly}
              className={!audioOnly ? "on" : ""}
              onClick={() => audioOnly && switchTo(false)}
            >
              视频
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={audioOnly}
              className={audioOnly ? "on" : ""}
              onClick={() => !audioOnly && switchTo(true)}
            >
              仅音频
            </button>
          </div>
        </div>
      )}

      {showVideo && (
        <div className="video">
          <VideoSlot />
          <div className="yt-shield" aria-hidden />
          <SubtitleOverlay episodeId={current.id} />
          {ytError && !hasFile && (
            <div className="yt-fallback">
              <p>{ytError}</p>
            </div>
          )}
        </div>
      )}

      {!showVideo && (
        <div className="audio-stage">
          <button
            type="button"
            className="cover-play"
            onClick={coverToggle}
            title={playing ? "暂停（空格）" : "播放（空格）"}
            aria-label={playing ? "暂停" : "播放"}
          >
            {source.cover ? <img src={source.cover} alt="" /> : <span className="cover-fallback" />}
            <span className={`cover-play-btn ${playing ? "playing" : ""}`}>
              {playing ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" />}
            </span>
          </button>
          {seg && (
            <div className="audio-sub">
              {mode !== "original" && zh && <p className="sub-zh">{zh}</p>}
              {mode !== "translation" && <p className="sub-orig">{seg.text}</p>}
            </div>
          )}
        </div>
      )}

      <div className="controls">
        <button type="button" className="icon-btn" title="后退 15 秒" onClick={() => useStore.getState().player?.seek(Math.max(0, time - 15))}>
          <RotateCcw size={16} />
        </button>
        <button type="button" className="play-btn" onClick={() => useStore.getState().player?.toggle()} aria-label={playing ? "暂停" : "播放"}>
          {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
        </button>
        <button type="button" className="icon-btn" title="前进 30 秒" onClick={() => useStore.getState().player?.seek(time + 30)}>
          <RotateCw size={16} />
        </button>
        <span className="time">{clock(time)}</span>
        <input
          className="seek"
          type="range"
          min={0}
          max={Math.max(length, 1)}
          step={0.1}
          value={Math.min(time, length || time)}
          style={{ "--fill": fill } as React.CSSProperties}
          onChange={(e) => useStore.getState().player?.seek(Number(e.target.value))}
        />
        <span className="time">{clock(length)}</span>
        <VolumeControl />
        <button
          type="button"
          className={`rate-btn${rate >= 2 ? " fast" : ""}`}
          title="播放速度"
          onClick={() => {
            const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length] ?? 1;
            useStore.getState().player?.setRate(next);
          }}
        >
          {rate}x
        </button>
      </div>
    </>
  );
}
