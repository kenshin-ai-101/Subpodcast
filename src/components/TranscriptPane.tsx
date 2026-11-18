/**
 * [INPUT]: jobs 字幕/译文、store.time / settings.subtitleMode
 * [OUTPUT]: 右侧字幕面板（.line 列表，对齐 SubCast）
 * [POS]: 听懂主路径阅读面；默认模式跟随设置
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { errText, type Episode } from "../lib/api";
import { clock } from "../lib/format";
import { ensureTranscript, looksChinese, runCloudAsr, translateEpisode, useJobs } from "../lib/jobs";
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

type Mode = "bilingual" | "translation" | "original";

export function TranscriptPane({ episode }: { episode: Episode }) {
  const time = useStore((s) => s.time);
  const player = useStore((s) => s.player);
  const notify = useStore((s) => s.notify);
  const subtitleMode = useStore((s) => s.settings.subtitleMode);
  const { transcript, official, error, translation, asrRunning } = useJobs(
    useShallow((s) => ({
      transcript: s.transcripts[episode.id],
      official: s.official[episode.id] ?? "idle",
      error: s.officialError[episode.id],
      translation: s.translations[episode.id],
      asrRunning: s.asrRunning[episode.id],
    })),
  );
  const [mode, setMode] = useState<Mode>(subtitleMode);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMode(subtitleMode);
  }, [subtitleMode]);

  useEffect(() => {
    void ensureTranscript(episode);
  }, [episode.id]);

  useEffect(() => {
    if (!transcript?.segments.length) return;
    const sample = transcript.segments.slice(0, 5).map((s) => s.text).join("");
    if (!looksChinese(transcript.language, sample)) void translateEpisode(episode, transcript);
  }, [transcript?.episodeId, transcript?.segments.length]);

  const segs = transcript?.segments ?? [];
  const starts = segs.map((s) => s.start);
  const active = segs.length ? activeIndex(starts, time) : -1;
  const foreign = transcript ? !looksChinese(transcript.language, segs.slice(0, 3).map((s) => s.text).join("")) : false;

  useEffect(() => {
    const root = listRef.current;
    if (!root || active < 0) return;
    root.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  if (official === "searching" || official === "idle") {
    return (
      <div className="transcript">
        <div className="panel-empty">
          <p className="muted">正在查找节目自带的字幕…</p>
        </div>
      </div>
    );
  }

  if (!segs.length) {
    return (
      <div className="transcript">
        <div className="panel-empty">
          <p className="lead">这集还没有字幕</p>
          <p className="muted">
            {official === "error"
              ? `节目自带的字幕没读到：${error ?? "未知错误"}`
              : "先查官方字幕。没有的话，可用云端识别（音频会上传）。"}
          </p>
          <button
            className="btn primary"
            disabled={asrRunning || !episode.audioUrl}
            onClick={() => void runCloudAsr(episode).catch((e) => notify(errText(e)))}
          >
            {asrRunning ? "识别中…" : "生成字幕"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="transcript">
      <div className="panel-bar">
        <span className="source-tag">{transcript!.source}</span>
        <div className="spacer" />
        {foreign && (
          <div className="seg-control" role="group" aria-label="字幕显示">
            {(
              [
                ["bilingual", "双语"],
                ["translation", "中文"],
                ["original", "原文"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} className={mode === k ? "on" : ""} onClick={() => setMode(k)}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {translation?.running && <div className="translate-bar">正在翻译成中文…</div>}
      {translation?.error && <div className="translate-bar">{translation.error}</div>}
      <div className="lines" ref={listRef}>
        {segs.map((s, i) => {
          const zh = translation?.items?.[i];
          const showZh = foreign && zh && mode !== "original";
          const showOrig = mode !== "translation" || !zh;
          return (
            <div
              key={`${s.start}-${i}`}
              data-i={i}
              className={`line ${i === active ? "active" : ""}`}
              onClick={() => player?.seek(s.start)}
            >
              <div className="line-time">{clock(s.start)}</div>
              <div className="line-text">
                {showZh && <div className="zh">{zh}</div>}
                {showOrig && <div className="orig">{s.text}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
