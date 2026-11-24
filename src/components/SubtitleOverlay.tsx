/**
 * [INPUT]: jobs 字幕/译文；store.time / subtitleMode；pieces.pieceAt；playback.activeIndex
 * [OUTPUT]: 视频上的双语叠字幕（按块内进度只显示正在说的那一句）
 * [POS]: YouTube 舞台叠加层；与原站一致——长块按字长均摊切句，同句不因 time tick 重建
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { looksChinese, useJobs } from "../lib/jobs";
import { pieceAt } from "../lib/pieces";
import { activeIndex, SUBTITLE_LEAD } from "../lib/playback";
import { useSubtitleRead } from "../lib/subtitleRead";
import { useStore } from "../store";

export function SubtitleOverlay({ episodeId }: { episodeId: string }) {
  const mode = useStore((s) => s.settings.subtitleMode);
  const readIndex = useSubtitleRead((s) => (s.episodeId === episodeId ? s.lineIndex : null));
  const { transcript, items } = useJobs(
    useShallow((s) => ({
      transcript: s.transcripts[episodeId],
      items: s.translations[episodeId]?.items,
    })),
  );
  const segs = transcript?.segments;
  const foreign = useMemo(
    () =>
      transcript
        ? !looksChinese(transcript.language, (segs ?? []).slice(0, 3).map((s) => s.text).join(""))
        : false,
    [transcript, segs],
  );
  const starts = useMemo(() => segs?.map((x) => x.start) ?? [], [segs]);
  // 只订阅当前显示的文案：Object.is 同句同进度片内恒等
  const cue = useStore(
    useShallow((s) => {
      if (!segs?.length || !starts.length) return { i: -1, orig: "", zh: "" };
      if (readIndex != null) {
        const seg = segs[readIndex];
        if (!seg) return { i: -1, orig: "", zh: "" };
        return {
          i: readIndex,
          orig: seg.text,
          zh: items?.[readIndex] ?? "",
        };
      }
      const t = s.current?.id === episodeId ? s.time : 0;
      const i = activeIndex(starts, t);
      if (i < 0) return { i: -1, orig: "", zh: "" };
      const seg = segs[i];
      if (!seg || t > seg.end + 1.5) return { i: -1, orig: "", zh: "" };
      const progress = Math.min(
        1,
        Math.max(0, (t + SUBTITLE_LEAD - seg.start) / Math.max(0.5, seg.end - seg.start)),
      );
      const cjk = /[\u4e00-\u9fff]/.test(seg.text);
      const zhRaw = items?.[i];
      return {
        i,
        orig: pieceAt(seg.text, cjk, progress),
        zh: zhRaw ? pieceAt(zhRaw, true, progress) : "",
      };
    }),
  );
  if (cue.i < 0) return null;
  const showZh = Boolean(cue.zh && mode !== "original");
  // 外语节目切到「中文」模式时只显示中文，绝不显示英文原文
  const showOrig = !foreign || mode !== "translation";
  if (!showZh && !showOrig) return null;
  return (
    <div className="subtitle-overlay" aria-hidden>
      <div className="sub-box">
        {showZh && <p className="sub-zh">{cue.zh}</p>}
        {showOrig && <p className="sub-orig">{cue.orig}</p>}
      </div>
    </div>
  );
}
