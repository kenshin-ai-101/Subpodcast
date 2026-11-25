/**
 * [INPUT]: api.getBlob / qiaomuDetail；markSentences；ReadAlongControls / useReadAlongPage
 * [OUTPUT]: 精读长文面板（sanitize、句级跟读、data-t 跳播）
 * [POS]: EpisodeView「精读」Tab；跟读进度跟 TTS，时间戳仍跳播客
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, ExternalLink } from "lucide-react";
import DOMPurify from "dompurify";
import { api, type Episode } from "../lib/api";
import { parseClock } from "../lib/format";
import { useT } from "../lib/i18n";
import { seekEpisode } from "../lib/playback";
import { useReadAlong } from "../lib/readAlong";
import { markSentences } from "../lib/sentences";
import { openExternalUrl } from "../lib/safeUrl";
import { ReadAlongControls, useReadAlongPage } from "./ReadAlong";

const ALLOWED_TAGS = [
  "p",
  "h2",
  "h3",
  "h4",
  "blockquote",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "b",
  "i",
  "a",
  "br",
  "hr",
  "span",
  "aside",
  "figure",
  "figcaption",
  "code",
  "pre",
];

/** 使用 DOMPurify 清洗远端精读 HTML，只留安全排版标签、http(s) 链接与合法 data-t 时间戳。 */
function sanitize(html: string): string {
  const purified = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "data-t"],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ["data-t"],
    ALLOWED_URI_REGEXP: /^https?:\/\//i,
    FORBID_CONTENTS: ["script", "style", "iframe", "object", "embed", "noscript", "template", "math", "svg"],
  });
  const doc = new DOMParser().parseFromString(`<div>${purified}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return "";
  for (const el of Array.from(root.querySelectorAll("[data-t], a"))) {
    if (el.tagName === "A") {
      const href = el.getAttribute("href") ?? "";
      if (!/^https?:\/\//i.test(href)) {
        el.removeAttribute("href");
      } else {
        el.setAttribute("rel", "noopener noreferrer");
      }
    }
    const stamp = el.getAttribute("data-t");
    if (stamp) {
      if (/^[\d:]+$/.test(stamp)) {
        el.setAttribute("class", "ts");
      } else {
        el.removeAttribute("data-t");
      }
    }
  }
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
  const t = useT();
  const [html, setHtml] = useState<string | null | undefined>(undefined);
  const article = useRef<HTMLElement>(null);
  const owner = `deep:${ep.id}`;

  useEffect(() => {
    let live = true;
    setHtml(undefined);
    void api
      .getBlob(ep.id, "deep-read")
      .then(async (cached) => {
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
      })
      .catch(() => {
        if (live) setHtml(null);
      });
    return () => {
      live = false;
    };
  }, [ep.id]);

  useEffect(() => {
    if (html === null) onMissing?.();
  }, [html, onMissing]);

  const marked = useMemo(() => (html ? markSentences(sanitize(html)) : { html: "", sentences: [] }), [html]);
  const reading = useReadAlongPage(owner, article);
  const readingHere = useReadAlong((s) => s.owner === owner);

  if (html === undefined) {
    return (
      <div className="panel-empty">
        <p className="lead">{t("正在加载精读")}</p>
        <p className="muted">{t("通读整期访谈后的中文长文…")}</p>
      </div>
    );
  }
  if (!html) return <>{children}</>;

  return (
    <div className="deep-read">
      <div className={`deep-head ${readingHere ? "ra-on" : ""}`}>
        <span className="deep-badge" title={t("AI 基于完整访谈改写的中文长文，不是逐字翻译")}>
          <BookOpen size={13} /> <span className="deep-badge-text">{t("乔木精读")}</span>
        </span>
        <span className="spacer" />
        <ReadAlongControls owner={owner} sentences={marked.sentences} />
        {ep.link && (
          <button type="button" className="icon-btn" title={t("在网页中打开")} onClick={() => void openExternalUrl(ep.link!)}>
            <ExternalLink size={14} />
          </button>
        )}
      </div>
      <article
        ref={article}
        className="deep-body"
        dangerouslySetInnerHTML={{ __html: marked.html }}
        onClick={(e) => {
          if (reading.onClick(e)) return;
          const el = e.target as HTMLElement;
          const ts = el.closest<HTMLElement>("[data-t]");
          if (ts?.dataset.t) {
            const sec = parseClock(ts.dataset.t);
            if (sec != null) seekEpisode(ep, sec);
            return;
          }
          const a = el.closest("a");
          if (a?.href) {
            e.preventDefault();
            void openExternalUrl(a.href);
          }
        }}
      />
      {reading.backToReading}
    </div>
  );
}
