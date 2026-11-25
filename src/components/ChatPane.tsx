/**
 * [INPUT]: chats.loadChat/askChat；jobs.transcript；settings.quickPrompts；ChatTools
 * [OUTPUT]: 右侧问答面板（提示词、模型切换、会话持久化、历史；编辑/删除撤销/回到底部）
 * [POS]: 理解层；会话态在 lib/chats，切 tab 不丢流
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowDown, ArrowUp, ChevronDown, Loader2, Settings2, Square, SquarePen } from "lucide-react";
import type { ChatMessage, Episode } from "../lib/api";
import {
  askChat,
  loadArchive,
  loadChat,
  saveArchive,
  saveChat,
  stopChat,
  useChats,
  type ArchivedChat,
} from "../lib/chats";
import { createManualClip, rangeFromClock } from "../lib/highlights";
import { useT } from "../lib/i18n";
import { useJobs } from "../lib/jobs";
import { seekEpisode } from "../lib/playback";
import { quickPrompts } from "../lib/settings";
import { useStore } from "../store";
import { ChatPrefsDialog, ModelPicker, PromptMenu, useFixedUpMenu } from "./ChatTools";
import { Markdown } from "./Markdown";
import { openVideoClipDialog } from "./VideoClipDialog";

const NO_MESSAGES: ChatMessage[] = [];

export function ChatPane({ episode }: { episode: Episode }) {
  const t = useT();
  const transcript = useJobs((s) => s.transcripts[episode.id]);
  const { settings, set } = useStore(
    useShallow((s) => ({ settings: s.settings, set: s.set })),
  );
  const messages = useChats((s) => s[episode.id]?.messages ?? NO_MESSAGES);
  const streaming = useChats((s) => s[episode.id]?.streaming ?? null);
  const [input, setInput] = useState("");
  const [editAt, setEditAt] = useState<number | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [archive, setArchive] = useState<ArchivedChat[]>([]);
  const [allPrompts, setAllPrompts] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const box = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const histBtn = useRef<HTMLButtonElement>(null);
  const histStyle = useFixedUpMenu(histOpen, histBtn, 280, "right");
  const prompts = useMemo(() => quickPrompts(settings).filter((p) => p.enabled), [settings]);
  const shown = allPrompts ? prompts : prompts.slice(0, 4);
  const provider = settings.providers[settings.chatProvider];
  const busy = streaming != null;
  const blocked = !transcript?.segments.length;

  useEffect(() => {
    void loadChat(episode.id);
    void loadArchive(episode.id).then(setArchive);
    setEditAt(null);
    setInput("");
    setAtBottom(true);
  }, [episode.id]);

  // 仅贴底时跟随新消息，上翻回看不被打断
  useEffect(() => {
    if (atBottom) end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, streaming, atBottom]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };
  const toBottom = () => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    setAtBottom(true);
  };

  // 编辑时把完整原文放进输入框，并按内容增高，避免截断观感
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(200, Math.max(34, el.scrollHeight))}px`;
  }, [input, editAt]);

  const send = (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    const base = editAt != null ? messages.slice(0, editAt) : messages;
    setEditAt(null);
    setInput("");
    setSetupError(null);
    setAtBottom(true);
    void askChat(episode, [...base, { role: "user", content: q }]).catch((e: Error & { setup?: boolean }) => {
      setSetupError(e.message);
      if (e.setup) set({ settingsOpen: true, settingsSection: "ai" });
    });
  };

  const pairStart = (i: number) =>
    messages[i]?.role === "assistant" && messages[i - 1]?.role === "user" ? i - 1 : i;

  const removePair = (i: number) => {
    const prev = messages;
    const a = pairStart(i);
    const b = messages[a + 1]?.role === "assistant" ? a + 2 : a + 1;
    if (editAt != null && a <= editAt) setEditAt(null);
    saveChat(episode.id, [...messages.slice(0, a), ...messages.slice(b)]);
    useStore.getState().notify(t("已删除"), {
      label: t("撤销"),
      run: () => saveChat(episode.id, prev),
    });
  };

  const edit = (i: number) => {
    setEditAt(i);
    setInput(messages[i]?.content ?? "");
    window.setTimeout(() => box.current?.focus(), 0);
  };

  const retry = () => {
    const i = messages.length - 1;
    if (messages[i]?.role === "assistant" && !busy) {
      void askChat(episode, messages.slice(0, i)).catch((e: Error) => setSetupError(e.message));
    }
  };

  const newChat = () => {
    if (!messages.length) return;
    const next = [{ id: `${Date.now()}`, at: Date.now(), messages }, ...archive].slice(0, 30);
    setArchive(next);
    saveArchive(episode.id, next);
    saveChat(episode.id, []);
    setEditAt(null);
    setInput("");
    box.current?.focus();
  };

  const restore = (id: string) => {
    const c = archive.find((x) => x.id === id);
    if (!c) return;
    const rest = archive.filter((x) => x.id !== id);
    const next = messages.length ? [{ id: `${Date.now()}`, at: Date.now(), messages }, ...rest] : rest;
    setArchive(next);
    saveArchive(episode.id, next);
    saveChat(episode.id, c.messages);
    setHistOpen(false);
  };

  const empty = !messages.length && !busy;
  const seek = (sec: number) => seekEpisode(episode, sec);
  const clipRange = (start: number, end?: number) => {
    if (!episode.videoId || !transcript?.segments.length) {
      useStore.getState().notify(episode.videoId ? t("需要先有字幕才能剪视频") : t("只有 YouTube 单集才能剪视频"));
      return;
    }
    const zh = useJobs.getState().translations[episode.id]?.items;
    const { startIdx, endIdx } = rangeFromClock(transcript.segments, start, end);
    const clip = createManualClip(transcript.segments, zh, startIdx, endIdx, episode);
    openVideoClipDialog({ ep: episode, segments: transcript.segments, zh, clip });
  };

  return (
    <div className="chat">
      <div className="chat-stage">
        <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
          {empty && (
            <div className="chat-intro">
              <p className="lead">{t("问这期节目")}</p>
              <p className="muted small">{t("基于整集字幕回答，引用可跳转")}</p>
              {blocked && <p className="muted small">{t("字幕准备好后就可以提问。")}</p>}
              <div className="prompt-list">
                {shown.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="prompt-row"
                    title={t(p.body)}
                    disabled={blocked || busy}
                    onClick={() => send(t(p.body))}
                  >
                    <span className="pr-title">{t(p.title)}</span>
                    <span className="pr-sub">{t(p.body)}</span>
                  </button>
                ))}
              </div>
              <div className="prompt-foot">
                {prompts.length > 4 && (
                  <button type="button" className="link-btn" onClick={() => setAllPrompts(!allPrompts)}>
                    {allPrompts ? t("收起") : t("更多 {n} 个", { n: prompts.length - 4 })}
                    <ChevronDown size={12} className={allPrompts ? "flip" : ""} />
                  </button>
                )}
                <span className="spacer" />
                <button type="button" className="link-btn" onClick={() => setPrefsOpen(true)}>
                  <Settings2 size={13} /> {t("自定义提示词")}
                </button>
              </div>
            </div>
          )}
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="msg-wrap user">
                <div className="msg user">{m.content}</div>
                {!busy && (
                  <div className="msg-actions">
                    <button type="button" className="link-btn" onClick={() => edit(i)}>
                      {t("编辑")}
                    </button>
                    <button type="button" className="link-btn" onClick={() => removePair(i)}>
                      {t("删除")}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div key={i} className="msg-wrap assistant">
                <div className="msg assistant">
                  <Markdown text={m.content} onSeek={seek} onClip={clipRange} />
                </div>
                {!busy && (
                  <div className="msg-actions">
                    {m.model && <span className="muted small">{m.model}</span>}
                    {i === messages.length - 1 && !blocked && (
                      <button type="button" className="link-btn" onClick={retry}>
                        {t("重试")}
                      </button>
                    )}
                    <button type="button" className="link-btn" onClick={() => removePair(i)}>
                      {t("删除")}
                    </button>
                  </div>
                )}
              </div>
            ),
          )}
          {busy && (
            <div className="msg assistant">
              {streaming ? (
                <Markdown text={streaming} onSeek={seek} onClip={clipRange} />
              ) : (
                <p className="muted">
                  <Loader2 size={14} className="spin" /> {t("正在阅读文字稿…")}
                </p>
              )}
            </div>
          )}
          {setupError && (
            <div className="setup-note">
              <span>{setupError}</span>
              <button type="button" className="btn primary sm" onClick={() => set({ settingsOpen: true, settingsSection: "ai" })}>
                {t("去设置")}
              </button>
            </div>
          )}
          <div ref={end} />
        </div>
        {!atBottom && (messages.length > 0 || busy) && (
          <button
            type="button"
            className="to-bottom"
            title={t("回到底部")}
            aria-label={t("回到底部")}
            onClick={toBottom}
          >
            <ArrowDown size={16} />
          </button>
        )}
      </div>
      {editAt != null && (
        <div className="edit-banner small">
          <span>{t("正在编辑历史提问，发送后将从此处重新生成")}</span>
          <button
            type="button"
            className="link-btn small"
            onClick={() => {
              setEditAt(null);
              setInput("");
            }}
          >
            {t("取消")}
          </button>
        </div>
      )}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          ref={box}
          value={input}
          rows={1}
          placeholder={blocked ? t("字幕准备好后可以提问") : t("问点什么，Enter 发送，Shift+Enter 换行")}
          disabled={blocked && !busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        <div className="composer-bar">
          <ModelPicker />
          <PromptMenu onPick={(b) => send(b)} onManage={() => setPrefsOpen(true)} disabled={blocked || busy} />
          <span className="spacer" />
          <div className="hist-wrap">
            <button
              ref={histBtn}
              type="button"
              className="btn ghost sm"
              disabled={!archive.length && !messages.length}
              title={t("对话历史")}
              aria-expanded={histOpen}
              onClick={() => setHistOpen(!histOpen)}
            >
              {t("历史")}
            </button>
            {histOpen && histStyle && (
              <>
                <div className="mp-backdrop" onClick={() => setHistOpen(false)} />
                <div className="mp-menu hist-menu mp-fixed" style={histStyle}>
                  {!archive.length && <p className="muted small">{t("还没有历史对话")}</p>}
                  {archive.map((a) => (
                    <button key={a.id} type="button" onClick={() => restore(a.id)}>
                      <span className="mp-name">{new Date(a.at).toLocaleString()}</span>
                      <span className="mp-model">{a.messages.find((m) => m.role === "user")?.content.slice(0, 40) ?? t("空对话")}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {messages.length > 0 && !busy && (
            <button type="button" className="btn ghost sm" title={t("开始新对话")} onClick={newChat}>
              <SquarePen size={14} /> {t("新对话")}
            </button>
          )}
          {busy ? (
            <button type="button" className="send" title={t("停止")} onClick={() => stopChat(episode.id)}>
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button type="submit" className="send" title={t("发送")} disabled={!input.trim() || blocked}>
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </form>
      <p className="model-note">
        {provider ? t("回答由 AI 生成 · {name}", { name: t(provider.name) }) : t("回答由 AI 生成，可能有误")}
      </p>
      {prefsOpen && <ChatPrefsDialog onClose={() => setPrefsOpen(false)} />}
    </div>
  );
}
