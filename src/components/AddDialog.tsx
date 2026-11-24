/**
 * [INPUT]: store、api、ImportPanel、looksLikeLink
 * [OUTPUT]: 添加节目对话框（搜索节目 / 链接或 RSS / 导入订阅）
 * [POS]: 订阅入口；三 Tab 与 SubCast 信息架构对齐
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Import, Link2, Loader2, Plus, Search, X } from "lucide-react";
import { api, errText, type Show } from "../lib/api";
import { looksLikeLink } from "../lib/feeds";
import { useT } from "../lib/i18n";
import { useStore } from "../store";
import { ImportPanel } from "./ImportPanel";

export function AddDialog() {
  const t = useT();
  const { addOpen, addTab, set, reloadShows, notify, go, shows } = useStore(
    useShallow((s) => ({
      addOpen: s.addOpen,
      addTab: s.addTab,
      set: s.set,
      reloadShows: s.reloadShows,
      notify: s.notify,
      go: s.go,
      shows: s.shows,
    })),
  );
  const [tab, setTab] = useState<"search" | "link" | "import">(addTab);
  const [q, setQ] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<Show[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (addOpen) setTab(addTab);
  }, [addOpen, addTab]);

  const close = () => set({ addOpen: false });
  const pastedLink = looksLikeLink(q);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!q.trim() || pastedLink) {
      setResults(null);
      return;
    }
    timer.current = window.setTimeout(async () => {
      setSearching(true);
      try {
        const country = /[\u4e00-\u9fff]/.test(q) ? "CN" : "US";
        setResults((await api.searchPodcasts(q.trim(), country)).slice(0, 12));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  }, [q, pastedLink]);

  useEffect(() => {
    if (!addOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addOpen]);

  if (!addOpen) return null;

  const add = async (value: string) => {
    setError(null);
    setAdding(value);
    setBusy(true);
    try {
      const show = await api.addSubscription(value);
      close();
      await reloadShows();
      notify(t("已订阅「{title}」", { title: show.title }));
      go({ kind: "show", id: show.id });
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
      setAdding(null);
    }
  };

  const switchTab = (next: "search" | "link" | "import") => {
    setTab(next);
    set({ addTab: next });
    setError(null);
  };

  const head = (
    <div className="add-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={tab === "search"}
        className={tab === "search" ? "on" : ""}
        onClick={() => switchTab("search")}
      >
        <Search size={15} /> {t("搜索节目")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === "link"}
        className={tab === "link" ? "on" : ""}
        onClick={() => switchTab("link")}
      >
        <Link2 size={15} /> {t("链接或 RSS")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === "import"}
        className={tab === "import" ? "on" : ""}
        onClick={() => switchTab("import")}
      >
        <Import size={15} /> {t("导入订阅")}
      </button>
    </div>
  );

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={t("添加节目")}>
        <div className="modal-head">
          {head}
          <button className="icon-btn" onClick={close} aria-label={t("关闭")}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          {tab === "import" ? (
            <ImportPanel onDone={close} />
          ) : tab === "search" ? (
            <form
              className="add-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (pastedLink) void add(q.trim());
                else if (results?.[0] && !shows.some((s) => s.feedUrl === results[0].feedUrl))
                  void add(results[0].feedUrl);
              }}
            >
              <div className="add-search">
                {pastedLink ? <Link2 size={16} /> : <Search size={16} />}
                <input
                  autoFocus
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t("输入节目名，比如 Lex Fridman、张小珺")}
                />
                {(searching || busy) && <Loader2 size={14} className="spin muted" />}
              </div>
              {error && <p className="error-text">{error}</p>}
              <div className="add-results">
                {pastedLink ? (
                  <div className="add-empty">
                    <p className="muted small">{t("这是一个链接，回车直接添加")}</p>
                    <button type="submit" className="btn primary sm" disabled={busy}>
                      {t("添加")}
                    </button>
                  </div>
                ) : !q.trim() ? (
                  <div className="add-empty">
                    <p className="muted small">
                      {t("搜索 Apple Podcasts 上的节目，中英文名都可以。YouTube 频道或小宇宙请用「链接或 RSS」。")}
                    </p>
                  </div>
                ) : results && !results.length ? (
                  <div className="add-empty">
                    <p className="muted small">{t("没有找到，换个关键词，或者用「链接或 RSS」添加")}</p>
                  </div>
                ) : (
                  results?.map((r) => {
                    const done = shows.some((s) => s.feedUrl === r.feedUrl);
                    return (
                      <div key={r.feedUrl} className="drop-row">
                        {r.cover ? (
                          <img src={r.cover} alt="" />
                        ) : (
                          <div className="cover-fallback">{r.title.slice(0, 1)}</div>
                        )}
                        <div className="drop-meta">
                          <p className="ep-name clamp1">{r.title}</p>
                          <p className="meta-line clamp1">{r.author}</p>
                        </div>
                        {done ? (
                          <span className="sub-done">{t("已订阅")}</span>
                        ) : (
                          <button
                            type="button"
                            className="btn sm"
                            onClick={() => void add(r.feedUrl)}
                            disabled={adding != null}
                          >
                            {adding === r.feedUrl ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}{" "}
                            {t("订阅")}
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </form>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (input.trim()) void add(input.trim());
              }}
              className="add-form"
            >
              <input
                autoFocus
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={t("粘贴 YouTube / Apple Podcasts / 小宇宙 / RSS 链接")}
              />
              {error && <p className="error-text">{error}</p>}
              <ul className="hints muted small">
                <li>
                  <b>YouTube</b> {t("频道（@名字 / 频道链接 / 播放列表），或单个视频链接")}
                </li>
                <li>
                  <b>Apple Podcasts</b> {t("节目链接")}
                </li>
                <li>
                  <b>{t("小宇宙")}</b> {t("节目或单集链接")}
                </li>
                <li>
                  {t("任意播客")} <b>RSS</b> {t("地址")}
                </li>
              </ul>
              <div className="modal-foot">
                <div className="spacer" />
                <button type="button" className="btn ghost" onClick={close}>
                  {t("取消")}
                </button>
                <button type="submit" className="btn primary" disabled={busy || !input.trim()}>
                  {busy ? (
                    <>
                      <Loader2 size={14} className="spin" /> {t("正在读取…")}
                    </>
                  ) : (
                    t("添加")
                  )}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
