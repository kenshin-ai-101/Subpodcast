/**
 * [INPUT]: api、jobs、library、offline、showLinks、layout（panel / transcriptBelow）、Splitter、PlayerBar、右栏 Tab
 * [OUTPUT]: 单集页：标题动作（更多菜单收纳收藏/外开）+ 开集字幕瀑布 + 音视频切换；transcriptBelow 时字幕在播放器下，右栏保留精读/导读/问答
 * [POS]: openEpisode 只导航；别人在播时本页不抢 load；PlayerBar 绑页内 ep，点播放再接管
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  ArrowDownToLine,
  BookOpen,
  Bookmark,
  Captions,
  ChevronDown,
  ExternalLink,
  MessageCircle,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  ScrollText,
  Trash2,
  Youtube,
} from "lucide-react";
import { openExternalUrl } from "../lib/safeUrl";
import { api, type Episode } from "../lib/api";
import { ask } from "../lib/confirm";
import { date, duration, parseClock, plainText } from "../lib/format";
import { tNow, useT } from "../lib/i18n";
import { autoTranslate, ensureTranscript, useJobs } from "../lib/jobs";
import { PANEL, useLayout } from "../lib/layout";
import { toggleFavorite, useLibrary } from "../lib/library";
import {
  bytes,
  cancelDownload,
  downloadEpisode,
  loadDownloads,
  removeDownload,
  useOffline,
} from "../lib/offline";
import { mayHaveYoutubeTwin, showLinks } from "../lib/showLinks";
import { useStore } from "../store";
import { ChatPane } from "./ChatPane";
import { TopBar } from "./Chrome";
import { DeepRead } from "./DeepRead";
import { PlayerBar } from "./PlayerBar";
import { YtVideoStrip, usePromo } from "./PromoBanner";
import { Splitter } from "./Splitter";
import { SummaryPane } from "./SummaryPane";
import { TranscriptPane } from "./TranscriptPane";

type Tab = "transcript" | "deep" | "summary" | "chat";

/** 简介章节时间（`00:00 开场`）→ 跳转按钮；链接外开浏览器。 */
function withStamps(text: string, seek: (sec: number) => void): ReactNode[] {
  return text.split(/(https?:\/\/[^\s<>"'）)】]+|\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b)/g).map((part, i) => {
    if (i % 2 === 0) return part;
    if (/^https?:/.test(part)) {
      const label = part.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60);
      return (
        <a
          key={i}
          href={part}
          className="notes-link"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void openExternalUrl(part);
          }}
        >
          {label}
        </a>
      );
    }
    const sec = parseClock(part);
    if (sec == null) return part;
    return (
      <button
        key={i}
        type="button"
        className="stamp"
        title={tNow("跳到这里播放")}
        onClick={(e) => {
          e.stopPropagation();
          seek(sec);
        }}
      >
        {part}
      </button>
    );
  });
}

function seekNotes(ep: Episode, sec: number) {
  const s = useStore.getState();
  if (s.current?.id === ep.id) {
    if (s.player) s.player.seek(sec);
    else s.set({ time: sec });
    return;
  }
  s.load({ ...ep, progress: sec });
}

/** 标题行溢出动作：收藏 / 外开 YouTube 或网页，避免挤占主操作。 */
function EpisodeMoreMenu({
  ep,
  isCurrent,
  fav,
}: {
  ep: Episode;
  isCurrent: boolean;
  fav: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);

  const openExternal = () => {
    setOpen(false);
    if (ep.videoId) {
      const st = useStore.getState();
      const s = Math.floor(isCurrent ? st.time : ep.progress ?? 0);
      void openExternalUrl(`https://www.youtube.com/watch?v=${ep.videoId}${s > 5 ? `&t=${s}s` : ""}`);
    } else if (ep.link) {
      void openExternalUrl(ep.link);
    }
  };

  return (
    <div className="menu-wrap" ref={box}>
      <button
        type="button"
        className="round-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("更多")}
        aria-label={t("更多")}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal size={15} />
      </button>
      {open && (
        <div className="menu right" role="menu">
          <button
            type="button"
            role="menuitem"
            className={fav ? "on" : undefined}
            onClick={() => {
              setOpen(false);
              toggleFavorite(ep);
            }}
          >
            <Bookmark size={14} fill={fav ? "currentColor" : "none"} />
            {fav ? t("取消收藏") : t("收藏这一集")}
          </button>
          {(ep.videoId || ep.link) && (
            <button type="button" role="menuitem" onClick={openExternal}>
              {ep.videoId ? <Youtube size={14} /> : <ExternalLink size={14} />}
              {ep.videoId ? t("在 YouTube 打开（从当前位置继续）") : t("节目网页")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DownloadButton({ ep }: { ep: Episode }) {
  const t = useT();
  const saved = useOffline((s) => s.saved[ep.id]);
  const progress = useOffline((s) => s.progress[ep.id]);
  const [menu, setMenu] = useState(false);

  if (progress !== undefined) {
    const pct = progress == null ? null : Math.round(progress * 100);
    return (
      <button
        type="button"
        className="round-btn dl-busy"
        title={pct == null ? t("正在下载，点一下取消") : t("已下载 {pct}%，点一下取消", { pct })}
        onClick={() => cancelDownload(ep.id)}
      >
        <ArrowDownToLine size={15} className="spin" />
      </button>
    );
  }

  if (saved) {
    return (
      <div className="menu-wrap">
        <button
          type="button"
          className="round-btn dl-done"
          title={`${t("已下载")} · ${bytes(saved.bytes)}`}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          <ArrowDownToLine size={15} />
        </button>
        {menu && (
          <div className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
            <p className="menu-note">{t("已下载")} · {bytes(saved.bytes)}</p>
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => {
                setMenu(false);
                void ask({
                  message: t("删除这一集已下载的音频？之后在线播放，字幕和进度都会保留。"),
                  danger: true,
                  ok: t("删除下载"),
                }).then((yes) => {
                  if (yes) void removeDownload(ep.id);
                });
              }}
            >
              <Trash2 size={14} /> {t("删除下载")}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="round-btn"
      title={ep.audioUrl || ep.videoId ? t("下载，离线也能听") : t("没有可下载的音频")}
      disabled={!ep.audioUrl && !ep.videoId}
      onClick={() => void downloadEpisode(ep)}
    >
      <ArrowDownToLine size={15} />
    </button>
  );
}

export function EpisodeView({ episodeId }: { episodeId: string }) {
  const t = useT();
  const { current, load, shows } = useStore(
    useShallow((s) => ({ current: s.current, load: s.load, shows: s.shows })),
  );
  const fav = useLibrary((s) => s.favorites.some((f) => f.id === episodeId));
  const ytPromo = usePromo();
  const { panel, panelOpen, below, put: putLayout } = useLayout(
    useShallow((l) => ({
      panel: l.panel,
      panelOpen: l.panelOpen,
      below: l.transcriptBelow,
      put: l.put,
    })),
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyW, setBodyW] = useState(0);
  const [ep, setEp] = useState<Episode | null>(current?.id === episodeId ? current : null);
  const [tab, setTab] = useState<Tab>("transcript");
  const [notesOpen, setNotesOpen] = useState(true);
  const [noDeep, setNoDeep] = useState<string | null>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setBodyW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    void loadDownloads();
  }, []);

  useEffect(() => {
    setNoDeep(null);
    const cur = useStore.getState().current;
    setEp(cur?.id === episodeId ? cur : null);
    let cancelled = false;
    let transcriptTimer = 0;
    void (async () => {
      // 先用本地单集起播；乔木详情 / YouTube 双形态配对放到后面，不堵第一声
      let e = await api.getEpisode(episodeId);
      if (!e || cancelled) return;
      setEp(e);
      // 别人正在播时只看页，不抢播放器
      const maybeLoad = (x: Episode) => {
        const st = useStore.getState();
        if (st.current?.id === x.id || !st.playing) load(x);
      };
      maybeLoad(e);
      if (e.deep) setTab((t) => (t === "transcript" ? "deep" : t));

      if (e.transcriptType === "qiaomu" && !e.audioUrl) {
        try {
          await api.qiaomuDetail(e.id);
          e = (await api.getEpisode(episodeId)) ?? e;
          if (!cancelled) {
            setEp(e);
            maybeLoad(e);
          }
        } catch {
          /* 仍可播视频 */
        }
      }
      // 音频 RSS 常缺 videoId：后台刷一次配对，只补切换能力，不打断当前音轨
      if (!cancelled && !e.videoId) {
        const show = useStore.getState().shows.find((s) => s.id === e!.showId);
        if (show && mayHaveYoutubeTwin(show.feedUrl, show.title)) {
          try {
            await api.refreshShow(show.id);
            e = (await api.getEpisode(episodeId)) ?? e;
            if (!cancelled) {
              setEp(e);
              maybeLoad(e);
            }
          } catch {
            /* 网络失败仍可听音频 */
          }
        }
      }
      if (cancelled) return;
      // 字幕瀑布下一宏任务，让出起播帧
      transcriptTimer = window.setTimeout(() => {
        if (cancelled) return;
        void ensureTranscript(e).then(async () => {
          const fresh = await api.getEpisode(episodeId).catch(() => null);
          if (cancelled) return;
          if (fresh && (fresh.videoId !== e.videoId || fresh.hasTranscript !== e.hasTranscript)) {
            setEp(fresh);
            maybeLoad(fresh);
            autoTranslate(fresh);
          } else {
            autoTranslate(e);
          }
        });
      }, 0);
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(transcriptTimer);
    };
  }, [episodeId, load]);

  const transcript = useJobs((s) => (ep ? s.transcripts[ep.id] : undefined));
  const subtitleMode = useStore((s) => s.settings.subtitleMode);
  useEffect(() => {
    if (ep && transcript) autoTranslate(ep);
  }, [ep?.id, transcript?.episodeId, transcript?.segments.length, subtitleMode]);

  const onMissingDeep = useCallback(() => {
    setNoDeep(episodeId);
    setTab("transcript");
  }, [episodeId]);

  if (!ep) {
    return (
      <div className="episode">
        <div className="ep-leftcol">
          <TopBar />
          <div className="ep-left muted">{t("加载中…")}</div>
        </div>
      </div>
    );
  }

  const notes = plainText(ep.notes);
  const showDeep = !!ep.deep && noDeep !== ep.id;
  // 字幕在播放器下方时，右栏只保留精读/导读/问答，并打开其中第一项
  const shownTab: Tab = below && tab === "transcript" ? (showDeep ? "deep" : "summary") : tab;
  const epShow = shows.find((x) => x.id === ep.showId);
  const ytChannel = showLinks(epShow?.feedUrl).youtube;
  const isCurrent = current?.id === ep.id;
  // 与 CSS --panel-eff 一致：拖条用可视宽度，避免存宽 > 可用时「空拖」再突然收起
  const panelMax = Math.min(PANEL.max, Math.max(PANEL.min, (bodyW || PANEL.max + 460) - 460));
  const panelVis = Math.min(panel, panelMax);

  return (
    <div className="episode">
      <div
        ref={bodyRef}
        className={`ep-body ${panelOpen ? "" : "panel-collapsed"}`}
        style={{ "--panel-w": `${panelOpen ? panelVis : 0}px` } as CSSProperties}
      >
        <div className="ep-leftcol">
          <TopBar />
          <section className="ep-left">
            <div className="ep-title-block">
              <div className="ep-title">
                <p className="meta-line">
                  {[ep.showTitle, date(ep.published), duration(ep.duration)].filter(Boolean).join(" · ")}
                </p>
                <h1>{ep.title}</h1>
              </div>
              {!panelOpen && (
                <button
                  type="button"
                  className="round-btn"
                  title={t("显示字幕栏")}
                  onClick={() => putLayout({ panelOpen: true })}
                >
                  <PanelRightOpen size={15} />
                </button>
              )}
              <DownloadButton ep={ep} />
              <EpisodeMoreMenu ep={ep} isCurrent={isCurrent} fav={fav} />
            </div>

            <PlayerBar episode={ep} />

            {below && (
              <section className="ep-transcript" aria-label={t("字幕")}>
                <TranscriptPane episode={ep} />
              </section>
            )}

            {ytPromo && ytChannel && (
              <YtVideoStrip
                channel={ytChannel}
                name={epShow?.title ?? ep.showTitle ?? t("频道")}
                cover={epShow?.cover ?? ep.cover}
              />
            )}

            {notes && (
              <div className={`notes ${notesOpen ? "open" : ""}`}>
                <div
                  className="notes-head"
                  role="button"
                  tabIndex={0}
                  onClick={() => setNotesOpen(!notesOpen)}
                  onKeyDown={(e) => e.key === "Enter" && setNotesOpen(!notesOpen)}
                >
                  <span>{t("本集简介")}</span>
                  <span className="spacer" />
                  <ChevronDown size={14} style={{ transform: notesOpen ? "rotate(180deg)" : undefined }} />
                </div>
                {notesOpen && (
                  <div className="notes-body">
                    {notes
                      .split(/\n{2,}/)
                      .map((p) => p.trim())
                      .filter(Boolean)
                      .map((p, i) => (
                        <p key={i}>{withStamps(p, (sec) => seekNotes(ep, sec))}</p>
                      ))}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
        {panelOpen && (
          <Splitter
            value={panelVis}
            min={PANEL.min}
            max={panelMax}
            def={Math.min(PANEL.def, panelMax)}
            snap={PANEL.min}
            edge="left"
            label={t("字幕栏宽度")}
            onChange={(w) => putLayout({ panel: w, panelOpen: true })}
            /* 右栏拖窄只贴最小宽，不整栏消失；收起靠 Tab 关闭 / ⌘\ */
            onCollapse={() => putLayout({ panel: PANEL.min, panelOpen: true })}
          />
        )}
        {panelOpen && (
          <section className="ep-right">
            <div className="tabs" role="tablist" data-tauri-drag-region>
              {!below && (
                <button
                  role="tab"
                  className={shownTab === "transcript" ? "on" : ""}
                  aria-selected={shownTab === "transcript"}
                  title={t("字幕")}
                  onClick={() => setTab("transcript")}
                >
                  <Captions size={15} />
                  <span>{t("字幕")}</span>
                </button>
              )}
              {showDeep && (
                <button
                  role="tab"
                  className={shownTab === "deep" ? "on" : ""}
                  aria-selected={shownTab === "deep"}
                  title={t("精读")}
                  onClick={() => setTab("deep")}
                >
                  <BookOpen size={15} />
                  <span>{t("精读")}</span>
                </button>
              )}
              <button
                role="tab"
                className={shownTab === "summary" ? "on" : ""}
                aria-selected={shownTab === "summary"}
                title={t("导读")}
                onClick={() => setTab("summary")}
              >
                <ScrollText size={15} />
                <span>{t("导读")}</span>
              </button>
              <button
                role="tab"
                className={shownTab === "chat" ? "on" : ""}
                aria-selected={shownTab === "chat"}
                title={t("问答")}
                onClick={() => setTab("chat")}
              >
                <MessageCircle size={15} />
                <span>{t("问答")}</span>
              </button>
              <span className="spacer" data-tauri-drag-region />
              <button
                type="button"
                className="icon-btn tabs-close"
                title={t("收起字幕栏")}
                onClick={() => putLayout({ panelOpen: false })}
              >
                <PanelRightClose size={16} />
              </button>
            </div>
            <div className="tab-body">
              {shownTab === "transcript" && <TranscriptPane episode={ep} />}
              {shownTab === "deep" && (
                <DeepRead ep={ep} onMissing={onMissingDeep}>
                  <div className="panel-empty">
                    <p className="lead">{t("这一集还没有精读")}</p>
                    <p className="muted">{t("这期没有精读长文，字幕和 AI 导读依然可以帮你。")}</p>
                  </div>
                </DeepRead>
              )}
              {shownTab === "summary" && <SummaryPane episode={ep} />}
              {shownTab === "chat" && <ChatPane episode={ep} />}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
