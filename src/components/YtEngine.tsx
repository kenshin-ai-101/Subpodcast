/**
 * [INPUT]: store.current / audioOnly / playWhenReady / rate / theater；media.usesYtEngine；youtube / playback / volume
 * [OUTPUT]: VideoSlot + YtEngine（App 根持久 iframe）；useYtUi.error
 * [POS]: load() 后立刻建/换片，不堵在 EpisodeView；槽位就位后 CSS 贴合，不搬 DOM；theater 时抬高 z-index
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { pauseAudioHost, releaseAudioHost, takeAudioEngine } from "../lib/audioHost";
import { tNow } from "../lib/i18n";
import { noteListening } from "../lib/listening";
import { preferAudio, usesYtEngine } from "../lib/media";
import { audioSrc } from "../lib/offline";
import { flushProgress, resetTrackSave, track, waiting } from "../lib/playback";
import { playNext } from "../lib/queue";
import { applyYtPlayerVolume, useVolume } from "../lib/volume";
import { hideYouTubeCaptions, loadYouTube, type YtPlayer } from "../lib/youtube";
import { registerYtHost } from "../lib/ytHost";
import { useYtKick } from "../lib/ytKick";
import { offerPlayer, useStore, withdrawPlayer, type PlayerHandle } from "../store";

const TICK_MS = 250;

export const useYtUi = create<{ error: string | null }>(() => ({ error: null }));

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
  const { current, audioOnly, playWhenReady, rate, theater } = useStore(
    useShallow((s) => ({
      current: s.current,
      audioOnly: s.audioOnly,
      playWhenReady: s.playWhenReady,
      rate: s.rate,
      theater: s.theater,
    })),
  );
  const slotEl = useSlot((s) => s.el);
  const kick = useYtKick((s) => s.kick);
  const boxRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const ytRef = useRef<YtPlayer | null>(null);
  const videoIdRef = useRef<string | null>(null);
  const epRef = useRef(current);
  const tickRef = useRef<number | undefined>(undefined);
  const handleRef = useRef<PlayerHandle | null>(null);
  const lastKickGen = useRef(0);

  const active = usesYtEngine(current, audioOnly);
  const videoId = active ? current?.videoId ?? kick?.videoId ?? null : null;
  const shell = !!(active && current && audioOnly && !audioSrc(current));
  epRef.current = current;

  const stopTick = () => {
    if (tickRef.current) {
      window.clearInterval(tickRef.current);
      tickRef.current = undefined;
    }
  };

  const startTick = (p: YtPlayer, epId: string) => {
    stopTick();
    tickRef.current = window.setInterval(() => {
      const ep = epRef.current;
      if (!ep || ep.id !== epId) return;
      try {
        track(ep, p.getCurrentTime(), p.getDuration());
        noteListening(ep, useStore.getState().playing);
      } catch {
        /* mid-destroy */
      }
    }, TICK_MS);
  };

  const offer = (p: YtPlayer, episodeId: string) => {
    const handle: PlayerHandle = {
      episodeId,
      seek(seconds) {
        useStore.getState().set({ time: seconds });
        p.seekTo(seconds, true);
      },
      toggle() {
        if (!window.YT) return;
        if (p.getPlayerState() === window.YT.PlayerState.PLAYING) p.pauseVideo();
        else {
          waiting(true);
          p.playVideo();
        }
      },
      play() {
        waiting(true);
        p.playVideo();
      },
      setRate(r) {
        useStore.getState().set({ rate: r });
        void useStore.getState().saveSettings({ playbackRate: r });
        try {
          p.setPlaybackRate(r);
        } catch {
          /* ignore */
        }
      },
    };
    handleRef.current = handle;
    offerPlayer(handle);
  };

  // 贴合槽位；用 ResizeObserver + scroll/resize 事件替代 60-120fps rAF 持续轮询
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !active) return;
    if (!slotEl || shell) {
      box.className = `yt-dock ${shell ? "shell" : "offscreen"}`;
      box.removeAttribute("style");
      return;
    }
    let raf = 0;
    let last = "";
    const sync = () => {
      raf = 0;
      const r = slotEl.getBoundingClientRect();
      const host = theater ? " theater-host" : "";
      const key = `${r.left},${r.top},${r.width},${r.height},${host}`;
      if (key !== last) {
        last = key;
        box.className = `yt-dock docked${host}`;
        Object.assign(box.style, {
          left: `${r.left}px`,
          top: `${r.top}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
        });
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(sync);
    };
    sync();
    const ro = new ResizeObserver(schedule);
    ro.observe(slotEl);
    const scrollParent = slotEl.closest<HTMLElement>(".ep-left") ?? window;
    const onEvent = () => schedule();
    scrollParent.addEventListener("scroll", onEvent, { passive: true });
    window.addEventListener("resize", onEvent, { passive: true });
    return () => {
      ro.disconnect();
      scrollParent.removeEventListener("scroll", onEvent);
      window.removeEventListener("resize", onEvent);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [active, slotEl, shell, videoId, theater]);

  // 供 audioHost / store 同步停声（不靠本 effect 的异步）
  useEffect(() => {
    return registerYtHost(() => {
      stopTick();
      try {
        ytRef.current?.pauseVideo();
      } catch {
        /* ignore */
      }
    });
  }, []);

  // 失活：暂停并交权，保留 iframe 供下次秒切
  useEffect(() => {
    if (active) return;
    stopTick();
    try {
      ytRef.current?.pauseVideo();
    } catch {
      /* ignore */
    }
    if (handleRef.current) {
      withdrawPlayer(handleRef.current);
      handleRef.current = null;
    }
  }, [active]);

  // 建播放器 / loadVideoById 换片；优先消费 kick（点击同步投递，早于单集页）
  useEffect(() => {
    const fromKick = kick && kick.gen !== lastKickGen.current;
    if (fromKick) lastKickGen.current = kick.gen;

    const vid = fromKick ? kick.videoId : videoId;
    const ep = current;
    if (!active || !vid || !hostRef.current) return;
    if (!ep && !fromKick) return;

    // 激活视频引擎时先停 HTMLAudio，防止与上一集音频叠声
    pauseAudioHost();
    releaseAudioHost();

    const epId = fromKick ? kick.episodeId : ep!.id;
    const startAt = fromKick
      ? kick.startAt
      : Math.floor(useStore.getState().time || ep!.progress || 0);
    useYtUi.setState({ error: null });
    resetTrackSave();

    const onReady = (p: YtPlayer) => {
      ytRef.current = p;
      videoIdRef.current = vid;
      applyYtPlayerVolume(p);
      hideYouTubeCaptions(p);
      try {
        p.setPlaybackRate(useStore.getState().rate);
      } catch {
        /* ignore */
      }
      offer(p, epId);
      startTick(p, epId);
      // 起播意图交给 playSoon 订阅；此处只 offer。kick.play 兼容显式续播。
      if (fromKick && kick.play) {
        p.playVideo();
        useStore.getState().set({ playWhenReady: null });
      }
      // 复用 iframe 时 effect cleanup 会把旧 cancelled 置真；用真实播放态对齐按钮
      try {
        if (window.YT && p.getPlayerState() === window.YT.PlayerState.PLAYING) {
          waiting(false);
          useStore.getState().set({ playing: true });
        } else {
          waiting(false);
        }
      } catch {
        waiting(false);
      }
    };

    // 复用：只换 videoId
    if (ytRef.current && videoIdRef.current === vid) {
      onReady(ytRef.current);
      const unsubVol = useVolume.subscribe(() => applyYtPlayerVolume(ytRef.current));
      return () => unsubVol();
    }
    if (ytRef.current && videoIdRef.current && videoIdRef.current !== vid) {
      waiting(true);
      try {
        ytRef.current.loadVideoById({ videoId: vid, startSeconds: startAt > 0 ? startAt : 0 });
        onReady(ytRef.current);
        const unsubVol = useVolume.subscribe(() => applyYtPlayerVolume(ytRef.current));
        return () => unsubVol();
      } catch {
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
    void loadYouTube()
      .then((YT) => {
        if (cancelled || !hostRef.current) return;
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
          playerVars: {
            autoplay: (fromKick && kick.play) || useStore.getState().playWhenReady === epId ? 1 : 0,
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
              if (startAt > 0) e.target.seekTo(startAt, true);
              onReady(e.target);
            },
            onStateChange: (e: { data: number; target: YtPlayer }) => {
              // 不看 cancelled：iframe 跨音视频切换复用，cleanup 会误杀后续态
              if (!window.YT || e.target !== ytRef.current) return;
              const st = useStore.getState();
              // 已切到音频引擎时，忽略 iframe 迟到的 pause（否则会把刚起的音频 playing 踩灭）
              if (!usesYtEngine(st.current, st.audioOnly)) return;
              const cur = epRef.current;
              if (!cur || cur.videoId !== videoIdRef.current) return;
              hideYouTubeCaptions(e.target);
              if (e.data === window.YT.PlayerState.PLAYING) {
                waiting(false);
                useStore.getState().set({ playing: true });
                startTick(e.target, cur.id);
              } else if (e.data === window.YT.PlayerState.PAUSED) {
                useStore.getState().set({ playing: false });
                try {
                  flushProgress(cur, e.target.getCurrentTime());
                } catch {
                  /* ignore */
                }
              } else if (e.data === window.YT.PlayerState.BUFFERING) {
                waiting(true);
              } else if (e.data === window.YT.PlayerState.ENDED) {
                stopTick();
                useStore.getState().set({ playing: false });
                try {
                  flushProgress(cur, e.target.getDuration() || useStore.getState().time);
                } catch {
                  /* ignore */
                }
                void playNext();
              }
            },
            onError: () => {
              // iframe 复用期忽略已销毁实例的迟到错误
              if (!ytRef.current) return;
              waiting(false);
              useStore.getState().set({ playing: false });
              const cur = epRef.current;
              if (cur && audioSrc(cur)) fallbackToAudio();
              else {
                useYtUi.setState({ error: tNow("这集视频暂时播不了") });
                useStore.getState().notify(tNow("这集视频暂时播不了"));
              }
            },
          },
        }) as YtPlayer;
        ytRef.current = player;
      })
      .catch((err: Error) => {
        if (cancelled) return;
        waiting(false);
        const cur = epRef.current;
        if (cur && audioSrc(cur)) fallbackToAudio();
        else {
          const msg = err.message || tNow("无法加载 YouTube 播放器");
          useYtUi.setState({ error: msg });
          useStore.getState().notify(msg);
        }
      });

    const unsubVol = useVolume.subscribe(() => applyYtPlayerVolume(ytRef.current));
    return () => {
      cancelled = true;
      unsubVol();
    };
  }, [active, videoId, current?.id, kick?.gen]);

  useEffect(() => {
    if (!active || !playWhenReady || !current || playWhenReady !== current.id || !ytRef.current) return;
    if (typeof ytRef.current.playVideo !== "function") return;
    try {
      ytRef.current.playVideo();
      useStore.getState().set({ playWhenReady: null });
    } catch {
      /* 播放器尚未完全就绪，等 onReady 消费 playWhenReady */
    }
  }, [playWhenReady, active, videoId, current?.id]);

  useEffect(() => {
    if (!active || !ytRef.current) return;
    try {
      ytRef.current.setPlaybackRate(rate);
    } catch {
      /* ignore */
    }
  }, [rate, active]);

  useEffect(() => {
    return () => {
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

  // 始终保留挂载点，失活只藏起——iframe 才能跨集 / 音视频切换复用
  const mode = !active ? "offscreen" : shell || !slotEl ? (shell ? "shell" : "offscreen") : "docked";
  const theaterHost = mode === "docked" && theater ? " theater-host" : "";

  return (
    <div ref={boxRef} className={`yt-dock ${mode}${theaterHost}`} aria-hidden={!active}>
      <div className="yt-mount" ref={hostRef} />
    </div>
  );
}
