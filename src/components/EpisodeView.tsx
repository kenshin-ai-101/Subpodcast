/**
 * [INPUT]: api.getEpisode、PlayerBar、Transcript/Chat
 * [OUTPUT]: 单集页左媒体 + 右 Tab 栏（对齐 SubCast EpisodeBody）
 * [POS]: MVP 主战场
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Captions, ChevronDown, MessageCircle, PanelRightClose, PanelRightOpen } from "lucide-react";
import { api, type Episode } from "../lib/api";
import { date, duration } from "../lib/format";
import { useStore } from "../store";
import { ChatPane } from "./ChatPane";
import { TopBar } from "./Chrome";
import { PlayerBar } from "./PlayerBar";
import { TranscriptPane } from "./TranscriptPane";

type Tab = "transcript" | "chat";

export function EpisodeView({ episodeId }: { episodeId: string }) {
  const { current, load } = useStore(useShallow((s) => ({ current: s.current, load: s.load })));
  const [ep, setEp] = useState<Episode | null>(current?.id === episodeId ? current : null);
  const [tab, setTab] = useState<Tab>("transcript");
  const [panelOpen, setPanelOpen] = useState(true);
  const [notesOpen, setNotesOpen] = useState(false);

  useEffect(() => {
    void api.getEpisode(episodeId).then((e) => {
      if (!e) return;
      setEp(e);
      // MVP：打开单集即载入播放器，保证左栏媒体与右侧字幕同一集
      load(e);
    });
  }, [episodeId, load]);

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

  return (
    <div className="episode">
      <div className={`ep-body ${panelOpen ? "" : "panel-collapsed"}`}>
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
                <button className="round-btn" title="显示字幕栏" onClick={() => setPanelOpen(true)}>
                  <PanelRightOpen size={15} />
                </button>
              )}
            </div>
            <PlayerBar />
            {ep.notes && (
              <div className={`notes ${notesOpen ? "open" : ""}`}>
                <div className="notes-head" role="button" tabIndex={0} onClick={() => setNotesOpen(!notesOpen)}>
                  <span>本集简介</span>
                  <span className="spacer" />
                  <ChevronDown size={14} style={{ transform: notesOpen ? "rotate(180deg)" : undefined }} />
                </div>
                {notesOpen && <div className="notes-body">{ep.notes.replace(/<[^>]+>/g, "")}</div>}
              </div>
            )}
          </section>
        </div>
        {panelOpen && (
          <section className="ep-right">
            <div className="tabs" role="tablist" data-tauri-drag-region>
              <button
                role="tab"
                className={tab === "transcript" ? "on" : ""}
                aria-selected={tab === "transcript"}
                onClick={() => setTab("transcript")}
              >
                <Captions size={15} />
                <span>字幕</span>
              </button>
              <button
                role="tab"
                className={tab === "chat" ? "on" : ""}
                aria-selected={tab === "chat"}
                onClick={() => setTab("chat")}
              >
                <MessageCircle size={15} />
                <span>问答</span>
              </button>
              <span className="spacer" data-tauri-drag-region />
              <button className="icon-btn tabs-close" title="收起字幕栏" onClick={() => setPanelOpen(false)}>
                <PanelRightClose size={16} />
              </button>
            </div>
            <div className="tab-body">
              {tab === "transcript" && <TranscriptPane episode={ep} />}
              {tab === "chat" && <ChatPane episode={ep} />}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
