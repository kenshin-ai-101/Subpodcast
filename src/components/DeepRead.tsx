/**
 * [INPUT]: api.getBlob / qiaomuDetail；store.player；opener.openUrl
 * [OUTPUT]: 精读长文面板（sanitize HTML、data-t 跳播、豆包朗读）
 * [POS]: EpisodeView「精读」Tab；朗读与导读共用 ReadAloud
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useMemo, useState } from "react";
import { BookOpen, ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type Episode } from "../lib/api";
import { parseClock } from "../lib/format";
import { useStore } from "../store";
import { ReadAloud } from "./ReadAloud";

const KEEP = new Set([
  "P",
  "H2",
  "H3",
  "H4",
  "BLOCKQUOTE",
  "UL",
  "OL",
  "LI",
  "STRONG",
  "EM",
  "B",
  "I",
  "A",
  "BR",
  "HR",
  "SPAN",
  "ASIDE",
  "FIGURE",
  "FIGCAPTION",
  "CODE",
  "PRE",
]);

/** 去掉可执行内容，只留结构、链接与 data-t 时间戳。 */
function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return "";
  const walk = (el: Element) => {
    for (const c of Array.from(el.children)) {
      walk(c);
      if (["SCRIPT", "STYLE", "IFRAME", "BUTTON", "FORM", "INPUT", "SVG", "IMG", "VIDEO", "AUDIO"].includes(c.tagName)) {
        c.remove();
        continue;
      }
      if (!KEEP.has(c.tagName)) {
        c.replaceWith(...Array.from(c.childNodes));
        continue;
      }
      const href = c.getAttribute("href");
      const t = c.getAttribute("data-t");
      for (const a of Array.from(c.attributes)) c.removeAttribute(a.name);
      if (c.tagName === "A" && href && /^https?:/.test(href)) c.setAttribute("href", href);
      if (t && /^[\d:]+$/.test(t)) {
        c.setAttribute("data-t", t);
        c.setAttribute("class", "ts");
      }
    }
  };
  walk(root);
  return root.innerHTML;
}

export function DeepRead({
  ep,
  children,
  onMissing,
}: {
  ep: Episode;
  children?: React.ReactNode;
  onMissing?: () => void;
}) {
  const [html, setHtml] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setHtml(undefined);
    void api.getBlob(ep.id, "deep-read").then(async (cached) => {
      if (cached) {
        if (live) setHtml(cached);
        return;
      }
      try {
        const d = await api.qiaomuDetail(ep.id);
        if (live) setHtml(d.deepRead ?? null);
      } catch {
        if (live) setHtml(null);
      }
    });
    return () => {
      live = false;
    };
  }, [ep.id]);

  useEffect(() => {
    if (html === null) onMissing?.();
  }, [html, onMissing]);

  const clean = useMemo(() => (html ? sanitize(html) : ""), [html]);
  const readText = () => {
    const doc = new DOMParser().parseFromString(clean, "text/html");
    doc.querySelectorAll("[data-t]").forEach((n) => n.remove());
    return Array.from(doc.body.querySelectorAll("p, h2, h3, h4, li, blockquote"))
      .map((n) => n.textContent?.trim())
      .filter(Boolean)
      .join("\n");
  };

  if (html === undefined) {
    return (
      <div className="panel-empty">
        <p className="lead">正在加载精读</p>
        <p className="muted">通读整期访谈后的中文长文…</p>
      </div>
    );
  }
  if (!html) return <>{children}</>;

  return (
    <div className="deep-read">
      <div className="deep-head">
        <span className="deep-badge" title="AI 基于完整访谈改写的中文长文，不是逐字翻译">
          <BookOpen size={13} /> 乔木精读
        </span>
        <span className="spacer" />
        <ReadAloud text={readText} title="用豆包语音朗读精读全文" />
        {ep.link && (
          <button type="button" className="icon-btn" title="在网页中打开" onClick={() => void openUrl(ep.link!)}>
            <ExternalLink size={14} />
          </button>
        )}
      </div>
      <article
        className="deep-body"
        dangerouslySetInnerHTML={{ __html: clean }}
        onClick={(e) => {
          const el = e.target as HTMLElement;
          const ts = el.closest<HTMLElement>("[data-t]");
          if (ts?.dataset.t) {
            const sec = parseClock(ts.dataset.t);
            if (sec != null) useStore.getState().player?.seek(sec);
            return;
          }
          const a = el.closest("a");
          if (a?.href) {
            e.preventDefault();
            void openUrl(a.href);
          }
        }}
      />
    </div>
  );
}
