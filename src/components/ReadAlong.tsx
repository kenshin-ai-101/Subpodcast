/**
 * [INPUT]: markSentences 句列表；useReadAlong；RatePicker / ReadAloudSettings
 * [OUTPUT]: ReadAlongControls（起停/跳句/语速/音色）+ useReadAlongPage（句高亮、跟滚、点句、回到朗读位置）
 * [POS]: DeepRead 顶栏与正文；进度跟 TTS，不跟播客时钟
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  ChevronDown,
  Loader2,
  LocateFixed,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Volume2,
  X,
} from "lucide-react";
import { useT } from "../lib/i18n";
import {
  resumeIndex,
  seekReading,
  startReading,
  stopReading,
  toggleReading,
  useReadAlong,
} from "../lib/readAlong";
import { isKeyError } from "../lib/tts";
import { useStore } from "../store";
import { RatePicker } from "./RatePicker";
import { ReadAloudSettings } from "./ReadAloud";

/** 顶栏控制：`owner` 标识文章，`sentences` 为已标记句列表。 */
export function ReadAlongControls({ owner, sentences }: { owner: string; sentences: string[] }) {
  const t = useT();
  const { active, index, state, error } = useReadAlong(
    useShallow((s) => ({
      active: s.owner === owner,
      index: s.index,
      state: s.state,
      error: s.error,
    })),
  );
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active || state !== "error" || !error) return;
    useStore.getState().notify(error);
    if (isKeyError(error)) setOpen(true);
  }, [active, state, error]);

  const resume = active ? 0 : resumeIndex(owner, sentences.length);
  const total = sentences.length;
  const busy = state === "loading";
  const playing = state === "playing" || busy;

  return (
    <div className="read-aloud read-along" ref={box}>
      {!active ? (
        <>
          <button
            type="button"
            className="btn sm"
            disabled={!total}
            title={t("朗读全文，点任意一句可从那里读")}
            onClick={() => startReading(owner, sentences, resume)}
          >
            <Volume2 size={13} /> {resume ? t("继续朗读") : t("朗读")}
          </button>
          {resume > 0 && (
            <button
              type="button"
              className="icon-btn sm"
              title={t("从头读")}
              aria-label={t("从头读")}
              onClick={() => startReading(owner, sentences, 0)}
            >
              <RotateCcw size={13} />
            </button>
          )}
        </>
      ) : (
        <div className="ra-bar" role="group" aria-label={t("朗读控制")}>
          <button
            type="button"
            className="icon-btn sm ra-skip"
            title={t("上一句")}
            aria-label={t("上一句")}
            disabled={index <= 0}
            onClick={() => seekReading(index - 1)}
          >
            <SkipBack size={13} />
          </button>
          <button
            type="button"
            className={`ra-play ${busy ? "busy" : ""}`}
            title={state === "ended" ? t("重新朗读") : playing ? t("暂停") : t("继续")}
            aria-label={state === "ended" ? t("重新朗读") : playing ? t("暂停") : t("继续")}
            onClick={toggleReading}
          >
            {busy ? (
              <Loader2 size={14} className="spin" />
            ) : state === "ended" ? (
              <RotateCcw size={13} />
            ) : playing ? (
              <Pause size={13} fill="currentColor" />
            ) : (
              <Play size={13} fill="currentColor" />
            )}
          </button>
          <button
            type="button"
            className="icon-btn sm ra-skip"
            title={t("下一句")}
            aria-label={t("下一句")}
            disabled={index >= total - 1}
            onClick={() => seekReading(index + 1)}
          >
            <SkipForward size={13} />
          </button>
          <span className="ra-pos num" aria-live="polite">
            {state === "ended"
              ? t("读完了")
              : busy && index === 0
                ? t("正在准备…")
                : `${index + 1} / ${total}`}
          </span>
          <button
            type="button"
            className="icon-btn sm"
            title={t("停止朗读")}
            aria-label={t("停止朗读")}
            onClick={stopReading}
          >
            <X size={13} />
          </button>
        </div>
      )}
      <RatePicker />
      <button
        type="button"
        className="icon-btn sm"
        aria-label={t("朗读设置")}
        title={t("朗读设置")}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronDown size={13} />
      </button>
      {open && <ReadAloudSettings anchorRef={box} onClose={() => setOpen(false)} />}
    </div>
  );
}

/**
 * 当前句着色、已读字高亮、滚入视口；朗读中点句 seekReading。
 * `article`：承载 marked 句的元素，且为滚动容器（`.deep-body`）。
 */
export function useReadAlongPage(owner: string, article: RefObject<HTMLElement | null>) {
  const t = useT();
  const { active, index, state } = useReadAlong(
    useShallow((s) => ({ active: s.owner === owner, index: s.index, state: s.state })),
  );
  const [follow, setFollow] = useState(true);
  const programmatic = useRef(0);
  /** 声译精读：头栏钉住，正文 `.deep-body` 自滚（异于 SubCast 整页 `.deep-read` 滚动）。 */
  const scroller = () => article.current;

  useEffect(() => {
    const root = article.current;
    if (!root) return;
    root.querySelectorAll(".ra-s.on").forEach((n) => n.classList.remove("on"));
    root.classList.toggle("ra-on", active);
    if (!active || state === "ended") return;
    const spans = root.querySelectorAll<HTMLElement>(`.ra-s[data-s="${index}"]`);
    spans.forEach((n) => n.classList.add("on"));
    const box = scroller();
    if (follow && box && spans[0]) {
      const top = spans[0].getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      const visible = top > box.scrollTop + 60 && top < box.scrollTop + box.clientHeight - 100;
      if (!visible) {
        programmatic.current = performance.now() + 700;
        box.scrollTo({ top: Math.max(0, top - box.clientHeight / 3), behavior: "smooth" });
      }
    }
  }, [active, index, state, follow, article]);

  useEffect(() => {
    const box = scroller();
    if (!box || !active) return;
    const away = () => {
      if (performance.now() > programmatic.current) setFollow(false);
    };
    box.addEventListener("wheel", away, { passive: true });
    box.addEventListener("touchmove", away, { passive: true });
    return () => {
      box.removeEventListener("wheel", away);
      box.removeEventListener("touchmove", away);
    };
  }, [active, article]);

  useEffect(() => {
    if (!active) setFollow(true);
  }, [active]);

  // CSS Highlight API：已读字着色（无 DOM 改写；不支持时仅句底色）。
  useEffect(() => {
    const HighlightCtor = (window as unknown as { Highlight?: new () => { clear: () => void; add: (r: Range) => void } }).Highlight;
    const reg = (globalThis.CSS as unknown as { highlights?: Map<string, unknown> & { set: (k: string, v: unknown) => void; delete: (k: string) => void } })?.highlights;
    if (!HighlightCtor || !reg || !active) return;
    const hl = new HighlightCtor();
    reg.set("ra-spoken", hl);
    const paint = (spoken: number, i: number) => {
      hl.clear();
      const root = article.current;
      if (!root || spoken <= 0) return;
      const range = document.createRange();
      let left = spoken;
      let started = false;
      for (const span of Array.from(root.querySelectorAll<HTMLElement>(`.ra-s[data-s="${i}"]`))) {
        const node = span.firstChild as Text | null;
        if (!node) continue;
        if (!started) {
          range.setStart(node, 0);
          started = true;
        }
        if (left <= node.length) {
          range.setEnd(node, left);
          hl.add(range);
          return;
        }
        left -= node.length;
        range.setEnd(node, node.length);
      }
      if (started) hl.add(range);
    };
    const s0 = useReadAlong.getState();
    paint(s0.spoken, s0.index);
    const un = useReadAlong.subscribe((s, p) => {
      if (s.spoken !== p.spoken || s.index !== p.index) paint(s.state === "ended" ? 0 : s.spoken, s.index);
    });
    return () => {
      un();
      hl.clear();
      reg.delete("ra-spoken");
    };
  }, [active, article]);

  /** 朗读中：点句跳读；返回 true 表示已处理。 */
  const onClick = (e: React.MouseEvent): boolean => {
    if (!active) return false;
    const el = e.target as HTMLElement;
    if (el.closest("a, [data-t]")) return false;
    if (!window.getSelection()?.isCollapsed) return false;
    const s = el.closest<HTMLElement>(".ra-s");
    if (!s) return false;
    setFollow(true);
    seekReading(Number(s.dataset.s));
    return true;
  };

  const backToReading =
    !active || follow || state === "ended" ? null : (
      <button type="button" className="ra-return" onClick={() => setFollow(true)}>
        <LocateFixed size={13} /> {t("回到朗读位置")}
      </button>
    );

  return { onClick, backToReading };
}
