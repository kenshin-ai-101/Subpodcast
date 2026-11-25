/**
 * [INPUT]: jobs 字幕/译文；store.time / scrubTime / subtitleMode / subtitleLift；pieces.pieceAt；playback.activeIndex；subtitleRead
 * [OUTPUT]: SubtitleOverlay — 视频叠字幕（单句短切 + 拖拽进度条实时预览 + 上下拖拽移位 + 双击复位 + 画中 Aa 调字幕）
 * [POS]: 挂载在视频舞台（单集页与离页浮窗共用；interactive=false 时用于浮窗只读显示）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useJobs } from "../lib/jobs";
import { pieceAt } from "../lib/pieces";
import { activeIndex } from "../lib/playback";
import { updateSubLift } from "../lib/reading";
import { useSubtitleRead } from "../lib/subtitleRead";
import { useStore } from "../store";
import { SubtitleTune } from "./SubtitleTune";

function SubtitleLine({
  episodeId,
  interactive,
}: {
  episodeId: string;
  interactive: boolean;
}) {
  const mode = useStore((s) => s.settings.subtitleMode);
  const readIndex = useSubtitleRead((s) => (s.episodeId === episodeId ? s.lineIndex : null));
  const { transcript, items } = useJobs(
    useShallow((s) => ({
      transcript: s.transcripts[episodeId],
      items: s.translations[episodeId]?.items,
    })),
  );
  const dragState = useRef<{
    startY: number;
    baseLift: number;
    stageHeight: number;
    moved: boolean;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const tapTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(tapTimer.current), []);

  const segs = transcript?.segments;
  const starts = useMemo(() => segs?.map((x) => x.start) ?? [], [segs]);

  // 仅订阅当前展示的文本，避免同句同片内因 time tick 重复渲染
  const cue = useStore(
    useShallow((s) => {
      if (!segs?.length || !starts.length) return { i: -1, orig: "", zh: "" };
      if (readIndex != null && s.scrubTime == null) {
        const seg = segs[readIndex];
        if (!seg) return { i: -1, orig: "", zh: "" };
        return {
          i: readIndex,
          orig: seg.text,
          zh: items?.[readIndex] ?? "",
        };
      }
      const t = s.current?.id === episodeId ? (s.scrubTime ?? s.time) : 0;
      const i = activeIndex(starts, t);
      if (i < 0) return { i: -1, orig: "", zh: "" };
      const seg = segs[i];
      if (!seg || t > seg.end + 1.5) return { i: -1, orig: "", zh: "" };
      const progress = Math.min(
        1,
        Math.max(0, (t - seg.start) / Math.max(0.5, seg.end - seg.start)),
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
  // 「中文」模式若当前句尚未译出，临时回退原文，译出后自动切换为纯中文
  const showOrig = mode !== "translation" || !cue.zh;
  if (!showZh && !showOrig) return null;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive || e.button !== 0) return;
    const stage = e.currentTarget.closest<HTMLElement>(".video-cq, .video");
    if (!stage) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragState.current = {
      startY: e.clientY,
      baseLift: useStore.getState().settings.subtitleLift ?? 0,
      stageHeight: stage.clientHeight || 1,
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragState.current;
    if (!d) return;
    const dy = d.startY - e.clientY;
    if (!d.moved && Math.abs(dy) < 4) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(true);
    }
    updateSubLift(d.baseLift + (dy / d.stageHeight) * 100);
  };

  const finishDrag = () => {
    const d = dragState.current;
    dragState.current = null;
    setDragging(false);
    if (d && !d.moved) {
      window.clearTimeout(tapTimer.current);
      tapTimer.current = window.setTimeout(() => {
        useStore.getState().player?.toggle();
      }, 240);
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!interactive) return;
    e.stopPropagation();
    window.clearTimeout(tapTimer.current);
    updateSubLift(0);
  };

  return (
    <div className="subtitle-overlay" aria-hidden={!interactive || undefined}>
      <div
        className={`sub-box${dragging ? " dragging" : ""}`}
        onPointerDown={interactive ? onPointerDown : undefined}
        onPointerMove={interactive ? onPointerMove : undefined}
        onPointerUp={interactive ? finishDrag : undefined}
        onPointerCancel={interactive ? finishDrag : undefined}
        onDoubleClick={interactive ? onDoubleClick : undefined}
      >
        {showZh && <p className="sub-zh">{cue.zh}</p>}
        {showOrig && <p className="sub-orig">{cue.orig}</p>}
      </div>
    </div>
  );
}

export function SubtitleOverlay({
  episodeId,
  interactive = true,
}: {
  episodeId: string;
  interactive?: boolean;
}) {
  const hasTranscript = useJobs((s) => Boolean(s.transcripts[episodeId]?.segments.length));
  if (!hasTranscript) return null;
  return (
    <>
      <SubtitleLine episodeId={episodeId} interactive={interactive} />
      {interactive && <SubtitleTune />}
    </>
  );
}
