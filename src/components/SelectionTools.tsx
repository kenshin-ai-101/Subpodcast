/**
 * [INPUT]: api.translateTexts / getEpisode；jobs 字幕译文；highlights.createManualClip；VideoClipDialog
 * [OUTPUT]: SelectionTools 浮动条（复制带出处 / 翻译 / 剪视频）
 * [POS]: 字幕与问答选区操作；不做海报（PRD 明确不做）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState } from "react";
import { Copy, Languages, Scissors } from "lucide-react";
import { api, type Episode } from "../lib/api";
import { writeClipboardText } from "../lib/clipboard";
import { createManualClip } from "../lib/highlights";
import { useT } from "../lib/i18n";
import { useJobs } from "../lib/jobs";
import { useStore } from "../store";
import { openVideoClipDialog } from "./VideoClipDialog";

const ZONES = ".deep-body, .lines, .notes-body, .chat-scroll, .summary-pane, .hl-list";

interface Sel {
  text: string;
  x: number;
  y: number;
  below: boolean;
  ts?: string;
  startIdx?: number;
  endIdx?: number;
}

/** 划词工具条：复制出处、翻译、剪视频（有 videoId 且落在字幕行时）。 */
export function SelectionTools() {
  const t = useT();
  const [sel, setSel] = useState<Sel | null>(null);
  const [tr, setTr] = useState<string | null>(null);
  const view = useStore((s) => s.view);
  const current = useStore((s) => s.current);
  const [hasVideo, setHasVideo] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (view.kind !== "episode") {
      setHasVideo(!!current?.videoId);
      return;
    }
    if (current?.id === view.id) {
      setHasVideo(!!current.videoId);
      return;
    }
    let live = true;
    void api
      .getEpisode(view.id)
      .then((ep) => {
        if (live) setHasVideo(!!ep?.videoId);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [view, current?.id, current?.videoId]);

  useEffect(() => {
    const read = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed || !s.rangeCount) {
        setSel(null);
        setTr(null);
        return;
      }
      const text = s.toString().replace(/\s+/g, " ").trim();
      const r = s.getRangeAt(0);
      const host = (
        r.commonAncestorContainer.nodeType === 1
          ? (r.commonAncestorContainer as HTMLElement)
          : r.commonAncestorContainer.parentElement
      ) as HTMLElement | null;
      if (text.length < 4 || !host?.closest(ZONES) || host.closest(".sel-bar")) {
        setSel(null);
        return;
      }
      // 学英语单词语卡优先
      if (/^[A-Za-z][A-Za-z'’-]*$/.test(text) && host.closest(".lines.learning")) {
        setSel(null);
        return;
      }
      const rect = r.getBoundingClientRect();
      const startLine = (
        r.startContainer.nodeType === 1
          ? (r.startContainer as HTMLElement)
          : r.startContainer.parentElement
      )?.closest<HTMLElement>(".line[data-i]");
      const endLine = (
        r.endContainer.nodeType === 1
          ? (r.endContainer as HTMLElement)
          : r.endContainer.parentElement
      )?.closest<HTMLElement>(".line[data-i]");
      const ts = startLine?.querySelector(".line-time")?.textContent || undefined;
      const sRaw = startLine ? Number(startLine.dataset.i) : NaN;
      const eRaw = endLine ? Number(endLine.dataset.i) : sRaw;
      const startIdx = Number.isFinite(sRaw)
        ? Math.min(sRaw, Number.isFinite(eRaw) ? eRaw : sRaw)
        : undefined;
      const endIdx = Number.isFinite(sRaw)
        ? Math.max(sRaw, Number.isFinite(eRaw) ? eRaw : sRaw)
        : undefined;
      const below = rect.top < 70;
      setTr(null);
      setSel({
        text,
        x: Math.max(8, Math.min(rect.left + rect.width / 2, innerWidth - 8)),
        y: below ? rect.bottom + 10 : rect.top - 10,
        below,
        ts,
        startIdx,
        endIdx,
      });
    };
    const onChange = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(read, 220);
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, []);

  const episode = async (): Promise<Episode | null> => {
    const { view: v, current: c } = useStore.getState();
    if (v.kind === "episode") return (await api.getEpisode(v.id)) ?? c;
    return c;
  };

  const copy = async () => {
    if (!sel) return;
    const ep = await episode();
    const src = ep
      ? `——《${ep.title}》${ep.showTitle ? ` · ${ep.showTitle}` : ""}${sel.ts ? ` · ${sel.ts}` : ""}${ep.link ? `\n${ep.link}` : ""}`
      : "";
    try {
      await writeClipboardText(`“${sel.text}”\n${src}`);
      useStore.getState().notify(t("已复制，带出处"));
    } catch {
      useStore.getState().notify(t("复制失败"));
    }
  };

  const translate = async () => {
    if (!sel) return;
    setTr("…");
    const looksZh = /[\u4e00-\u9fff]/.test(sel.text) && !/[a-z]{4}/i.test(sel.text);
    try {
      const out = await api.translateTexts([sel.text], looksZh ? "en" : "zh-CN");
      setTr(out[0] || t("没有翻译结果"));
    } catch {
      setTr(t("翻译服务暂时连不上，稍后再试"));
    }
  };

  const clipVideo = async () => {
    if (!sel || sel.startIdx == null) return;
    const ep = await episode();
    if (!ep?.videoId) return;
    const trData = useJobs.getState().transcripts[ep.id];
    if (!trData?.segments.length) return;
    const zhItems = useJobs.getState().translations[ep.id]?.items;
    const clip = createManualClip(trData.segments, zhItems, sel.startIdx, sel.endIdx ?? sel.startIdx, ep);
    setSel(null);
    window.getSelection()?.removeAllRanges();
    openVideoClipDialog({ ep, segments: trData.segments, zh: zhItems, clip });
  };

  if (!sel) return null;
  return (
    <div
      className={`sel-bar ${sel.below ? "below" : ""}`}
      style={{ left: sel.x, top: sel.y }}
      role="toolbar"
      aria-label={t("选中文字操作")}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="sel-actions">
        <button type="button" onClick={() => void copy()}>
          <Copy size={13} /> {t("复制")}
        </button>
        <button type="button" onClick={() => void translate()}>
          <Languages size={13} /> {t("翻译")}
        </button>
        {hasVideo && sel.startIdx != null && (
          <button type="button" onClick={() => void clipVideo()}>
            <Scissors size={13} /> {t("剪视频")}
          </button>
        )}
      </div>
      {tr && <p className="sel-tr">{tr}</p>}
    </div>
  );
}
