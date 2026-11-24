/**
 * [INPUT]: jobs 字幕/译文（含节目方中文对齐）、store.time / settings.subtitleMode
 * [OUTPUT]: 视频上的双语叠字幕
 * [POS]: YouTube 舞台叠加层；与字幕面板共用时间轴与 autoTranslate 结果
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useJobs } from "../lib/jobs";
import { activeIndex } from "../lib/playback";
import { useStore } from "../store";

export function SubtitleOverlay({ episodeId }: { episodeId: string }) {
  const time = useStore((s) => s.time);
  const mode = useStore((s) => s.settings.subtitleMode);
  const { transcript, items } = useJobs(
    useShallow((s) => ({
      transcript: s.transcripts[episodeId],
      items: s.translations[episodeId]?.items,
    })),
  );
  const segs = transcript?.segments ?? [];
  const starts = useMemo(() => segs.map((x) => x.start), [segs]);
  if (!segs.length) return null;
  const i = activeIndex(starts, time);
  const seg = segs[i];
  if (!seg || time > seg.end + 1.5) return null;
  const zh = items?.[i];
  return (
    <div className="subtitle-overlay" aria-hidden>
      <div className="sub-box">
        {zh && mode !== "original" && <p className="sub-zh">{zh}</p>}
        {(mode !== "translation" || !zh) && <p className="sub-orig">{seg.text}</p>}
      </div>
    </div>
  );
}
