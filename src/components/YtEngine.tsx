/**
 * [INPUT]: store.current / audioOnly / playWhenReady / rate / theater；media.usesYtEngine；youtube / mediaClock / playback / volume
 * [OUTPUT]: VideoSlot + YtEngine（App 根持久 iframe）；useYtUi.error
 * [POS]: load 后建/换片；cue 预热 / load 起播；失活 stop+mute 挡迟到 autoplay；rAF+mediaClock 驱动字幕
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { ExternalLink, X } from "lucide-react";
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
import { applyYtPlayerVolume, useVolume } from "../lib/volume";
import { hideYouTubeCaptions, loadYouTube, type YtPlayer } from "../lib/youtube";
import { registerYtHost } from "../lib/ytHost";
import { useYtKick } from "../lib/ytKick";
import { offerPlayer, useStore, withdrawPlayer, type PlayerHandle } from "../store";
import { SubtitleOverlay } from "./SubtitleOverlay";

/** 叠字要跟口型：约 20Hz 采样；getCurrentTime 粗跳时靠 mediaClock 外推。 */
const TICK_MS = 50;

export const useYtUi = create<{ error: string | null }>(() => ({ error: null }));

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
  const ytRef = useRef<YtPlayer | null>(null);
  const videoIdRef = useRef<string | null>(null);
  const epRef = useRef(current);
  const tickRef = useRef<number | undefined>(undefined);
  const handleRef = useRef<PlayerHandle | null>(null);
  const lastKickGen = useRef(0);
  const clockRef = useRef(createMediaClock());
  /** 复用 iframe 换片后，在新片进入 PLAYING/CUED 前忽略旧片残留的 getCurrentTime。 */
  const switchingRef = useRef(false);

  const ytRate = (r: number) => Math.min(2, Math.max(0.25, Number.isFinite(r) && r > 0 ? r : 1));

  const active = usesYtEngine(current, audioOnly);
  const videoId = active ? current?.videoId ?? kick?.videoId ?? null : null;
  const shell = !!(active && current && audioOnly && !audioSrc(current));
  const floating = Boolean(active && !shell && !slotEl && current && floatingEpId === current.id);
  epRef.current = current;

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

  const stopTick = () => {
    if (tickRef.current) {
      window.cancelAnimationFrame(tickRef.current);
      tickRef.current = undefined;
    }
  };

  const startTick = (p: YtPlayer, epId: string) => {
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
      if (switchingRef.current) return;
      try {
        if (!window.YT) return;
        const state = p.getPlayerState();
        // UNSTARTED / CUED / ENDED 时 getCurrentTime 常为 0，只补时长、不覆盖用户进度或刚发起的 seek
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
        const playing = state === window.YT.PlayerState.PLAYING;
        clock.setPlaying(playing);
        if (!playing && state !== window.YT.PlayerState.PAUSED) {
          // 缓冲中：冻结外推，仍跟一次真实时钟
          clock.setPlaying(false);
        }
        const raw = p.getCurrentTime();
        const smooth = clock.sample(raw);
        track(ep, smooth, p.getDuration());
        noteListening(ep, playing);
      } catch {
        /* mid-destroy */
      }
    };
    tickRef.current = window.requestAnimationFrame(step);
  };

  const offer = (p: YtPlayer, episodeId: string) => {
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

  const hardStopYt = () => {
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

  // 供 audioHost / store 同步硬停（不靠本 effect 的异步）
  useEffect(() => {
    return registerYtHost(() => hardStopYt());
  }, []);

  // 失活：硬停并交权，保留 iframe 供下次秒切（挡 in-flight load 起播）
  useEffect(() => {
    if (active) return;
    hardStopYt();
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

    /** 仍归本引擎管才 offer；否则硬停，防音视频交权竞态叠声。 */
    const stillMine = () => {
      const st = useStore.getState();
      return usesYtEngine(st.current, st.audioOnly);
    };

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
      offer(p, epId);
      startTick(p, epId);
      // 起播意图交给 playSoon 订阅；此处只在 kick.play 时显式续播
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

    // 复用：同 videoId 只重新 offer
    if (ytRef.current && videoIdRef.current === vid) {
      onReady(ytRef.current);
      const unsubVol = useVolume.subscribe(() => applyYtPlayerVolume(ytRef.current));
      return () => unsubVol();
    }
    // 换片：要播用 load（强制起播）；只预热用 cue（不起播）——叠声根因之一
    if (ytRef.current && videoIdRef.current && videoIdRef.current !== vid) {
      waiting(true);
      switchingRef.current = true;
      try {
        const opts = { videoId: vid, startSeconds: startAt > 0 ? startAt : 0 };
        if (wantPlayNow) ytRef.current.loadVideoById(opts);
        else ytRef.current.cueVideoById(opts);
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
          playerVars: {
            autoplay: wantPlayNow ? 1 : 0,
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
              // 不看 cancelled：iframe 跨音视频切换复用，cleanup 会误杀后续态
              if (!window.YT || e.target !== ytRef.current) return;
              const st = useStore.getState();
              // 已切到音频引擎：立刻硬停迟到的 PLAYING，否则后台继续出声
              if (!usesYtEngine(st.current, st.audioOnly)) {
                if (e.data === window.YT.PlayerState.PLAYING) hardStopYt();
                return;
              }
              const cur = epRef.current;
              if (!cur || cur.videoId !== videoIdRef.current) return;
              hideYouTubeCaptions(e.target);
              if (e.data === window.YT.PlayerState.PLAYING) {
                switchingRef.current = false;
                waiting(false);
                useStore.getState().set({ playing: true });
                clockRef.current.setPlaying(true);
                startTick(e.target, cur.id);
              } else if (e.data === window.YT.PlayerState.CUED) {
                switchingRef.current = false;
                waiting(false);
              } else if (e.data === window.YT.PlayerState.PAUSED) {
                if (switchingRef.current) return;
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
                    toContent(currentMap(cur.id), e.target.getDuration() || useStore.getState().time).at,
                  );
                } catch {
                  /* ignore */
                }
                void playNext();
              }
            },
            onError: () => {
              // iframe 复用期忽略已销毁实例的迟到错误
              if (!ytRef.current) return;
              if (!stillMine()) return;
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
    const applied = ytRate(rate);
    clockRef.current.setRate(applied);
    try {
      ytRef.current.setPlaybackRate(applied);
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
      <div className="yt-mount" ref={hostRef} />
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
