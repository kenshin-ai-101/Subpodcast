/**
 * [INPUT]: api.addSubscription / youtubeSubscriptions；store.shows
 * [OUTPUT]: ImportPanel — 浏览器 YouTube + OPML/Takeout/NewPipe/FreeTube 文件导入
 * [POS]: AddDialog「导入订阅」Tab；解析在前端，订阅走 Rust
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState } from "react";
import { Check, FileUp, Loader2, Youtube } from "lucide-react";
import { api, errText } from "../lib/api";
import { sameFeed } from "../lib/feeds";
import { useT } from "../lib/i18n";
import { useStore } from "../store";
import { BrowserAccess, browserName } from "./BrowserAccess";

export interface ImportItem {
  input: string;
  title: string;
  thumb?: string;
  source: "youtube" | "opml" | "csv" | "newpipe" | "freetube";
}

const ytChannel = (id: string) => `https://www.youtube.com/channel/${id}`;
const IS_MAC = navigator.platform.toUpperCase().includes("MAC");

/** 解析 OPML / Takeout CSV / NewPipe / FreeTube 导出。 */
export function parseImport(name: string, text: string): ImportItem[] {
  const out: ImportItem[] = [];
  const push = (x: ImportItem) => {
    if (x.input && !out.some((o) => o.input === x.input)) out.push(x);
  };
  const trimmed = text.trim();
  if (trimmed.startsWith("<")) {
    const doc = new DOMParser().parseFromString(trimmed, "text/xml");
    doc.querySelectorAll("outline[xmlUrl], outline[xmlurl]").forEach((o) => {
      const url = o.getAttribute("xmlUrl") ?? o.getAttribute("xmlurl") ?? "";
      const id = url.match(/channel_id=(UC[\w-]{22})/)?.[1];
      push({
        input: id ? ytChannel(id) : url,
        title: o.getAttribute("title") || o.getAttribute("text") || url,
        source: "opml",
      });
    });
    return out;
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const v = JSON.parse(trimmed) as Record<string, unknown> | unknown[];
      const root = v as { subscriptions?: { url?: string; name?: string }[]; profiles?: unknown[] };
      for (const s of root?.subscriptions ?? []) {
        if (typeof s?.url === "string") push({ input: s.url, title: s.name ?? s.url, source: "newpipe" });
      }
      const profiles = Array.isArray(v) ? v : root?.profiles ?? [];
      for (const p of profiles as {
        subscriptions?: { id?: string; name?: string; thumbnail?: string }[];
        snippet?: { resourceId?: { channelId?: string }; title?: string };
      }[]) {
        for (const s of p?.subscriptions ?? []) {
          if (typeof s?.id === "string")
            push({ input: ytChannel(s.id), title: s.name ?? s.id, thumb: s.thumbnail, source: "freetube" });
        }
        const c = p?.snippet?.resourceId?.channelId;
        if (c) push({ input: ytChannel(c), title: p.snippet?.title ?? c, source: "csv" });
      }
    } catch {
      /* not JSON */
    }
    return out;
  }
  if (/\.db$/i.test(name)) {
    for (const line of trimmed.split("\n")) {
      try {
        for (const s of (JSON.parse(line) as { subscriptions?: { id?: string; name?: string }[] }).subscriptions ?? []) {
          if (s?.id) push({ input: ytChannel(s.id), title: s.name ?? s.id, source: "freetube" });
        }
      } catch {
        /* skip */
      }
    }
    if (out.length) return out;
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const id = line.match(/^(UC[\w-]{22})\s*,/)?.[1];
    if (id) {
      const cols = line.split(",");
      push({ input: ytChannel(id), title: cols.slice(2).join(",").trim() || id, source: "csv" });
    }
  }
  return out;
}

type Browser = "chrome" | "safari" | "edge" | "firefox" | "brave";
const BROWSERS: [Browser, string][] = IS_MAC
  ? [
      ["chrome", "Chrome"],
      ["safari", "Safari"],
      ["edge", "Edge"],
      ["firefox", "Firefox"],
      ["brave", "Brave"],
    ]
  : [
      ["chrome", "Chrome"],
      ["edge", "Edge"],
      ["firefox", "Firefox"],
      ["brave", "Brave"],
    ];

const needsBrowserAccess = (msg: string) => msg.includes("需要你允许");

export function ImportPanel({ onDone }: { onDone?: () => void }) {
  const t = useT();
  const shows = useStore((s) => s.shows);
  const [items, setItems] = useState<ImportItem[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Browser | "file" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; failed: number } | null>(null);
  const [browser, setBrowser] = useState<Browser>("chrome");
  const fileInput = useRef<HTMLInputElement>(null);

  const has = (input: string) =>
    shows.some(
      (s) =>
        sameFeed(s.feedUrl, input) ||
        (input.includes("/channel/") && s.feedUrl.includes(input.split("/channel/")[1]?.slice(0, 24) ?? "")),
    );

  const offer = (list: ImportItem[]) => {
    setItems(list);
    setPicked(new Set(list.filter((x) => !has(x.input)).map((x) => x.input)));
    if (!list.length) setError(t("文件里没有找到订阅"));
  };

  const fromBrowser = async () => {
    setBusy(browser);
    setError(null);
    setDenied(false);
    setItems(null);
    try {
      const ch = await api.youtubeSubscriptions(browser);
      offer(ch.map((c) => ({ input: ytChannel(c.id), title: c.title, thumb: c.thumbnail, source: "youtube" })));
    } catch (e) {
      const msg = errText(e);
      if (needsBrowserAccess(msg)) setDenied(true);
      else setError(msg);
    } finally {
      setBusy(null);
    }
  };

  const fromFile = async (f: File) => {
    setBusy("file");
    setError(null);
    setItems(null);
    try {
      offer(parseImport(f.name, await f.text()));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const go = async () => {
    const list = (items ?? []).filter((x) => picked.has(x.input));
    let done = 0;
    let failed = 0;
    setProgress({ done, total: list.length, failed });
    const queue = [...list];
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        for (let x = queue.shift(); x; x = queue.shift()) {
          try {
            await api.addSubscription(x.input);
          } catch {
            failed++;
          }
          done++;
          setProgress({ done, total: list.length, failed });
        }
      }),
    );
    await useStore.getState().reloadShows();
    useStore
      .getState()
      .notify(
        failed
          ? t("已导入 {ok} 个，{failed} 个没有成功", { ok: done - failed, failed })
          : t("已导入 {n} 个订阅", { n: done }),
      );
    setProgress(null);
    setItems(null);
    onDone?.();
  };

  useEffect(() => {
    setError(null);
    setDenied(false);
  }, [browser]);

  if (items?.length) {
    const fresh = items.filter((x) => !has(x.input));
    return (
      <div className="import">
        <div className="import-list-head">
          <p className="small">
            {t("找到 {total} 个，其中 {fresh} 个还没订阅", { total: items.length, fresh: fresh.length })}
          </p>
          <button
            className="link-btn small"
            onClick={() =>
              setPicked(picked.size === fresh.length ? new Set() : new Set(fresh.map((x) => x.input)))
            }
          >
            {picked.size === fresh.length ? t("全不选") : t("全选")}
          </button>
        </div>
        <div className="import-list">
          {items.map((x) => {
            const done = has(x.input);
            return (
              <label key={x.input} className={`import-row ${done ? "done" : ""}`}>
                <input
                  type="checkbox"
                  disabled={done || progress != null}
                  checked={done || picked.has(x.input)}
                  onChange={(e) => {
                    const n = new Set(picked);
                    if (e.target.checked) n.add(x.input);
                    else n.delete(x.input);
                    setPicked(n);
                  }}
                />
                {x.thumb ? <img src={x.thumb} alt="" loading="lazy" /> : <span className="import-ph">{x.title.slice(0, 1)}</span>}
                <span className="clamp1">{x.title}</span>
                {done && (
                  <span className="sub-done">
                    <Check size={12} /> {t("已订阅")}
                  </span>
                )}
              </label>
            );
          })}
        </div>
        <div className="modal-foot">
          {progress && (
            <span className="small muted">
              <Loader2 size={13} className="spin" /> {t("正在订阅 {done} / {total}", { done: progress.done, total: progress.total })}
            </span>
          )}
          <div className="spacer" />
          <button className="btn ghost" onClick={() => setItems(null)} disabled={progress != null}>
            {t("返回")}
          </button>
          <button className="btn primary" onClick={() => void go()} disabled={!picked.size || progress != null}>
            {t("订阅 {n} 个", { n: picked.size })}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="import">
      <div className="import-card">
        <div className="import-card-head">
          <span className="import-icon yt">
            <Youtube size={18} />
          </span>
          <div>
            <p className="import-title">{t("YouTube 订阅")}</p>
            <p className="muted small">{t("读取你在浏览器里登录的 YouTube，一次导入所有订阅的频道。")}</p>
          </div>
        </div>
        <div className="import-row-actions">
          <select value={browser} onChange={(e) => setBrowser(e.target.value as Browser)} aria-label={t("浏览器")}>
            {BROWSERS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <button className="btn primary sm" onClick={() => void fromBrowser()} disabled={busy != null}>
            {busy === browser ? (
              <>
                <Loader2 size={13} className="spin" /> {t("正在读取…")}
              </>
            ) : (
              t("从浏览器导入")
            )}
          </button>
        </div>
        <p className="muted small import-note">
          {browser === "safari"
            ? t("Safari 需要先在 系统设置 › 隐私与安全性 › 完全磁盘访问权限 里允许声译。")
            : IS_MAC
              ? t("系统会问是否允许声译读取 {browser} 的数据，选「允许」。", { browser: browserName(browser) })
              : ""}
          {t("登录信息只在本机读取，读完就删除，不会上传。")}
        </p>
        {denied && <BrowserAccess browser={browser} onRetry={() => void fromBrowser()} />}
      </div>
      <div className="import-card">
        <div className="import-card-head">
          <span className="import-icon">
            <FileUp size={18} />
          </span>
          <div>
            <p className="import-title">{t("小宇宙和其他播客 App")}</p>
            <p className="muted small">
              {t("导入订阅文件：OPML（小宇宙、Pocket Casts、Overcast 等），或 Google Takeout、NewPipe、FreeTube 的导出。")}
            </p>
          </div>
        </div>
        <div className="import-row-actions">
          <button className="btn sm" onClick={() => fileInput.current?.click()} disabled={busy != null}>
            {busy === "file" ? <Loader2 size={13} className="spin" /> : null} {t("选择文件")}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".opml,.xml,.csv,.json,.db,.txt"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void fromFile(f);
              e.target.value = "";
            }}
          />
        </div>
        <details className="import-how small">
          <summary>{t("小宇宙怎么导出？")}</summary>
          <ol>
            <li>{t("打开小宇宙 App，进入「我的」→「订阅」")}</li>
            <li>{t("点右上角的分享按钮，选「导出 OPML」")}</li>
            <li>{t("把文件存到电脑上，在这里选择它")}</li>
          </ol>
        </details>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
