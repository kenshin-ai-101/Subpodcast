/**
 * [INPUT]: api.getBlob / qiaomuDetail；store.player；opener.openUrl
 * [OUTPUT]: 精读长文面板（sanitize HTML、data-t 跳播、豆包朗读）
 * [POS]: EpisodeView「精读」Tab；朗读与导读共用 ReadAloud
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useMemo, useState } from "react";
import { BookOpen, ExternalLink } from "lucide-react";
import DOMPurify from "dompurify";
import { api, type Episode } from "../lib/api";
import { parseClock } from "../lib/format";
import { useT } from "../lib/i18n";
import { seekEpisode } from "../lib/playback";
import { openExternalUrl } from "../lib/safeUrl";
import { ReadAloud } from "./ReadAloud";

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
    const t = el.getAttribute("data-t");
    if (t) {
      if (/^[\d:]+$/.test(t)) {
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
        <p className="lead">{t("正在加载精读")}</p>
        <p className="muted">{t("通读整期访谈后的中文长文…")}</p>
      </div>
    );
  }
  if (!html) return <>{children}</>;

  return (
    <div className="deep-read">
      <div className="deep-head">
        <span className="deep-badge" title={t("AI 基于完整访谈改写的中文长文，不是逐字翻译")}>
          <BookOpen size={13} /> {t("乔木精读")}
        </span>
        <span className="spacer" />
        <ReadAloud text={readText} title={t("朗读精读全文")} />
        {ep.link && (
          <button type="button" className="icon-btn" title={t("在网页中打开")} onClick={() => void openExternalUrl(ep.link!)}>
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
    </div>
  );
}
