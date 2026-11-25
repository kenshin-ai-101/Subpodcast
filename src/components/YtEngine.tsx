/**
 * [INPUT]: store.current / audioOnly / playWhenReady / rate / theater；media.usesYtEngine；youtube / mediaClock / playback / volume；api.youtubeStream
 * [OUTPUT]: VideoSlot + YtEngine（App 根持久 iframe + 可选 `<video class="video-native">`）；useYtUi.error / note
 * [POS]: embed（controls:0 + .crop）优先；错误 / 卡住 ~20s / 慢加载 8s → native-hls（mac）再 mp4；失活 stop+mute；rAF+mediaClock 驱动字幕
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { listen } from "@tauri-apps/api/event";
import { ExternalLink, X } from "lucide-react";
import { api, errText } from "../lib/api";
import { pauseAudioHost, releaseAudioHost, takeAudioEngine } from "../lib/audioHost";
import { tNow, useT } from "../lib/i18n";
import { useLayout } from "../lib/layout";
import { noteListening } from "../lib/listening";
import { preferAudio, usesYtEngine } from "../lib/media";
import { createMediaClock } from "../lib/mediaClock";
import { audioSrc } from "../lib/offline";
import { flushProgress, resetTrackSave, track, waiting } from "../lib/playback";
import { playNext } from "../lib/queue";
import { currentMap, toContent } from "../lib/timemap";
import { applyYtPlayerVolume, followVolume, useVolume } from "../lib/volume";
import { hideYouTubeCaptions, loadYouTube, type YtPlayer } from "../lib/youtube";
import { registerYtHost } from "../lib/ytHost";
import { useYtKick } from "../lib/ytKick";
import { offerPlayer, useStore, withdrawPlayer, type PlayerHandle } from "../store";
import { SubtitleOverlay } from "./SubtitleOverlay";

/** 叠字要跟口型：约 20Hz 采样；getCurrentTime 粗跳时靠 mediaClock 外推。 */
const TICK_MS = 50;
/** 点了播放却迟迟进不了 PLAYING：改直连。 */
const EMBED_START_WAIT = 20_000;
/** 加载偏慢也自动改直连（比只提示更积极）。 */
const SLOW_FALLBACK = 8_000;
/** 等 yt-dlp / 解析地址的上限。 */
const STREAM_WAIT = 40_000;
/** 直连流一直拿不到 metadata 则换下一种方式。 */
const STALL_WAIT = 20_000;

type StreamMode = "native-hls" | "mp4";
type NativeStream = { url: string; kind: "hls" | "mp4" };

const canNativeHls = () =>
  typeof document !== "undefined" &&
  document.createElement("video").canPlayType("application/vnd.apple.mpegurl") !== "";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(tNow("获取视频地址超时，请检查网络或代理"))),
      ms,
    );
    p.then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export const useYtUi = create<{ error: string | null; note: string | null }>(() => ({
  error: null,
  note: null,
}));

/** 离页悬浮视频小窗当前归属的单集 id；MiniPlayer 据此避让。 */
export const useVideoFloating = create<{ epId: string | null }>(() => ({ epId: null }));

const useSlot = create<{ el: HTMLElement | null }>(() => ({ el: null }));

/** 单集页视频坑：引擎 CSS 贴合，iframe 不随页面卸载销毁。 */
export function VideoSlot() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    useSlot.setState({ el });
    return () => {
      useSlot.setState((s) => (s.el === el ? { el: null } : s));
    };
  }, []);
  return <div className="yt-slot" ref={ref} />;
}

function fallbackToAudio() {
  const s = useStore.getState();
  const cur = s.current;
  const id = cur?.id;
  const wanted = !!s.loadingSince || s.playing;
  useYtUi.setState({ note: null });
  s.set({
    audioOnly: true,
    playWhenReady: null,
    player: null,
  });
  if (cur && preferAudio(cur)) takeAudioEngine(cur, { play: wanted });
  else if (id) s.set({ playWhenReady: id });
  s.notify(tNow("这个视频无法在应用内播放，已切换为音频"));
}

export function YtEngine() {
  const t = useT();
  const { current, audioOnly, playWhenReady, rate, theater, playing } = useStore(
    useShallow((s) => ({
      current: s.current,
      audioOnly: s.audioOnly,
      playWhenReady: s.playWhenReady,
      rate: s.rate,
      theater: s.theater,
      playing: s.playing,
    })),
  );
  const slotEl = useSlot((s) => s.el);
  const floatingEpId = useVideoFloating((s) => s.epId);
  const kick = useYtKick((s) => s.kick);
  const boxRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const ytRef = useRef<YtPlayer | null>(null);
  const videoIdRef = useRef<string | null>(null);
  const epRef = useRef(current);
  const tickRef = useRef<number | undefined>(undefined);
  const handleRef = useRef<PlayerHandle | null>(null);
  const lastKickGen = useRef(0);
  const clockRef = useRef(createMediaClock());
  /** 复用 iframe 换片后，在新片进入 PLAYING/CUED 前忽略旧片残留的 getCurrentTime。 */
  const switchingRef = useRef(false);
  const [native, setNative] = useState<NativeStream | null>(null);
  const nativeRef = useRef<NativeStream | null>(null);
  const streamPlanRef = useRef<StreamMode[]>([]);
  const resolvingStreamRef = useRef(false);
  const streamModeRef = useRef<StreamMode | null>(null);
  const streamLoadedRef = useRef(false);
  const streamRefreshedRef = useRef(false);
  const embedStartTimerRef = useRef<number | undefined>(undefined);
  const slowFallbackTimerRef = useRef<number | undefined>(undefined);
  const streamStallTimerRef = useRef<number | undefined>(undefined);
  const usingNativeRef = useRef(false);
  /** 直连也失败且无音频可退：别再重建 embed，避免死循环。 */
  const streamGaveUpRef = useRef(false);

  const ytRate = (r: number) => Math.min(2, Math.max(0.25, Number.isFinite(r) && r > 0 ? r : 1));

  const active = usesYtEngine(current, audioOnly);
  const videoId = active ? current?.videoId ?? kick?.videoId ?? null : null;
  const shell = !!(active && current && audioOnly && !audioSrc(current));
  const floating = Boolean(active && !shell && !slotEl && current && floatingEpId === current.id);
  epRef.current = current;
  nativeRef.current = native;
  usingNativeRef.current = !!native;

  // 离页时若视频正在播放则切入右下角悬浮小窗；回到单集页、切集或停用视频引擎则收起
  useEffect(() => {
    if (!active || shell || !current || slotEl) {
      if (useVideoFloating.getState().epId !== null) {
        useVideoFloating.setState({ epId: null });
      }
      return;
    }
    const curFloat = useVideoFloating.getState().epId;
    if (curFloat && curFloat !== current.id) {
      useVideoFloating.setState({ epId: playing ? current.id : null });
      return;
    }
    if (!curFloat && playing) {
      useVideoFloating.setState({ epId: current.id });
    }
  }, [active, shell, slotEl, current?.id, playing]);

  const clearEmbedTimers = () => {
    if (embedStartTimerRef.current) {
      window.clearTimeout(embedStartTimerRef.current);
      embedStartTimerRef.current = undefined;
    }
    if (slowFallbackTimerRef.current) {
      window.clearTimeout(slowFallbackTimerRef.current);
      slowFallbackTimerRef.current = undefined;
    }
  };

  const stopTick = () => {
    if (tickRef.current) {
      window.cancelAnimationFrame(tickRef.current);
      tickRef.current = undefined;
    }
  };

  const startTickYt = (p: YtPlayer, epId: string) => {
    stopTick();
    const clock = clockRef.current;
    clock.setRate(ytRate(useStore.getState().rate));
    let lastSample = 0;
    const step = (now: number) => {
      tickRef.current = window.requestAnimationFrame(step);
      if (now - lastSample < TICK_MS) return;
      lastSample = now;
      if (usingNativeRef.current) return;
      const ep = epRef.current;
      if (!ep || ep.id !== epId) return;
      if (switchingRef.current) return;
      try {
        if (!window.YT) return;
        const state = p.getPlayerState();
        if (
          state !== window.YT.PlayerState.PLAYING &&
          state !== window.YT.PlayerState.PAUSED &&
          state !== window.YT.PlayerState.BUFFERING
        ) {
          const dur = p.getDuration();
          const st = useStore.getState();
          if (dur > 0 && dur !== st.length) st.set({ length: dur });
          return;
        }
        const isPlaying = state === window.YT.PlayerState.PLAYING;
        clock.setPlaying(isPlaying);
        if (!isPlaying && state !== window.YT.PlayerState.PAUSED) {
          clock.setPlaying(false);
        }
        const raw = p.getCurrentTime();
        const smooth = clock.sample(raw);
        track(ep, smooth, p.getDuration());
        noteListening(ep, isPlaying);
      } catch {
        /* mid-destroy */
      }
    };
    tickRef.current = window.requestAnimationFrame(step);
  };

  const startTickVideo = (el: HTMLVideoElement, epId: string) => {
    stopTick();
    const clock = clockRef.current;
    clock.setRate(ytRate(useStore.getState().rate));
    let lastSample = 0;
    const step = (now: number) => {
      tickRef.current = window.requestAnimationFrame(step);
      if (now - lastSample < TICK_MS) return;
      lastSample = now;
      const ep = epRef.current;
      if (!ep || ep.id !== epId) return;
      const isPlaying = !el.paused && !el.ended;
      clock.setPlaying(isPlaying);
      const smooth = clock.sample(el.currentTime);
      track(ep, smooth, el.duration || undefined);
      noteListening(ep, isPlaying);
    };
    tickRef.current = window.requestAnimationFrame(step);
  };

  const offerYt = (p: YtPlayer, episodeId: string) => {
    const handle: PlayerHandle = {
      episodeId,
      seek(seconds) {
        switchingRef.current = false;
        let origin = useStore.getState().rawTime ?? useStore.getState().time;
        try {
          const cur = p.getCurrentTime();
          if (Number.isFinite(cur)) origin = cur;
        } catch {
          /* ignore */
        }
        clockRef.current.seek(seconds, origin);
        useStore.getState().set({ time: seconds, rawTime: seconds, gapEnd: null, scrubTime: null });
        p.seekTo(seconds, true);
      },
      toggle() {
        if (!window.YT) return;
        const st = p.getPlayerState();
        const loading = !!useStore.getState().loadingSince;
        if (
          st === window.YT.PlayerState.PLAYING ||
          st === window.YT.PlayerState.BUFFERING ||
          loading
        ) {
          clearEmbedTimers();
          p.pauseVideo();
          waiting(false);
          useStore.getState().set({ playWhenReady: null, playing: false });
        } else {
          waiting(true);
          armEmbedWatchdogs();
          p.playVideo();
        }
      },
      play() {
        waiting(true);
        armEmbedWatchdogs();
        p.playVideo();
      },
      setRate(r) {
        useStore.getState().set({ rate: r });
        void useStore.getState().saveSettings({ playbackRate: r });
        const applied = ytRate(r);
        clockRef.current.setRate(applied);
        try {
          p.setPlaybackRate(applied);
        } catch {
          /* ignore */
        }
      },
    };
    handleRef.current = handle;
    offerPlayer(handle);
  };

  const offerVideo = (el: HTMLVideoElement, episodeId: string) => {
    const handle: PlayerHandle = {
      episodeId,
      seek(seconds) {
        clockRef.current.seek(seconds, el.currentTime);
        useStore.getState().set({ time: seconds, rawTime: seconds, gapEnd: null, scrubTime: null });
        el.currentTime = seconds;
        void el.play().catch(() => {});
      },
      toggle() {
        if (!el.paused || useStore.getState().loadingSince) {
          el.pause();
          waiting(false);
          useStore.getState().set({ playWhenReady: null, playing: false });
        } else {
          waiting(true);
          void el.play().catch(() => {});
        }
      },
      play() {
        waiting(true);
        void el.play().catch(() => {});
      },
      setRate(r) {
        useStore.getState().set({ rate: r });
        void useStore.getState().saveSettings({ playbackRate: r });
        const applied = ytRate(r);
        clockRef.current.setRate(applied);
        el.playbackRate = applied;
      },
    };
    handleRef.current = handle;
    offerPlayer(handle);
  };

  const hardStopYt = () => {
    clearEmbedTimers();
    stopTick();
    const p = ytRef.current;
    if (!p) return;
    try {
      p.stopVideo();
    } catch {
      try {
        p.pauseVideo();
      } catch {
        /* ignore */
      }
    }
    try {
      p.mute();
    } catch {
      /* ignore */
    }
  };

  const stillMine = () => {
    const st = useStore.getState();
    return usesYtEngine(st.current, st.audioOnly);
  };

  const applyNative = (stream: NativeStream & { duration?: number | null }, mode: StreamMode) => {
    streamModeRef.current = mode;
    streamLoadedRef.current = false;
    const s = useStore.getState();
    if (stream.duration && s.current && !s.length) {
      s.set({ length: stream.duration });
    }
    hardStopYt();
    setNative({ url: stream.url, kind: stream.kind });
    useYtUi.setState({ error: null, note: null });
  };

  const giveUpStream = (detail: string) => {
    resolvingStreamRef.current = false;
    useYtUi.setState({ note: null });
    const cur = epRef.current;
    if (cur && audioSrc(cur)) {
      setNative(null);
      fallbackToAudio();
    } else {
      streamGaveUpRef.current = true;
      setNative(null);
      waiting(false);
      useStore.getState().set({ playing: false });
      useYtUi.setState({ error: detail || tNow("这集视频暂时播不了") });
      useStore.getState().notify(detail || tNow("这集视频暂时播不了"));
    }
  };

  const tryNextStream = () => {
    if (resolvingStreamRef.current) return;
    if (streamLoadedRef.current && streamModeRef.current && !streamRefreshedRef.current) {
      streamPlanRef.current.unshift(streamModeRef.current);
      streamRefreshedRef.current = true;
    }
    streamLoadedRef.current = false;
    const mode = streamPlanRef.current.shift();
    const vid = videoIdRef.current ?? epRef.current?.videoId;
    if (!mode || !vid) {
      giveUpStream(tNow("视频无法播放"));
      return;
    }
    resolvingStreamRef.current = true;
    const s = useStore.getState();
    const resume =
      stillMine() && (s.playing || !!s.loadingSince || s.playWhenReady === s.current?.id);
    if (stillMine()) waiting(true);
    useYtUi.setState({ note: tNow("视频没能播放，正在换一种方式…"), error: null });
    void withTimeout(api.youtubeStream(vid, mode, true), STREAM_WAIT).then(
      (stream) => {
        resolvingStreamRef.current = false;
        if (!stillMine()) return;
        if (resume && s.current) useStore.getState().set({ playWhenReady: s.current.id });
        applyNative(stream, mode);
      },
      () => {
        resolvingStreamRef.current = false;
        tryNextStream();
      },
    );
  };

  const fallbackToStream = async (why: string) => {
    if (resolvingStreamRef.current || usingNativeRef.current) return;
    const vid = videoIdRef.current ?? epRef.current?.videoId;
    if (!vid || !stillMine()) return;
    resolvingStreamRef.current = true;
    streamRefreshedRef.current = false;
    clearEmbedTimers();
    useYtUi.setState({
      error: null,
      note: tNow("{reason}，正在改用直连播放…", { reason: why }),
    });
    const off = listen<{ videoId: string; stage: string; progress: number }>("yt-stream", ({ payload: p }) => {
      if (p.videoId !== vid) return;
      useYtUi.setState({
        note:
          p.stage === "tool"
            ? tNow("首次使用，正在下载 YouTube 播放组件 {pct}%", {
                pct: Math.round(p.progress * 100),
              })
            : tNow("{reason}，正在获取视频地址…", { reason: why }),
      });
    });
    const mode: StreamMode = canNativeHls() ? "native-hls" : "mp4";
    const wanted = () => {
      const s = useStore.getState();
      return (
        stillMine() &&
        (!!s.loadingSince || s.playWhenReady === s.current?.id || s.playing)
      );
    };
    try {
      const stream = await withTimeout(api.youtubeStream(vid, mode), STREAM_WAIT);
      if (!stillMine()) return;
      streamPlanRef.current = mode === "native-hls" ? ["mp4"] : [];
      if (wanted() && useStore.getState().current) {
        useStore.getState().set({ playWhenReady: useStore.getState().current!.id });
      }
      applyNative(stream, mode);
    } catch (e) {
      giveUpStream(errText(e) || tNow("这集视频暂时播不了"));
    } finally {
      resolvingStreamRef.current = false;
      void off.then((f) => f());
    }
  };

  const armEmbedWatchdogs = () => {
    if (usingNativeRef.current) return;
    clearEmbedTimers();
    embedStartTimerRef.current = window.setTimeout(() => {
      if (usingNativeRef.current || !stillMine()) return;
      if (!useStore.getState().loadingSince) return;
      const p = ytRef.current;
      try {
        if (window.YT && p) {
          const st = p.getPlayerState();
          if (st === window.YT.PlayerState.PLAYING || st === window.YT.PlayerState.PAUSED) return;
        }
      } catch {
        /* ignore */
      }
      void fallbackToStream(tNow("YouTube 播放器没有响应"));
    }, EMBED_START_WAIT);
    slowFallbackTimerRef.current = window.setTimeout(() => {
      if (usingNativeRef.current || !stillMine()) return;
      if (!useStore.getState().loadingSince) return;
      void fallbackToStream(tNow("视频加载较慢…"));
    }, SLOW_FALLBACK);
  };

  // 贴合槽位；用 ResizeObserver + scroll/resize/layout 事件同步几何与滚动裁切
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !active) return;
    if (!slotEl || shell) {
      box.className = `yt-dock ${shell ? "shell" : floating ? "floating" : "offscreen"}`;
      box.removeAttribute("style");
      return;
    }
    const scroller = slotEl.closest<HTMLElement>(".ep-left");
    let raf = 0;
    let last = "";
    const sync = () => {
      raf = 0;
      const r = slotEl.getBoundingClientRect();
      const host = theater ? " theater-host" : "";
      const c = (scroller ?? document.body).getBoundingClientRect();
      const top = theater ? 0 : Math.max(0, c.top - r.top);
      const bottom = theater ? 0 : Math.max(0, r.bottom - c.bottom);
      const key = `${r.left},${r.top},${r.width},${r.height},${top},${bottom},${host}`;
      if (key !== last) {
        last = key;
        box.className = `yt-dock docked${host}`;
        Object.assign(box.style, {
          left: `${r.left}px`,
          top: `${r.top}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
          clipPath: top || bottom ? `inset(${top}px 0 ${bottom}px 0 round 12px)` : "",
        });
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(sync);
    };
    sync();
    const ro = new ResizeObserver(schedule);
    ro.observe(slotEl);
    ro.observe(document.documentElement);
    if (scroller) ro.observe(scroller);
    const onEvent = () => schedule();
    (scroller ?? window).addEventListener("scroll", onEvent, { passive: true });
    window.addEventListener("resize", onEvent, { passive: true });
    const unsubLayout = useLayout.subscribe(schedule);
    return () => {
      ro.disconnect();
      (scroller ?? window).removeEventListener("scroll", onEvent);
      window.removeEventListener("resize", onEvent);
      unsubLayout();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [active, slotEl, shell, floating, videoId, theater]);

  // 供 audioHost / store 同步硬停（不靠本 effect 的异步）
  useEffect(() => {
    return registerYtHost(() => {
      hardStopYt();
      const el = videoRef.current;
      if (el) {
        try {
          el.pause();
        } catch {
          /* ignore */
        }
      }
    });
  }, []);

  // 预热 yt-dlp，避免首次回退才去下二进制
  useEffect(() => {
    void api.prepareYoutube().catch(() => {});
  }, []);

  // 失活：硬停并交权，保留 iframe 供下次秒切（挡 in-flight load 起播）
  useEffect(() => {
    if (active) return;
    hardStopYt();
    setNative(null);
    useYtUi.setState({ note: null });
    if (handleRef.current) {
      withdrawPlayer(handleRef.current);
      handleRef.current = null;
    }
  }, [active]);

  // 换集：清直连，回到 embed
  useEffect(() => {
    setNative(null);
    streamPlanRef.current = [];
    streamModeRef.current = null;
    streamLoadedRef.current = false;
    streamRefreshedRef.current = false;
    streamGaveUpRef.current = false;
    useYtUi.setState({ note: null, error: null });
  }, [current?.id]);

  // 直连 `<video>`：绑源、认领 PlayerHandle、卡顿换路
  useEffect(() => {
    const el = videoRef.current;
    const ep = current;
    if (!active || !native || !el || !ep) return;
    let dead = false;
    el.src = native.url;
    el.playbackRate = ytRate(useStore.getState().rate);
    const offVol = followVolume(el);
    clockRef.current.reset(useStore.getState().time || ep.progress || 0);
    offerVideo(el, ep.id);
    startTickVideo(el, ep.id);
    if (streamStallTimerRef.current) window.clearTimeout(streamStallTimerRef.current);
    streamStallTimerRef.current = window.setTimeout(() => {
      if (!dead && el.readyState === 0) tryNextStream();
    }, STALL_WAIT);
    const onMeta = () => {
      if (dead) return;
      streamLoadedRef.current = true;
      const at = useStore.getState().time || ep.progress || 0;
      if (at > 5 && Number.isFinite(el.duration) && at < el.duration - 10) {
        el.currentTime = at;
      }
      clockRef.current.reset(el.currentTime);
      track(ep, el.currentTime, el.duration);
      if (useStore.getState().playWhenReady === ep.id || useStore.getState().playing) {
        void el.play().catch(() => {});
        useStore.getState().set({ playWhenReady: null });
      }
    };
    const onPlay = () => {
      useStore.getState().set({ playing: true });
      if (el.readyState < 3) waiting(true);
      else waiting(false);
      clockRef.current.setPlaying(true);
    };
    const onPlaying = () => waiting(false);
    const onWaiting = () => waiting(true);
    const onPause = () => {
      waiting(false);
      useStore.getState().set({ playing: false });
      clockRef.current.setPlaying(false);
      try {
        flushProgress(ep, toContent(currentMap(ep.id), el.currentTime).at);
      } catch {
        /* ignore */
      }
    };
    const onEnded = () => {
      stopTick();
      useStore.getState().set({ playing: false });
      clockRef.current.setPlaying(false);
      try {
        flushProgress(ep, toContent(currentMap(ep.id), el.duration || el.currentTime).at);
      } catch {
        /* ignore */
      }
      void playNext();
    };
    const onError = () => {
      if (!dead) tryNextStream();
    };
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("play", onPlay);
    el.addEventListener("playing", onPlaying);
    el.addEventListener("waiting", onWaiting);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);
    el.load();
    return () => {
      dead = true;
      if (streamStallTimerRef.current) window.clearTimeout(streamStallTimerRef.current);
      offVol();
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("waiting", onWaiting);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onError);
      try {
        el.pause();
        el.removeAttribute("src");
        el.load();
      } catch {
        /* ignore */
      }
    };
  }, [active, native?.url, current?.id]);

  // 建播放器 / loadVideoById 换片；优先消费 kick（点击同步投递，早于单集页）
  useEffect(() => {
    if (native || streamGaveUpRef.current) return;
    const fromKick = kick && kick.gen !== lastKickGen.current;
    if (fromKick) lastKickGen.current = kick.gen;

    const vid = fromKick ? kick.videoId : videoId;
    const ep = current;
    if (!active || !vid || !hostRef.current) return;
    if (!ep && !fromKick) return;

    pauseAudioHost();
    releaseAudioHost();

    const epId = fromKick ? kick.episodeId : ep!.id;
    const startAt = fromKick
      ? kick.startAt
      : Math.floor(useStore.getState().time || ep!.progress || 0);
    useYtUi.setState({ error: null });
    resetTrackSave();

    const wantPlayNow =
      (fromKick && !!kick?.play) || useStore.getState().playWhenReady === epId;

    const onReady = (p: YtPlayer) => {
      ytRef.current = p;
      videoIdRef.current = vid;
      if (!stillMine()) {
        hardStopYt();
        return;
      }
      applyYtPlayerVolume(p);
      hideYouTubeCaptions(p);
      clockRef.current.reset(startAt > 0 ? startAt : useStore.getState().time || 0);
      const applied = ytRate(useStore.getState().rate);
      clockRef.current.setRate(applied);
      try {
        p.setPlaybackRate(applied);
      } catch {
        /* ignore */
      }
      offerYt(p, epId);
      startTickYt(p, epId);
      if (fromKick && kick.play) {
        armEmbedWatchdogs();
        p.playVideo();
        useStore.getState().set({ playWhenReady: null });
      }
      try {
        if (window.YT && p.getPlayerState() === window.YT.PlayerState.PLAYING) {
          clearEmbedTimers();
          waiting(false);
          useStore.getState().set({ playing: true });
        } else {
          waiting(false);
        }
      } catch {
        waiting(false);
      }
    };

    if (ytRef.current && videoIdRef.current === vid) {
      onReady(ytRef.current);
      const unsubVol = useVolume.subscribe(() => applyYtPlayerVolume(ytRef.current));
      return () => unsubVol();
    }
    if (ytRef.current && videoIdRef.current && videoIdRef.current !== vid) {
      waiting(true);
      switchingRef.current = true;
      try {
        const opts = { videoId: vid, startSeconds: startAt > 0 ? startAt : 0 };
        if (wantPlayNow) {
          armEmbedWatchdogs();
          ytRef.current.loadVideoById(opts);
        } else ytRef.current.cueVideoById(opts);
        onReady(ytRef.current);
        const unsubVol = useVolume.subscribe(() => applyYtPlayerVolume(ytRef.current));
        return () => unsubVol();
      } catch {
        switchingRef.current = false;
        try {
          ytRef.current.destroy();
        } catch {
          /* ignore */
        }
        ytRef.current = null;
        videoIdRef.current = null;
      }
    }

    let cancelled = false;
    waiting(true);
    if (wantPlayNow) armEmbedWatchdogs();
    void loadYouTube()
      .then((YT) => {
        if (cancelled || !hostRef.current) return;
        if (!stillMine()) return;
        if (ytRef.current && videoIdRef.current === vid) {
          onReady(ytRef.current);
          return;
        }
        hostRef.current.innerHTML = "";
        const mount = document.createElement("div");
        hostRef.current.appendChild(mount);
        const player = new YT.Player(mount, {
          videoId: vid,
          width: "100%",
          height: "100%",
          host: "https://www.youtube.com",
          playerVars: {
            autoplay: wantPlayNow ? 1 : 0,
            controls: 0,
            disablekb: 1,
            fs: 0,
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
              if (!stillMine()) {
                hardStopYt();
                return;
              }
              if (startAt > 0) e.target.seekTo(startAt, true);
              onReady(e.target);
            },
            onStateChange: (e: { data: number; target: YtPlayer }) => {
              if (!window.YT || e.target !== ytRef.current) return;
              if (usingNativeRef.current) return;
              const st = useStore.getState();
              if (!usesYtEngine(st.current, st.audioOnly)) {
                if (e.data === window.YT.PlayerState.PLAYING) hardStopYt();
                return;
              }
              const cur = epRef.current;
              if (!cur || cur.videoId !== videoIdRef.current) return;
              hideYouTubeCaptions(e.target);
              if (e.data === window.YT.PlayerState.PLAYING) {
                switchingRef.current = false;
                clearEmbedTimers();
                waiting(false);
                useStore.getState().set({ playing: true });
                clockRef.current.setPlaying(true);
                startTickYt(e.target, cur.id);
              } else if (e.data === window.YT.PlayerState.CUED) {
                switchingRef.current = false;
                waiting(false);
              } else if (e.data === window.YT.PlayerState.PAUSED) {
                if (switchingRef.current) return;
                clearEmbedTimers();
                useStore.getState().set({ playing: false });
                clockRef.current.setPlaying(false);
                try {
                  const raw = e.target.getCurrentTime();
                  const settled = clockRef.current.sample(raw);
                  flushProgress(cur, toContent(currentMap(cur.id), settled).at);
                } catch {
                  /* ignore */
                }
              } else if (e.data === window.YT.PlayerState.BUFFERING) {
                waiting(true);
                clockRef.current.setPlaying(false);
              } else if (e.data === window.YT.PlayerState.ENDED) {
                if (switchingRef.current) return;
                stopTick();
                useStore.getState().set({ playing: false });
                clockRef.current.setPlaying(false);
                try {
                  flushProgress(
                    cur,
                    toContent(currentMap(cur.id), e.target.getDuration() || useStore.getState().time)
                      .at,
                  );
                } catch {
                  /* ignore */
                }
                void playNext();
              }
            },
            onError: () => {
              if (!ytRef.current) return;
              if (!stillMine()) return;
              if (usingNativeRef.current) return;
              waiting(false);
              useStore.getState().set({ playing: false });
              void fallbackToStream(tNow("YouTube 播放器加载失败"));
            },
          },
        }) as YtPlayer;
        ytRef.current = player;
      })
      .catch((err: Error) => {
        if (cancelled) return;
        waiting(false);
        void fallbackToStream(err.message || tNow("无法加载 YouTube 播放器"));
      });

    const unsubVol = useVolume.subscribe(() => applyYtPlayerVolume(ytRef.current));
    return () => {
      cancelled = true;
      clearEmbedTimers();
      unsubVol();
    };
  }, [active, videoId, current?.id, kick?.gen, native]);

  useEffect(() => {
    if (!active || !playWhenReady || !current || playWhenReady !== current.id) return;
    if (native) {
      const el = videoRef.current;
      if (!el) return;
      void el.play().catch(() => {});
      useStore.getState().set({ playWhenReady: null });
      return;
    }
    if (!ytRef.current || typeof ytRef.current.playVideo !== "function") return;
    try {
      armEmbedWatchdogs();
      ytRef.current.playVideo();
      useStore.getState().set({ playWhenReady: null });
    } catch {
      /* 播放器尚未完全就绪，等 onReady 消费 playWhenReady */
    }
  }, [playWhenReady, active, videoId, current?.id, native]);

  useEffect(() => {
    if (!active) return;
    const applied = ytRate(rate);
    clockRef.current.setRate(applied);
    if (native && videoRef.current) {
      videoRef.current.playbackRate = applied;
      return;
    }
    if (!ytRef.current) return;
    try {
      ytRef.current.setPlaybackRate(applied);
    } catch {
      /* ignore */
    }
  }, [rate, active, native]);

  useEffect(() => {
    return () => {
      clearEmbedTimers();
      stopTick();
      if (handleRef.current) {
        withdrawPlayer(handleRef.current);
        handleRef.current = null;
      }
      try {
        ytRef.current?.destroy();
      } catch {
        /* ignore */
      }
      ytRef.current = null;
      videoIdRef.current = null;
    };
  }, []);

  const mode = !active
    ? "offscreen"
    : shell
      ? "shell"
      : slotEl
        ? "docked"
        : floating
          ? "floating"
          : "offscreen";
  const theaterHost = mode === "docked" && theater ? " theater-host" : "";

  const closeFloating = () => {
    const st = useStore.getState();
    if (st.playing) st.player?.toggle();
    useVideoFloating.setState({ epId: null });
  };

  return (
    <div ref={boxRef} className={`yt-dock ${mode}${theaterHost}`} aria-hidden={!active && !floating}>
      <div className={`yt-mount crop${native ? " stream-hidden" : ""}`} ref={hostRef} />
      <video
        ref={videoRef}
        className="video-native"
        playsInline
        preload="auto"
        hidden={!native}
        style={native ? undefined : { display: "none" }}
      />
      {floating && current && (
        <>
          <button
            type="button"
            className="yt-float-shield"
            aria-label={playing ? t("暂停") : t("播放")}
            onClick={() => useStore.getState().player?.toggle()}
          />
          <div className="video-cq">
            <SubtitleOverlay episodeId={current.id} interactive={false} />
          </div>
          <div className="video-float-bar">
            <button
              type="button"
              className="icon-btn sm"
              title={t("回到这一集")}
              aria-label={t("回到这一集")}
              onClick={() => useStore.getState().openEpisode(current)}
            >
              <ExternalLink size={14} />
            </button>
            <button
              type="button"
              className="icon-btn sm"
              title={t("停止播放并关闭")}
              aria-label={t("停止播放并关闭")}
              onClick={closeFloating}
            >
              <X size={14} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
