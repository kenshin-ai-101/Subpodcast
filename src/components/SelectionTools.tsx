/**
 * [INPUT]: api.translateTexts / getEpisode；jobs 字幕与译文；highlights.createManualClip；QuotePosterDialog；VideoClipDialog
 * [OUTPUT]: SelectionTools 浮动条（复制带出处 / 翻译 / 生成海报 / 剪成视频）
 * [POS]: 字幕与文本选区操作；任意字幕段框选支持复制、翻译、生成海报、剪成视频（视频与纯音频播客全覆盖）
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/CLAUDE.md
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Copy, Image as ImageIcon, Languages, Loader2, Scissors } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { api, type Episode } from "../lib/api";
import { writeClipboardText } from "../lib/clipboard";
import { createManualClip } from "../lib/highlights";
import { useT } from "../lib/i18n";
import { useJobs } from "../lib/jobs";
import { showName } from "../lib/picks";
import { useStore } from "../store";
import { openQuotePosterDialog } from "./QuotePosterDialog";
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

function asElement(node: Node): HTMLElement | null {
  return node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
}

function lineElOf(node: Node): HTMLElement | null {
  const el = asElement(node);
  if (!el) return null;
  const direct = el.closest<HTMLElement>(".line[data-i]");
  if (direct) return direct;
  const row = el.closest<HTMLElement>("[data-index]");
  return row?.querySelector<HTMLElement>(".line[data-i]") ?? null;
}

/** 从 DOM Range 稳健提取字幕行号范围：兼容单行局部框选、三击整行（忽略落在下一行偏移 0 的尾锚）及跨行拖选。 */
function resolveLineRange(range: Range, host: HTMLElement): { startIdx?: number; endIdx?: number; ts?: string } {
  const linesRoot = host.closest<HTMLElement>(".lines");
  if (!linesRoot) return {};

  const startEl = lineElOf(range.startContainer);
  const endEl = lineElOf(range.endContainer);
  const sRaw = startEl ? Number(startEl.dataset.i) : NaN;
  let eRaw = endEl ? Number(endEl.dataset.i) : NaN;

  // 三击整行时浏览器常把 endContainer 落在下一行起始偏移 0 处，排除未实际选中的下一行
  if (
    Number.isFinite(sRaw) &&
    Number.isFinite(eRaw) &&
    eRaw > sRaw &&
    range.endOffset === 0 &&
    endEl &&
    range.endContainer !== startEl
  ) {
    eRaw -= 1;
  }

  let startIdx: number | undefined;
  let endIdx: number | undefined;

  if (Number.isFinite(sRaw) && Number.isFinite(eRaw)) {
    startIdx = Math.min(sRaw, eRaw);
    endIdx = Math.max(sRaw, eRaw);
  } else {
    // 选区起止落在外层容器时，用 intersectsNode 扫描所有相交的可见字幕行
    const hit: number[] = [];
    linesRoot.querySelectorAll<HTMLElement>(".line[data-i]").forEach((el) => {
      try {
        if (!range.intersectsNode(el)) return;
        const idx = Number(el.dataset.i);
        if (!Number.isFinite(idx)) return;
        if (range.endOffset === 0 && el.contains(range.endContainer) && !el.contains(range.startContainer)) {
          return;
        }
        hit.push(idx);
      } catch {
        /* ignore detached */
      }
    });
    if (hit.length) {
      startIdx = Math.min(...hit);
      endIdx = Math.max(...hit);
    } else if (Number.isFinite(sRaw)) {
      startIdx = sRaw;
      endIdx = sRaw;
    } else if (Number.isFinite(eRaw)) {
      startIdx = eRaw;
      endIdx = eRaw;
    }
  }

  const firstEl =
    startIdx != null
      ? (linesRoot.querySelector<HTMLElement>(`.line[data-i="${startIdx}"]`) ?? startEl)
      : startEl;
  const ts = firstEl?.querySelector(".line-time")?.textContent?.trim() || undefined;
  return { startIdx, endIdx, ts };
}

/** 划词工具条：复制带出处、翻译、生成海报、剪成视频（落在字幕行且有音视频源时）。 */
export function SelectionTools() {
  const t = useT();
  const [sel, setSel] = useState<Sel | null>(null);
  const [tr, setTr] = useState<string | null>(null);
  const { view, current } = useStore(useShallow((s) => ({ view: s.view, current: s.current })));
  const [canClip, setCanClip] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const barRef = useRef<HTMLDivElement>(null);
  const [clampedX, setClampedX] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!sel || !barRef.current) {
      setClampedX(null);
      return;
    }
    const half = barRef.current.offsetWidth / 2 + 8;
    const minX = Math.min(half, innerWidth / 2);
    const maxX = Math.max(minX, innerWidth - half);
    const next = Math.max(minX, Math.min(sel.x, maxX));
    setClampedX(next);
  }, [sel, canClip]);

  useEffect(() => {
    const hasMedia = (ep: Episode | null | undefined) => Boolean(ep?.videoId || ep?.audioUrl);
    if (view.kind !== "episode") {
      setCanClip(hasMedia(current));
      return;
    }
    if (current?.id === view.id) {
      setCanClip(hasMedia(current));
      return;
    }
    let live = true;
    void api
      .getEpisode(view.id)
      .then((ep) => {
        if (live) setCanClip(hasMedia(ep));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [view, current?.id, current?.videoId, current?.audioUrl]);

  useEffect(() => {
    const read = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed || !s.rangeCount) {
        setSel(null);
        setTr(null);
        return;
      }
      const rawText = s.toString();
      const text = rawText.replace(/\s+/g, " ").trim();
      const r = s.getRangeAt(0);
      const host = asElement(r.commonAncestorContainer);
      if (text.length < 2 || !host?.closest(ZONES) || host.closest(".sel-bar")) {
        setSel(null);
        return;
      }
      // 学英语单词语卡优先
      if (/^[A-Za-z][A-Za-z'’-]*$/.test(text) && host.closest(".lines.learning")) {
        setSel(null);
        return;
      }
      const rect = r.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setSel(null);
        return;
      }
      const { startIdx, endIdx, ts } = resolveLineRange(r, host);
      const below = rect.top < 74;
      const half = Math.min(200, innerWidth / 2 - 8);
      setTr(null);
      setSel({
        text: rawText.trim() || text,
        x: Math.max(half, Math.min(rect.left + rect.width / 2, innerWidth - half)),
        y: below ? rect.bottom + 10 : rect.top - 10,
        below,
        ts,
        startIdx,
        endIdx,
      });
    };
    const onChange = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(read, 200);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      window.clearTimeout(timer.current);
      document.removeEventListener("selectionchange", onChange);
    };
  }, []);

  const episode = async (): Promise<Episode | null> => {
    const { view: v, current: c } = useStore.getState();
    if (v.kind === "episode") return (await api.getEpisode(v.id)) ?? c;
    return c;
  };

  const copy = async () => {
    if (!sel) return;
    const ep = await episode();
    const clean = sel.text.replace(/\s+/g, " ").trim();
    const src = ep
      ? `——《${ep.title}》${ep.showTitle ? ` · ${showName(ep.showTitle)}` : ""}${sel.ts ? ` · ${sel.ts}` : ""}${ep.link ? `\n${ep.link}` : ""}`
      : "";
    try {
      await writeClipboardText(`“${clean}”\n${src}`);
      useStore.getState().notify(t("已复制，带出处"));
    } catch {
      useStore.getState().notify(t("复制失败"));
    }
  };

  const translate = async () => {
    if (!sel) return;
    setTr("…");
    const clean = sel.text.replace(/\s+/g, " ").trim();
    const looksZh = /[\u4e00-\u9fff]/.test(clean) && !/[a-z]{4}/i.test(clean);
    try {
      const out = await api.translateTexts([clean], looksZh ? "en" : "zh-CN");
      setTr(out[0] || t("没有翻译结果"));
    } catch {
      setTr(t("翻译服务暂时连不上，稍后再试"));
    }
  };

  const makePoster = async () => {
    if (!sel) return;
    const picked = sel;
    setSel(null);
    window.getSelection()?.removeAllRanges();
    const ep = await episode();
    const jobs = useJobs.getState();
    const trData = ep ? jobs.transcripts[ep.id] : undefined;
    const zhItems = ep ? jobs.translations[ep.id]?.items : undefined;
    openQuotePosterDialog({
      text: picked.text,
      ts: picked.ts,
      startIdx: picked.startIdx,
      endIdx: picked.endIdx,
      episode: ep,
      segments: trData?.segments,
      zh: zhItems,
    });
  };

  const clipVideo = async () => {
    if (!sel || sel.startIdx == null) return;
    const startIdx = sel.startIdx;
    const endIdx = sel.endIdx ?? startIdx;
    const ep = await episode();
    if (!ep || (!ep.videoId && !ep.audioUrl)) {
      useStore.getState().notify(t("当前单集没有可用音视频源"));
      return;
    }
    const jobs = useJobs.getState();
    const trData = jobs.transcripts[ep.id];
    if (!trData?.segments.length) {
      useStore.getState().notify(t("需要先有字幕才能剪视频"));
      return;
    }
    const zhItems = jobs.translations[ep.id]?.items;
    const clip = createManualClip(
      trData.segments,
      zhItems,
      startIdx,
      endIdx,
      ep,
    );
    setSel(null);
    window.getSelection()?.removeAllRanges();
    openVideoClipDialog({ ep, segments: trData.segments, zh: zhItems, clip });
  };

  if (!sel) return null;
  return (
    <div
      ref={barRef}
      className={`sel-bar ${sel.below ? "below" : ""}`}
      style={{ left: clampedX ?? sel.x, top: sel.y }}
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
        <button type="button" onClick={() => void makePoster()}>
          <ImageIcon size={13} /> {t("生成海报")}
        </button>
        {canClip && sel.startIdx != null && (
          <button type="button" onClick={() => void clipVideo()}>
            <Scissors size={13} /> {t("剪成视频")}
          </button>
        )}
      </div>
      {tr && (
        <div className="sel-tr">
          {tr === "…" ? <Loader2 size={13} className="spin" /> : tr}
        </div>
      )}
    </div>
  );
}
