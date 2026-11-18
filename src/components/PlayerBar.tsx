/**
 * [INPUT]: store.current / time / player / settings；queue.playNext；offline.audioSrc；youtube / playback / volume
 * [OUTPUT]: 媒体切换（视频/仅音频）+ YT.Player 舞台 + 叠字幕 + Controls
 * [POS]: 单集左栏播放引擎；切换条经 media-switch-row 与画面同宽靠右
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Pause, Play, RotateCcw, RotateCw, Volume1, Volume2, VolumeX } from "lucide-react";
import type { Episode } from "../lib/api";
import { clock } from "../lib/format";
import { useJobs } from "../lib/jobs";
import { noteListening } from "../lib/listening";
import { audioSrc, useOffline } from "../lib/offline";
import { activeIndex, flushProgress, resetTrackSave, track, waiting } from "../lib/playback";
import { playNext } from "../lib/queue";
import { applyYtPlayerVolume, followVolume, setLevel, toggleMute, useVolume } from "../lib/volume";
import { hideYouTubeCaptions, loadYouTube, type YtPlayer } from "../lib/youtube";
import { useStore } from "../store";
import { SubtitleOverlay } from "./SubtitleOverlay";

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const TICK_MS = 250;
const UNPLAYABLE = "这个视频无法在应用内播放，已切换为音频";

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
  const { current, time, length, playing, rate, set } = useStore(
    useShallow((s) => ({
      current: s.current,
      time: s.time,
      length: s.length,
      playing: s.playing,
      rate: s.rate,
      set: s.set,
    })),
  );
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const ytRef = useRef<YtPlayer | null>(null);
  const tickRef = useRef<number | undefined>(undefined);
  const switchRef = useRef<(audio: boolean, why?: string) => void>(() => {});
  /** 完整单集快照（含 videoId），不随切换剥掉 */
  const [source, setSource] = useState<Episode | null>(current);
  const transcript = useJobs((s) => (current ? s.transcripts[current.id] : undefined));
  const items = useJobs((s) => (current ? s.translations[current.id]?.items : undefined));
  const mode = useStore((s) => s.settings.subtitleMode);
  const nextLine = useStore((s) => s.settings.audioNextLine === true);
  const saved = useOffline((s) => (source ? s.saved[source.id] : undefined));

  const [audioMode, setAudioMode] = useState(false);
  const [ytError, setYtError] = useState<string | null>(null);

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

  useEffect(() => {
    setAudioMode(false);
    setYtError(null);
    resetTrackSave();
  }, [current?.id]);

  const videoId = source?.videoId ?? undefined;
  const canVideo = !!videoId;
  const fileSrc = source ? audioSrc(source) : undefined;
  const hasFile = !!fileSrc;
  // 有视频即可切换：有音频文件走 <audio>；纯 YouTube 用隐藏 YT 当引擎
  const canSwitch = canVideo;
  const showVideo = canVideo && !audioMode;
  const useAudioEl = hasFile && (!canVideo || audioMode);
  const useYtEngine = canVideo && (!audioMode || !hasFile);

  // ---- 音频元素 ----
  useEffect(() => {
    const el = audioRef.current;
    if (!useAudioEl) {
      el?.pause();
      return;
    }
    if (!el || !fileSrc || !current || !source) return;
    const t = useStore.getState().time || current.progress || 0;
    const same = el.src === fileSrc || el.src.endsWith(fileSrc);
    if (!same) el.src = fileSrc;
    const seekWhenReady = () => {
      try {
        if (t > 0.5) el.currentTime = t;
      } catch {
        /* 元数据未就绪 */
      }
    };
    if (el.readyState >= 1) seekWhenReady();
    else el.addEventListener("loadedmetadata", seekWhenReady, { once: true });
    el.playbackRate = useStore.getState().rate;
    const shouldPlay = useStore.getState().playWhenReady;
    if (shouldPlay) {
      waiting(true);
      void el
        .play()
        .then(() => {
          waiting(false);
          set({ playing: true, playWhenReady: false });
        })
        .catch(() => {
          waiting(false);
          set({ playing: false, playWhenReady: false });
        });
    }
    return () => el.removeEventListener("loadedmetadata", seekWhenReady);
  }, [current?.id, useAudioEl, fileSrc, saved?.path]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el || !useAudioEl) return;
    el.playbackRate = rate;
  }, [rate, useAudioEl]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el || !useAudioEl) return;
    return followVolume(el);
  }, [useAudioEl, current?.id]);

  // ---- YouTube IFrame Player ----
  useEffect(() => {
    if (!useYtEngine || !videoId || !mountRef.current || !current) return;
    let cancelled = false;
    let player: YtPlayer | null = null;
    const ep = current;
    const startAt = Math.floor(useStore.getState().time || ep.progress || 0);

    const stopTick = () => {
      if (tickRef.current) {
        window.clearInterval(tickRef.current);
        tickRef.current = undefined;
      }
    };
    const startTick = (p: YtPlayer) => {
      stopTick();
      tickRef.current = window.setInterval(() => {
        try {
          const t = p.getCurrentTime();
          const d = p.getDuration();
          track(ep, t, d);
          noteListening(ep, useStore.getState().playing);
        } catch {
          /* player mid-destroy */
        }
      }, TICK_MS);
    };

    waiting(true);
    setYtError(null);

    void loadYouTube()
      .then((YT) => {
        if (cancelled || !mountRef.current) return;
        mountRef.current.innerHTML = "";
        const host = document.createElement("div");
        mountRef.current.appendChild(host);
        player = new YT.Player(host, {
          videoId,
          width: "100%",
          height: "100%",
          playerVars: {
            autoplay: useStore.getState().playWhenReady ? 1 : 0,
            start: startAt > 0 ? startAt : undefined,
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            cc_load_policy: 0,
            iv_load_policy: 3,
            enablejsapi: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: (e: { target: YtPlayer }) => {
              if (cancelled) return;
              const p = e.target;
              ytRef.current = p;
              applyYtPlayerVolume(p);
              hideYouTubeCaptions(p);
              try {
                p.setPlaybackRate(useStore.getState().rate);
              } catch {
                /* rate not supported yet */
              }
              if (startAt > 0) p.seekTo(startAt, true);
              const should = useStore.getState().playWhenReady;
              if (should) {
                p.playVideo();
                set({ playWhenReady: false });
              } else {
                p.pauseVideo();
              }
              waiting(false);
              startTick(p);
            },
            onStateChange: (e: { data: number; target: YtPlayer }) => {
              if (cancelled) return;
              const YT = window.YT;
              if (!YT) return;
              hideYouTubeCaptions(e.target);
              if (e.data === YT.PlayerState.PLAYING) {
                waiting(false);
                set({ playing: true });
                startTick(e.target);
              } else if (e.data === YT.PlayerState.PAUSED) {
                set({ playing: false });
                try {
                  flushProgress(ep, e.target.getCurrentTime());
                } catch {
                  /* ignore */
                }
              } else if (e.data === YT.PlayerState.BUFFERING) {
                waiting(true);
              } else if (e.data === YT.PlayerState.ENDED) {
                stopTick();
                set({ playing: false });
                try {
                  const d = e.target.getDuration() || useStore.getState().time;
                  flushProgress(ep, d);
                } catch {
                  /* ignore */
                }
                void playNext();
              }
            },
            onError: () => {
              if (cancelled) return;
              waiting(false);
              set({ playing: false });
              if (hasFile) switchRef.current(true, UNPLAYABLE);
              else {
                setYtError("这集视频暂时播不了");
                useStore.getState().notify("这集视频暂时播不了");
              }
            },
          },
        }) as YtPlayer;
        ytRef.current = player;
      })
      .catch((err: Error) => {
        if (cancelled) return;
        waiting(false);
        if (hasFile) switchRef.current(true, UNPLAYABLE);
        else {
          setYtError(err.message || "无法加载 YouTube 播放器");
          useStore.getState().notify(err.message || "无法加载 YouTube 播放器");
        }
      });

    const unsubVol = useVolume.subscribe(() => applyYtPlayerVolume(ytRef.current));

    return () => {
      cancelled = true;
      stopTick();
      unsubVol();
      try {
        ytRef.current?.destroy();
      } catch {
        /* already gone */
      }
      ytRef.current = null;
      if (mountRef.current) mountRef.current.innerHTML = "";
    };
  }, [useYtEngine, current?.id, videoId]);

  useEffect(() => {
    if (!useYtEngine || !ytRef.current) return;
    try {
      ytRef.current.setPlaybackRate(rate);
    } catch {
      /* ignore */
    }
  }, [rate, useYtEngine]);

  useEffect(() => {
    if (!current) return;
    set({
      player: {
        seek(seconds) {
          set({ time: seconds });
          if (useAudioEl && audioRef.current) audioRef.current.currentTime = seconds;
          else if (useYtEngine && ytRef.current) ytRef.current.seekTo(seconds, true);
        },
        toggle() {
          if (useAudioEl && audioRef.current) {
            if (audioRef.current.paused) void audioRef.current.play();
            else audioRef.current.pause();
            return;
          }
          const p = ytRef.current;
          if (!p || !window.YT) return;
          const state = p.getPlayerState();
          if (state === window.YT.PlayerState.PLAYING) p.pauseVideo();
          else p.playVideo();
        },
        play() {
          if (useAudioEl) void audioRef.current?.play();
          else ytRef.current?.playVideo();
        },
        setRate(r) {
          set({ rate: r });
          void useStore.getState().saveSettings({ playbackRate: r });
          if (useAudioEl && audioRef.current) audioRef.current.playbackRate = r;
          else {
            try {
              ytRef.current?.setPlaybackRate(r);
            } catch {
              /* ignore */
            }
          }
        },
      },
    });
  }, [current?.id, useAudioEl, useYtEngine]);

  const switchTo = (audio: boolean, why?: string) => {
    if (!current || !source || !canVideo) return;
    if (audio === audioMode) return;
    const s = useStore.getState();
    let t = s.time;
    try {
      if (audio && ytRef.current) t = ytRef.current.getCurrentTime();
      else if (!audio && audioRef.current && useAudioEl) t = audioRef.current.currentTime;
    } catch {
      /* keep t */
    }
    flushProgress(source, t);
    // 正在播或仍在缓冲 → 切过去后自动续播
    const wanted = !!s.loadingSince || s.playing;
    // 无独立音轨时视频↔仅音频共用同一 YT 实例，不会走 effect 重建
    const sameYtEngine = !hasFile;
    try {
      if (audio && hasFile) ytRef.current?.pauseVideo();
      else if (!audio && hasFile) audioRef.current?.pause();
      else if (!wanted) ytRef.current?.pauseVideo();
    } catch {
      /* ignore */
    }
    setAudioMode(audio);
    setYtError(null);
    set({
      current: { ...source, progress: t },
      time: t,
      player: null,
      playing: false,
      loadingSince: null,
      playWhenReady: wanted && !sameYtEngine,
    });
    if (sameYtEngine && wanted) {
      window.setTimeout(() => {
        try {
          ytRef.current?.seekTo(t, true);
          ytRef.current?.playVideo();
        } catch {
          /* ignore */
        }
      }, 0);
    }
    if (why) s.notify(why);
  };
  switchRef.current = switchTo;

  if (!current || !source) return null;

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
              aria-checked={!audioMode}
              className={!audioMode ? "on" : ""}
              onClick={() => audioMode && switchTo(false)}
            >
              视频
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={audioMode}
              className={audioMode ? "on" : ""}
              onClick={() => !audioMode && switchTo(true)}
            >
              仅音频
            </button>
          </div>
        </div>
      )}

      {useYtEngine && (
        <div className={`video${audioMode ? " yt-as-audio" : ""}`}>
          <div className="yt-mount" ref={mountRef} />
          {!audioMode && <div className="yt-shield" aria-hidden />}
          {!audioMode && <SubtitleOverlay episodeId={current.id} />}
          {ytError && !hasFile && !audioMode && (
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
            onClick={() => useStore.getState().player?.toggle()}
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

      {hasFile && (
        <audio
          ref={audioRef}
          preload="metadata"
          style={{ display: useAudioEl ? undefined : "none" }}
          onPlay={() => {
            waiting(false);
            set({ playing: true });
          }}
          onPause={() => {
            set({ playing: false });
            if (useAudioEl) flushProgress(source, audioRef.current?.currentTime ?? time);
          }}
          onWaiting={() => waiting(true)}
          onPlaying={() => waiting(false)}
          onTimeUpdate={(e) => {
            if (!useAudioEl) return;
            track(source, e.currentTarget.currentTime, e.currentTarget.duration);
            noteListening(source, !e.currentTarget.paused);
          }}
          onLoadedMetadata={(e) => {
            if (useAudioEl) set({ length: e.currentTarget.duration || 0 });
          }}
          onEnded={() => {
            if (!useAudioEl) return;
            flushProgress(source, source.duration || time);
            void playNext();
          }}
        />
      )}
    </>
  );
}
