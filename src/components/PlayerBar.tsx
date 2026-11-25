/**
 * [INPUT]: 页内 episode；store；jobs；offline；YtEngine；SeekHighlights；pieces；SubtitleOverlay
 * [OUTPUT]: 媒体切换 + 封面/视频槽（含 .video-cq 容器与全屏 idle/theater-bar）+ AudioSubtitles（now/next）+ ControlsBar
 * [POS]: 单集左栏播控；页 episode 与 store.current 正交；全屏时 2.5s 静默隐退底栏与 Aa
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Loader2,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { Episode, Segment } from "../lib/api";
import { clock } from "../lib/format";
import { useT } from "../lib/i18n";
import { useJobs } from "../lib/jobs";
import { releaseAudioHost, takeAudioEngine } from "../lib/audioHost";
import { initialAudioOnly, preferAudio } from "../lib/media";
import { audioSrc, useOffline } from "../lib/offline";
import { pieceIndex, pieces } from "../lib/pieces";
import { openExternalUrl } from "../lib/safeUrl";
import {
  activeIndex,
  flushProgress,
  playSoon,
  pressPlay,
  SLOW_LOAD_MS,
  useLoadingFor,
} from "../lib/playback";
import { stopSubtitleRead, useSubtitleRead } from "../lib/subtitleRead";
import { alignCurrent, currentMap, loadAlign, toContent } from "../lib/timemap";
import { setLevel, toggleMute, useVolume } from "../lib/volume";
import { kickYoutube } from "../lib/ytKick";
import { useStore } from "../store";
import { SeekHighlights } from "./HighlightViews";
import { SubtitleOverlay } from "./SubtitleOverlay";
import { useYtUi, VideoSlot } from "./YtEngine";

const isCjk = (x: string) => /[\u4e00-\u9fff]/.test(x);

/** 加载中转圈；悬停变暂停，点击取消。 */
function LoadingIcon({ size }: { size: number }) {
  return (
    <span className="loading-icon">
      <Loader2 size={size} className="spin" />
      <Pause size={size} fill="currentColor" className="loading-cancel" />
    </span>
  );
}

/** 音频台：当前短句 + 淡化下一句（由 settings.audioNextLine / data-next-line 控制显隐）。 */
function AudioSubtitles({
  episodeId,
  segs,
  items,
  mode,
  progressFallback,
}: {
  episodeId: string;
  segs: Segment[];
  items?: (string | null | undefined)[];
  mode: string;
  progressFallback: number;
}) {
  const t = useT();
  const readIndex = useSubtitleRead((s) => (s.episodeId === episodeId ? s.lineIndex : null));
  const gapLeft = useStore((s) =>
    s.current?.id === episodeId && s.gapEnd && s.rawTime != null
      ? Math.ceil(s.gapEnd - s.rawTime)
      : 0,
  );
  const starts = useMemo(() => segs.map((x) => x.start), [segs]);
  const pos = useStore(
    useShallow((s) => {
      if (!segs.length) return { i: -1, k: 0 };
      if (readIndex != null && s.scrubTime == null) return { i: readIndex, k: 0 };
      const clockSec = s.current?.id === episodeId ? (s.scrubTime ?? s.time) : progressFallback;
      const i = Math.max(0, activeIndex(starts, clockSec));
      const seg = segs[i];
      if (!seg) return { i: -1, k: 0 };
      const progress = Math.min(
        1,
        Math.max(0, (clockSec - seg.start) / Math.max(0.5, seg.end - seg.start)),
      );
      return { i, k: pieceIndex(pieces(seg.text, isCjk(seg.text)), progress) };
    }),
  );

  if (gapLeft > 0 && readIndex == null) {
    return (
      <div className="asub asub-gap" aria-live="off">
        <p>{t("这一段只在你的音频里，多半是广告，{n} 秒后回到正文", { n: gapLeft })}</p>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            const s = useStore.getState();
            if (s.gapEnd != null) s.player?.seekRaw?.(s.gapEnd);
          }}
        >
          {t("跳过")}
        </button>
      </div>
    );
  }
  if (!segs.length || pos.i < 0) return null;
  const { i, k } = pos;
  const seg = segs[i]!;
  const origPs = pieces(seg.text, isCjk(seg.text));
  const zh = items?.[i];
  const zhPs = zh ? pieces(zh, true) : [];
  const kz = zhPs.length
    ? Math.min(zhPs.length - 1, Math.floor((k / origPs.length) * zhPs.length + 1e-9))
    : 0;
  const nextSeg = segs[i + 1];
  const nextZh = items?.[i + 1];
  const nowLine =
    readIndex != null
      ? { orig: seg.text, zh: zh ?? undefined }
      : {
          orig: origPs[k]!,
          zh: zhPs.length
            ? zhPs.length === origPs.length
              ? zhPs[k]
              : zhPs[kz]
            : undefined,
        };
  const nextLine =
    readIndex != null
      ? nextSeg
        ? { orig: nextSeg.text, zh: nextZh ?? undefined }
        : null
      : k + 1 < origPs.length
        ? {
            orig: origPs[k + 1]!,
            zh: zhPs.length
              ? zhPs.length === origPs.length
                ? zhPs[k + 1]
                : kz + 1 < zhPs.length
                  ? zhPs[kz + 1]
                  : undefined
              : undefined,
          }
        : nextSeg
          ? {
              orig: pieces(nextSeg.text, isCjk(nextSeg.text))[0]!,
              zh: nextZh ? pieces(nextZh, true)[0] : undefined,
            }
          : null;

  const line = (
    l: { orig: string; zh?: string | null },
    role: "now" | "next",
    key: string,
  ) => {
    const showZh = Boolean(l.zh && mode !== "original");
    const showOrig = mode !== "translation" || !l.zh;
    if (!showZh && !showOrig) return null;
    return (
      <div key={key} className={`asub-line ${role}`} aria-hidden={role === "next"}>
        {showZh && <p className="sub-zh">{l.zh}</p>}
        {showOrig && <p className="sub-orig">{l.orig}</p>}
      </div>
    );
  };

  return (
    <div className="asub" aria-live="off">
      {line(nowLine, "now", `${i}-${k}`)}
      {nextLine && line(nextLine, "next", `${i}-${k}-n`)}
    </div>
  );
}

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

/** 视频全屏：布局 theater + 窗口全屏。macOS WebView 不启用 element Fullscreen API。 */
export function toggleTheater(on?: boolean) {
  const s = useStore.getState();
  const next = on ?? !s.theater;
  if (next && !document.querySelector(".video")) return false;
  s.set({ theater: next });
  void getCurrentWindow().setFullscreen(next).catch(() => {});
  return true;
}

function VolumeControl() {
  const t = useT();
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
        title={muted ? t("取消静音（M）") : t("静音（M）")}
        aria-label={muted ? t("取消静音") : t("静音")}
      >
        <Icon size={17} />
      </button>
      <div className="volume-popup">
        <input
          className="seek volume-slider"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={shown}
          onChange={(e) => setLevel(Number(e.target.value))}
          style={{ "--fill": `${pct}%` } as React.CSSProperties}
          aria-label={t("音量")}
          aria-valuetext={`${pct}%`}
          title={t("音量 {n}%", { n: pct })}
        />
      </div>
    </div>
  );
}

function ControlsBar({
  episodeId,
  live,
  busy,
  playing,
  rate,
  shownSubTime,
  shownBarTime,
  shownLength,
  onDrag,
  commitDrag,
  cancelDrag,
  onPlayToggle,
  compact = false,
}: {
  episodeId: string;
  live: boolean;
  busy: boolean;
  playing: boolean;
  rate: number;
  shownSubTime: number;
  shownBarTime: number;
  shownLength: number;
  onDrag: (v: number) => void;
  commitDrag: () => void;
  cancelDrag: () => void;
  onPlayToggle: () => void;
  compact?: boolean;
}) {
  const t = useT();
  const fill = `${shownLength ? Math.min(100, (shownBarTime / shownLength) * 100) : 0}%`;
  return (
    <div className={`controls${compact ? " compact" : ""}`}>
      <button
        type="button"
        className="icon-btn"
        title={t("后退 15 秒")}
        disabled={!live}
        onClick={() => useStore.getState().player?.seek(Math.max(0, shownSubTime - 15))}
      >
        <RotateCcw size={16} />
      </button>
      <button
        type="button"
        className={`play-btn${busy ? " loading" : ""}`}
        onClick={onPlayToggle}
        title={busy ? t("正在加载…（点击取消）") : playing ? t("暂停（空格）") : t("播放（空格）")}
        aria-label={busy ? t("正在加载…（点击取消）") : playing ? t("暂停") : t("播放")}
        aria-busy={busy || undefined}
      >
        {busy ? (
          <LoadingIcon size={18} />
        ) : playing ? (
          <Pause size={18} fill="currentColor" />
        ) : (
          <Play size={18} fill="currentColor" />
        )}
      </button>
      <button
        type="button"
        className="icon-btn"
        title={t("前进 30 秒")}
        disabled={!live}
        onClick={() => useStore.getState().player?.seek(shownSubTime + 30)}
      >
        <RotateCw size={16} />
      </button>
      <span className="time">{clock(shownBarTime)}</span>
      <div className="seek-wrap">
        {!compact && live && (
          <SeekHighlights
            episodeId={episodeId}
            length={shownLength}
            onSeek={(sec) => useStore.getState().player?.seek(sec)}
          />
        )}
        <input
          className="seek"
          type="range"
          min={0}
          max={Math.max(shownLength, 1)}
          step={0.1}
          value={Math.min(shownBarTime, shownLength || shownBarTime)}
          style={{ "--fill": fill } as React.CSSProperties}
          disabled={!live}
          onChange={(e) => onDrag(Number(e.target.value))}
          onPointerUp={commitDrag}
          onPointerCancel={cancelDrag}
          onTouchEnd={commitDrag}
          onKeyUp={(e) => {
            if (
              e.key === "ArrowLeft" ||
              e.key === "ArrowRight" ||
              e.key === "ArrowUp" ||
              e.key === "ArrowDown" ||
              e.key === "Home" ||
              e.key === "End" ||
              e.key === "PageUp" ||
              e.key === "PageDown"
            ) {
              commitDrag();
            }
          }}
          onBlur={commitDrag}
        />
      </div>
      <span className="time">{clock(shownLength)}</span>
      <VolumeControl />
      <button
        type="button"
        className={`rate-btn${rate >= 2 ? " fast" : ""}`}
        title={t("播放速度")}
        disabled={!live}
        onClick={() => {
          const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length] ?? 1;
          useStore.getState().player?.setRate(next);
        }}
      >
        {rate}x
      </button>
    </div>
  );
}

export function PlayerBar({ episode }: { episode: Episode }) {
  const t = useT();
  const { current, time, rawTime, length, playing, rate, audioOnly, loadingSince, theater, set } = useStore(
    useShallow((s) => ({
      current: s.current,
      time: s.time,
      rawTime: s.rawTime,
      length: s.length,
      playing: s.playing,
      rate: s.rate,
      audioOnly: s.audioOnly,
      loadingSince: s.loadingSince,
      theater: s.theater,
      set: s.set,
    })),
  );
  const live = current?.id === episode.id;
  const [source, setSource] = useState<Episode>(episode);
  const [drag, setDrag] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  const [idle, setIdle] = useState(false);
  const transcript = useJobs((s) => s.transcripts[episode.id]);
  const items = useJobs((s) => s.translations[episode.id]?.items);
  const mode = useStore((s) => s.settings.subtitleMode);
  const saved = useOffline((s) => s.saved[source.id]);
  const ytError = useYtUi((s) => s.error);
  const ytNote = useYtUi((s) => s.note);

  const onDrag = useCallback(
    (val: number) => {
      dragRef.current = val;
      setDrag(val);
      if (useSubtitleRead.getState().episodeId === source.id) stopSubtitleRead();
      const subSec = toContent(currentMap(source.id), val).at;
      useStore.getState().set({ scrubTime: subSec });
    },
    [source.id],
  );

  const cancelDrag = useCallback(() => {
    dragRef.current = null;
    setDrag(null);
    if (useStore.getState().scrubTime !== null) {
      useStore.getState().set({ scrubTime: null });
    }
  }, []);

  const commitDrag = useCallback(() => {
    const val = dragRef.current;
    if (val == null) return;
    dragRef.current = null;
    setDrag(null);
    const st = useStore.getState();
    const p = st.player;
    if (p?.seekRaw) p.seekRaw(val);
    else if (p) p.seek(val);
    else {
      const subSec = toContent(currentMap(source.id), val).at;
      st.set({
        time: subSec,
        rawTime: val,
        scrubTime: null,
        seekWhenReady: { id: source.id, at: subSec },
      });
    }
    if (useStore.getState().scrubTime !== null) {
      useStore.getState().set({ scrubTime: null });
    }
  }, [source.id]);

  useEffect(() => {
    dragRef.current = null;
    setDrag(null);
    if (useStore.getState().scrubTime !== null) {
      useStore.getState().set({ scrubTime: null });
    }
  }, [episode.id, live]);

  // 拖拽中指针移出细轨道并在窗口任意处松手时也能立即提交，不悬停等待失焦
  useEffect(() => {
    if (drag == null) return;
    const onWinUp = () => commitDrag();
    const onWinCancel = () => cancelDrag();
    window.addEventListener("pointerup", onWinUp);
    window.addEventListener("pointercancel", onWinCancel);
    return () => {
      window.removeEventListener("pointerup", onWinUp);
      window.removeEventListener("pointercancel", onWinCancel);
    };
  }, [drag != null, commitDrag, cancelDrag]);

  // 离开视频舞台时收起 theater（切仅音频 / 离页卸载）并清理拖拽预览态
  useEffect(() => {
    return () => {
      if (useStore.getState().scrubTime !== null) {
        useStore.getState().set({ scrubTime: null });
      }
      if (useStore.getState().theater) toggleTheater(false);
    };
  }, []);

  // 全屏模式：2.5s 无指针移动或按键则隐退底部控制栏与 Aa 按钮；Esc 退出全屏
  useEffect(() => {
    if (!theater) {
      setIdle(false);
      return;
    }
    let timer = window.setTimeout(() => setIdle(true), 2500);
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), 2500);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        toggleTheater(false);
        return;
      }
      wake();
    };
    window.addEventListener("mousemove", wake);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("keydown", onKey);
    };
  }, [theater]);

  useEffect(() => {
    setSource((prev) => {
      const base = live && current ? current : episode;
      if (prev.id !== base.id) return base;
      return {
        ...prev,
        ...base,
        videoId: base.videoId ?? prev.videoId,
        audioUrl: base.audioUrl ?? prev.audioUrl,
        cover: base.cover ?? prev.cover,
      };
    });
  }, [episode, live, current?.id, current?.videoId, current?.audioUrl, current?.cover]);

  const videoId = source.videoId ?? undefined;
  const canVideo = !!videoId;
  const hasFile = !!audioSrc(source) || !!saved;
  // 浏览他集时用本集默认形态展示，不借用正在播那集的 audioOnly；断网已下载 YouTube 显示音频台
  const pageAudioOnly = live ? audioOnly : initialAudioOnly(source);
  const showVideo = canVideo && !pageAudioOnly;
  const shownSubTime = live ? time : source.progress || 0;
  // 进度条与时钟跟随播放器自身时钟（有 TimeMap 时与字幕时间区分）；拖拽中同步 scrubTime 实时预览字幕，松手再 commit
  const shownBarTime = drag ?? (live ? (rawTime ?? time) : source.progress || 0);
  const shownLength = live ? length || source.duration || 0 : source.duration || 0;
  const shownPlaying = live && playing;
  const busy = live && !!loadingSince;

  const takeOver = () => {
    const s = useStore.getState();
    s.load(source);
    playSoon(source.id);
  };

  const playToggle = () => {
    if (live) {
      if (pressPlay() === "none") takeOver();
      return;
    }
    takeOver();
  };

  const slowLoad = useLoadingFor(live ? source.id : undefined, SLOW_LOAD_MS);

  const switchTo = (audio: boolean, why?: string) => {
    if (!canVideo || !live || audio === audioOnly) return;
    if (audio && useStore.getState().theater) toggleTheater(false);
    const s = useStore.getState();
    const t = s.time;
    flushProgress(source, t);
    const wanted = !!s.loadingSince || s.playing;
    const sameYt = !preferAudio(source);
    const ep = { ...source, progress: t };
    set({
      current: ep,
      time: t,
      rawTime: audio ? undefined : t,
      scrubTime: null,
      gapEnd: null,
      audioOnly: audio,
      playing: sameYt ? s.playing : false,
      loadingSince: null,
      playWhenReady: null,
      player: sameYt ? s.player : null,
    });
    if (sameYt) {
      // 无独立音轨：仍走 iframe，仅音频壳
      if (wanted) window.setTimeout(() => useStore.getState().player?.play(), 0);
    } else if (audio && preferAudio(ep)) {
      // 视频→音频：先装已有 TimeMap，再由音频引擎起播并触发自动对齐检测
      takeAudioEngine(ep, { play: wanted });
      void loadAlign(ep.id, true).then(() => alignCurrent(false));
    } else {
      // 音频→视频：片源与字幕同源，不用 TimeMap
      releaseAudioHost();
      kickYoutube(ep, { time: t, play: false });
      if (wanted) playSoon(ep.id);
    }
    if (why) s.notify(why);
  };

  const segs = transcript?.segments ?? [];

  return (
    <>
      {canVideo && live && (
        <div className="media-switch-row">
          <div className="media-switch seg-control" role="radiogroup" aria-label={t("播放方式")}>
            <button
              type="button"
              role="radio"
              aria-checked={!audioOnly}
              className={!audioOnly ? "on" : ""}
              onClick={() => audioOnly && switchTo(false)}
            >
              {t("视频")}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={audioOnly}
              className={audioOnly ? "on" : ""}
              onClick={() => !audioOnly && switchTo(true)}
            >
              {t("仅音频")}
            </button>
          </div>
        </div>
      )}

      {showVideo && live && (
        <>
          {theater && <div className="theater-backdrop" aria-hidden />}
          <div className={`video${theater ? " theater" : ""}${theater && idle && drag == null ? " idle" : ""}`}>
            <VideoSlot />
            <button
              type="button"
              className="yt-shield"
              aria-label={busy ? t("正在加载…（点击取消）") : shownPlaying ? t("暂停") : t("播放")}
              title={busy ? t("正在加载…（点击取消）") : shownPlaying ? t("暂停") : t("播放")}
              onClick={playToggle}
              onDoubleClick={() => toggleTheater()}
            />
            {!shownPlaying && !busy && (
              <span className="yt-center-play" aria-hidden>
                <Play size={36} fill="currentColor" />
              </span>
            )}
            {busy && (
              <span className="yt-center-play loading" aria-hidden>
                <LoadingIcon size={36} />
              </span>
            )}
            {(ytNote || (slowLoad && !ytError)) && (
              <div className="video-note">
                <span className="spin-dot" />
                {ytNote || t("视频加载较慢…")}
                {hasFile && (
                  <button type="button" className="link-btn video-open" onClick={() => switchTo(true)}>
                    {t("改听音频")}
                  </button>
                )}
                {videoId && (
                  <button
                    type="button"
                    className="link-btn video-open"
                    onClick={() => void openExternalUrl(`https://www.youtube.com/watch?v=${videoId}`)}
                  >
                    {t("在 YouTube 打开")}
                  </button>
                )}
              </div>
            )}
            <div className="video-cq">
              <SubtitleOverlay episodeId={episode.id} />
            </div>
            {!theater && (
              <button
                type="button"
                className="yt-fs-btn"
                title={t("全屏（双击或 F）")}
                aria-label={t("全屏")}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleTheater();
                }}
              >
                <Maximize2 size={16} />
              </button>
            )}
            {theater && (
              <div className="theater-bar" onClick={(e) => e.stopPropagation()}>
                <p className="theater-title clamp1">{source.title}</p>
                <ControlsBar
                  episodeId={source.id}
                  live={live}
                  busy={busy}
                  playing={shownPlaying}
                  rate={rate}
                  shownSubTime={shownSubTime}
                  shownBarTime={shownBarTime}
                  shownLength={shownLength}
                  onDrag={onDrag}
                  commitDrag={commitDrag}
                  cancelDrag={cancelDrag}
                  onPlayToggle={playToggle}
                  compact
                />
                <button
                  type="button"
                  className="icon-btn theater-exit"
                  title={t("退出全屏（Esc）")}
                  aria-label={t("退出全屏")}
                  onClick={() => toggleTheater(false)}
                >
                  <Minimize2 size={16} />
                </button>
              </div>
            )}
            {ytError && !hasFile && (
              <div className="yt-fallback">
                <p>{ytError}</p>
              </div>
            )}
          </div>
        </>
      )}

      {(!showVideo || !live) && (
        <div className="audio-stage">
          <button
            type="button"
            className="cover-play"
            onClick={playToggle}
            title={
              busy
                ? t("正在加载…（点击取消）")
                : shownPlaying
                  ? t("暂停（空格）")
                  : live
                    ? t("播放（空格）")
                    : t("播放这一集")
            }
            aria-label={busy ? t("正在加载…（点击取消）") : shownPlaying ? t("暂停") : t("播放")}
          >
            {source.cover ? <img src={source.cover} alt="" /> : <span className="cover-fallback" />}
            <span className={`cover-play-btn ${shownPlaying ? "playing" : ""}${busy ? " loading" : ""}`}>
              {busy ? (
                <LoadingIcon size={30} />
              ) : shownPlaying ? (
                <Pause size={30} fill="currentColor" />
              ) : (
                <Play size={30} fill="currentColor" />
              )}
            </span>
          </button>
          {segs.length > 0 && (
            <div className="audio-sub">
              <AudioSubtitles
                episodeId={source.id}
                segs={segs}
                items={items}
                mode={mode}
                progressFallback={source.progress || 0}
              />
            </div>
          )}
        </div>
      )}

      <ControlsBar
        episodeId={source.id}
        live={live}
        busy={busy}
        playing={shownPlaying}
        rate={rate}
        shownSubTime={shownSubTime}
        shownBarTime={shownBarTime}
        shownLength={shownLength}
        onDrag={onDrag}
        commitDrag={commitDrag}
        cancelDrag={cancelDrag}
        onPlayToggle={playToggle}
      />
    </>
  );
}
