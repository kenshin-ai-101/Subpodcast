/**
 * [INPUT]: api、jobs、library、offline、showLinks、layout（panel）、Splitter、PlayerBar、右四 Tab
 * [OUTPUT]: 单集页：标题动作 + 开集字幕瀑布 + 音视频切换 + 右栏拖宽/收起
 * [POS]: 打开即拉官方字幕并自动译中文；右栏宽度与 panelOpen 走 layout
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
  PanelRightClose,
  PanelRightOpen,
  ScrollText,
  Trash2,
  Youtube,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type Episode } from "../lib/api";
import { ask } from "../lib/confirm";
import { date, duration, parseClock, plainText } from "../lib/format";
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
            void openUrl(part);
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
        title="跳到这里播放"
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

function DownloadButton({ ep }: { ep: Episode }) {
  const saved = useOffline((s) => s.saved[ep.id]);
  const progress = useOffline((s) => s.progress[ep.id]);
  const [menu, setMenu] = useState(false);

  if (progress !== undefined) {
    const pct = progress == null ? null : Math.round(progress * 100);
    return (
      <button
        type="button"
        className="round-btn dl-busy"
        title={pct == null ? "正在下载，点一下取消" : `已下载 ${pct}%，点一下取消`}
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
          title={`已下载 · ${bytes(saved.bytes)}`}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          <ArrowDownToLine size={15} />
        </button>
        {menu && (
          <div className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
            <p className="menu-note">已下载 · {bytes(saved.bytes)}</p>
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => {
                setMenu(false);
                void ask("删除这一集已下载的音频？之后在线播放，字幕和进度都会保留。").then((yes) => {
                  if (yes) void removeDownload(ep.id);
                });
              }}
            >
              <Trash2 size={14} /> 删除下载
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
      title={ep.audioUrl || ep.videoId ? "下载，离线也能听" : "没有可下载的音频"}
      disabled={!ep.audioUrl && !ep.videoId}
      onClick={() => void downloadEpisode(ep)}
    >
      <ArrowDownToLine size={15} />
    </button>
  );
}

export function EpisodeView({ episodeId }: { episodeId: string }) {
  const { current, load, shows, time } = useStore(
    useShallow((s) => ({ current: s.current, load: s.load, shows: s.shows, time: s.time })),
  );
  const fav = useLibrary((s) => s.favorites.some((f) => f.id === episodeId));
  const ytPromo = usePromo();
  const { panel, panelOpen, put: putLayout } = useLayout(
    useShallow((l) => ({ panel: l.panel, panelOpen: l.panelOpen, put: l.put })),
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
    void (async () => {
      let e = await api.getEpisode(episodeId);
      if (!e) return;
      if (e.transcriptType === "qiaomu" && !e.audioUrl) {
        try {
          await api.qiaomuDetail(e.id);
          e = (await api.getEpisode(episodeId)) ?? e;
        } catch {
          /* 仍可播视频 */
        }
      }
      // 音频 RSS 常缺 videoId：双形态节目刷一次，按标题配对后才出现「视频/仅音频」
      if (!e.videoId) {
        const show = useStore.getState().shows.find((s) => s.id === e!.showId);
        if (show && mayHaveYoutubeTwin(show.feedUrl, show.title)) {
          try {
            await api.refreshShow(show.id);
            e = (await api.getEpisode(episodeId)) ?? e;
          } catch {
            /* 网络失败仍可听音频 */
          }
        }
      }
      setEp(e);
      load(e);
      void ensureTranscript(e).then(async () => {
        // 官方拉取可能刚补上 videoId：刷新单集，播放器才能切视频/叠字幕
        const fresh = await api.getEpisode(episodeId).catch(() => null);
        if (fresh && (fresh.videoId !== e.videoId || fresh.hasTranscript !== e.hasTranscript)) {
          setEp(fresh);
          load(fresh);
          autoTranslate(fresh);
        } else {
          autoTranslate(e);
        }
      });
      if (e.deep) setTab((t) => (t === "transcript" ? "deep" : t));
    })();
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
          <div className="ep-left muted">加载中…</div>
        </div>
      </div>
    );
  }

  const notes = plainText(ep.notes);
  const showDeep = !!ep.deep && noDeep !== ep.id;
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
                  title="显示字幕栏"
                  onClick={() => putLayout({ panelOpen: true })}
                >
                  <PanelRightOpen size={15} />
                </button>
              )}
              <button
                type="button"
                className={`round-btn fav-btn ${fav ? "on" : ""}`}
                aria-pressed={fav}
                title={fav ? "取消收藏" : "收藏这一集"}
                onClick={() => toggleFavorite(ep)}
              >
                <Bookmark size={15} fill={fav ? "currentColor" : "none"} />
              </button>
              <DownloadButton ep={ep} />
              {ep.videoId ? (
                <button
                  type="button"
                  className="round-btn yt-open"
                  title="在 YouTube 打开（从当前位置继续）"
                  onClick={() => {
                    const s = Math.floor(isCurrent ? time : ep.progress ?? 0);
                    void openUrl(`https://www.youtube.com/watch?v=${ep.videoId}${s > 5 ? `&t=${s}s` : ""}`);
                  }}
                >
                  <Youtube size={16} />
                </button>
              ) : (
                ep.link && (
                  <button type="button" className="round-btn" title="节目网页" onClick={() => void openUrl(ep.link!)}>
                    <ExternalLink size={15} />
                  </button>
                )
              )}
            </div>

            <PlayerBar />

            {ytPromo && ytChannel && (
              <YtVideoStrip
                channel={ytChannel}
                name={epShow?.title ?? ep.showTitle ?? "频道"}
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
                  <span>本集简介</span>
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
            label="字幕栏宽度"
            onChange={(w) => putLayout({ panel: w, panelOpen: true })}
            /* 右栏拖窄只贴最小宽，不整栏消失；收起靠 Tab 关闭 / ⌘\ */
            onCollapse={() => putLayout({ panel: PANEL.min, panelOpen: true })}
          />
        )}
        {panelOpen && (
          <section className="ep-right">
            <div className="tabs" role="tablist" data-tauri-drag-region>
              <button
                role="tab"
                className={tab === "transcript" ? "on" : ""}
                aria-selected={tab === "transcript"}
                title="字幕"
                onClick={() => setTab("transcript")}
              >
                <Captions size={15} />
                <span>字幕</span>
              </button>
              {showDeep && (
                <button
                  role="tab"
                  className={tab === "deep" ? "on" : ""}
                  aria-selected={tab === "deep"}
                  title="精读"
                  onClick={() => setTab("deep")}
                >
                  <BookOpen size={15} />
                  <span>精读</span>
                </button>
              )}
              <button
                role="tab"
                className={tab === "summary" ? "on" : ""}
                aria-selected={tab === "summary"}
                title="导读"
                onClick={() => setTab("summary")}
              >
                <ScrollText size={15} />
                <span>导读</span>
              </button>
              <button
                role="tab"
                className={tab === "chat" ? "on" : ""}
                aria-selected={tab === "chat"}
                title="问答"
                onClick={() => setTab("chat")}
              >
                <MessageCircle size={15} />
                <span>问答</span>
              </button>
              <span className="spacer" data-tauri-drag-region />
              <button
                type="button"
                className="icon-btn tabs-close"
                title="收起字幕栏"
                onClick={() => putLayout({ panelOpen: false })}
              >
                <PanelRightClose size={16} />
              </button>
            </div>
            <div className="tab-body">
              {tab === "transcript" && <TranscriptPane episode={ep} />}
              {tab === "deep" && (
                <DeepRead ep={ep} onMissing={onMissingDeep}>
                  <div className="panel-empty">
                    <p className="lead">这一集还没有精读</p>
                    <p className="muted">这期没有精读长文，字幕和 AI 导读依然可以帮你。</p>
                  </div>
                </DeepRead>
              )}
              {tab === "summary" && <SummaryPane episode={ep} />}
              {tab === "chat" && <ChatPane episode={ep} />}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
