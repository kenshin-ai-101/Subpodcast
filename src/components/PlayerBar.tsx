/**
 * [INPUT]: store.current / time / player；queue.playNext
 * [OUTPUT]: 音频封面舞台或 YouTube + Controls；ended 推进连播队列
 * [POS]: 单集左栏播放引擎
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef } from "react";
import { Pause, Play, RotateCcw, RotateCw } from "lucide-react";
import { api } from "../lib/api";
import { clock } from "../lib/format";
import { useJobs } from "../lib/jobs";
import { playNext } from "../lib/queue";
import { useStore } from "../store";

function activeIndex(starts: number[], time: number) {
  let lo = 0;
  let hi = starts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= time) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function PlayerBar() {
  const { current, time, length, playing, rate, set, settings } = useStore();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const transcript = useJobs((s) => (current ? s.transcripts[current.id] : undefined));
  const items = useJobs((s) => (current ? s.translations[current.id]?.items : undefined));
  const mode = settings.subtitleMode;
  const nextLine = settings.audioNextLine === true;

  useEffect(() => {
    const el = audioRef.current;
    if (!el || !current?.audioUrl || current.videoId) return;
    el.src = current.audioUrl;
    el.currentTime = current.progress || 0;
    void el.play().then(() => set({ playing: true })).catch(() => set({ playing: false }));
  }, [current?.id]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    if (!current) return;
    set({
      player: {
        seek(seconds) {
          const el = audioRef.current;
          if (el && current.audioUrl && !current.videoId) el.currentTime = seconds;
          set({ time: seconds });
          const frame = document.getElementById("yt-player") as HTMLIFrameElement | null;
          frame?.contentWindow?.postMessage(
            JSON.stringify({ event: "command", func: "seekTo", args: [seconds, true] }),
            "*",
          );
        },
        toggle() {
          const el = audioRef.current;
          if (el && current.audioUrl && !current.videoId) {
            if (el.paused) void el.play();
            else el.pause();
            return;
          }
        },
        play() {
          void audioRef.current?.play();
        },
        setRate(r) {
          set({ rate: r });
        },
      },
    });
  }, [current?.id]);

  if (!current) return null;

  const onTime = (t: number, dur?: number) => {
    set({ time: t, length: dur && dur > 0 ? dur : useStore.getState().length });
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void api.setProgress(current.id, t);
    }, 1200);
  };

  const fill = `${length ? Math.min(100, (time / length) * 100) : 0}%`;
  const segs = transcript?.segments ?? [];
  const i = segs.length ? activeIndex(segs.map((s) => s.start), time) : -1;
  const showI = nextLine && i >= 0 && i + 1 < segs.length ? i + 1 : i;
  const seg = showI >= 0 ? segs[showI] : null;
  const zh = showI >= 0 ? items?.[showI] : null;

  return (
    <>
      {current.videoId ? (
        <div className="video">
          <iframe
            id="yt-player"
            src={`https://www.youtube.com/embed/${current.videoId}?enablejsapi=1&rel=0`}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            title={current.title}
          />
        </div>
      ) : (
        <div className="audio-stage">
          <button
            type="button"
            className="cover-play"
            onClick={() => {
              const el = audioRef.current;
              if (!el) return;
              if (el.paused) void el.play();
              else el.pause();
            }}
          >
            {current.cover ? <img src={current.cover} alt="" /> : <span className="cover-fallback" />}
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
        <button className="icon-btn" title="后退 15 秒" onClick={() => useStore.getState().player?.seek(Math.max(0, time - 15))}>
          <RotateCcw size={16} />
        </button>
        <button
          className="play-btn"
          onClick={() => {
            if (current.audioUrl && !current.videoId) {
              const el = audioRef.current;
              if (!el) return;
              if (el.paused) void el.play();
              else el.pause();
            } else {
              useStore.getState().player?.toggle();
            }
          }}
        >
          {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
        </button>
        <button className="icon-btn" title="前进 30 秒" onClick={() => useStore.getState().player?.seek(time + 30)}>
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
        <button
          className="rate-btn"
          onClick={() => {
            const rates = [0.75, 1, 1.25, 1.5, 1.75, 2];
            const next = rates[(rates.indexOf(rate) + 1) % rates.length] ?? 1;
            set({ rate: next });
          }}
        >
          {rate}x
        </button>
      </div>

      {current.audioUrl && !current.videoId && (
        <audio
          ref={audioRef}
          preload="metadata"
          onPlay={() => set({ playing: true })}
          onPause={() => set({ playing: false })}
          onTimeUpdate={(e) => onTime(e.currentTarget.currentTime, e.currentTarget.duration)}
          onLoadedMetadata={(e) => set({ length: e.currentTarget.duration || 0 })}
          onEnded={() => {
            void api.setProgress(current.id, current.duration || time);
            void playNext();
          }}
        />
      )}
    </>
  );
}
