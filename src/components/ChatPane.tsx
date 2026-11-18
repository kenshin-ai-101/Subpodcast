/**
 * [INPUT]: chats.loadChat/askChat；jobs.transcript；settings.quickPrompts；ChatTools
 * [OUTPUT]: 右侧问答面板（提示词、模型切换、会话持久化、历史）
 * [POS]: 理解层；会话态在 lib/chats，切 tab 不丢流
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowUp, ChevronDown, Loader2, Settings2, Square, SquarePen } from "lucide-react";
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
import { useJobs } from "../lib/jobs";
import { quickPrompts } from "../lib/settings";
import { useStore } from "../store";
import { ChatPrefsDialog, ModelPicker, PromptMenu, useFixedUpMenu } from "./ChatTools";
import { Markdown } from "./Markdown";

const NO_MESSAGES: ChatMessage[] = [];

export function ChatPane({ episode }: { episode: Episode }) {
  const transcript = useJobs((s) => s.transcripts[episode.id]);
  const { settings, player, set } = useStore(
    useShallow((s) => ({ settings: s.settings, player: s.player, set: s.set })),
  );
  const messages = useChats((s) => s[episode.id]?.messages ?? NO_MESSAGES);
  const streaming = useChats((s) => s[episode.id]?.streaming ?? null);
  const [input, setInput] = useState("");
  const [setupError, setSetupError] = useState<string | null>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [archive, setArchive] = useState<ArchivedChat[]>([]);
  const [allPrompts, setAllPrompts] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
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
  }, [episode.id]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, streaming]);

  const send = (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setInput("");
    setSetupError(null);
    void askChat(episode, [...messages, { role: "user", content: q }]).catch((e: Error & { setup?: boolean }) => {
      setSetupError(e.message);
      if (e.setup) set({ settingsOpen: true, settingsSection: "ai" });
    });
  };

  const pairStart = (i: number) =>
    messages[i]?.role === "assistant" && messages[i - 1]?.role === "user" ? i - 1 : i;

  const removePair = (i: number) => {
    const a = pairStart(i);
    const b = messages[a + 1]?.role === "assistant" ? a + 2 : a + 1;
    saveChat(episode.id, [...messages.slice(0, a), ...messages.slice(b)]);
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
  const seek = (sec: number) => player?.seek(sec);

  return (
    <div className="chat">
      <div className="chat-scroll">
        {empty && (
          <div className="chat-intro">
            <p className="lead">问这期节目</p>
            <p className="muted small">基于整集字幕回答，引用可跳转</p>
            {blocked && <p className="muted small">字幕准备好后就可以提问。</p>}
            <div className="prompt-list">
              {shown.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="prompt-row"
                  title={p.body}
                  disabled={blocked || busy}
                  onClick={() => send(p.body)}
                >
                  <span className="pr-title">{p.title}</span>
                  <span className="pr-sub">{p.body}</span>
                </button>
              ))}
            </div>
            <div className="prompt-foot">
              {prompts.length > 4 && (
                <button type="button" className="link-btn" onClick={() => setAllPrompts(!allPrompts)}>
                  {allPrompts ? "收起" : `更多 ${prompts.length - 4} 个`}
                  <ChevronDown size={12} className={allPrompts ? "flip" : ""} />
                </button>
              )}
              <span className="spacer" />
              <button type="button" className="link-btn" onClick={() => setPrefsOpen(true)}>
                <Settings2 size={13} /> 自定义提示词
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
                  <button type="button" className="link-btn" onClick={() => removePair(i)}>
                    删除
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div key={i} className="msg-wrap assistant">
              <div className="msg assistant">
                <Markdown text={m.content} onSeek={seek} />
              </div>
              {!busy && (
                <div className="msg-actions">
                  {m.model && <span className="muted small">{m.model}</span>}
                  {i === messages.length - 1 && !blocked && (
                    <button type="button" className="link-btn" onClick={retry}>
                      重试
                    </button>
                  )}
                  <button type="button" className="link-btn" onClick={() => removePair(i)}>
                    删除
                  </button>
                </div>
              )}
            </div>
          ),
        )}
        {busy && (
          <div className="msg assistant">
            {streaming ? (
              <Markdown text={streaming} onSeek={seek} />
            ) : (
              <p className="muted">
                <Loader2 size={14} className="spin" /> 正在阅读文字稿…
              </p>
            )}
          </div>
        )}
        {setupError && (
          <div className="setup-note">
            <span>{setupError}</span>
            <button type="button" className="btn primary sm" onClick={() => set({ settingsOpen: true, settingsSection: "ai" })}>
              去设置
            </button>
          </div>
        )}
        <div ref={end} />
      </div>
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
          placeholder={blocked ? "字幕准备好后可以提问" : "问点什么，Enter 发送，Shift+Enter 换行"}
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
              title="对话历史"
              aria-expanded={histOpen}
              onClick={() => setHistOpen(!histOpen)}
            >
              历史
            </button>
            {histOpen && histStyle && (
              <>
                <div className="mp-backdrop" onClick={() => setHistOpen(false)} />
                <div className="mp-menu hist-menu mp-fixed" style={histStyle}>
                  {!archive.length && <p className="muted small">还没有历史对话</p>}
                  {archive.map((a) => (
                    <button key={a.id} type="button" onClick={() => restore(a.id)}>
                      <span className="mp-name">{new Date(a.at).toLocaleString()}</span>
                      <span className="mp-model">{a.messages.find((m) => m.role === "user")?.content.slice(0, 40) ?? "空对话"}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {messages.length > 0 && !busy && (
            <button type="button" className="btn ghost sm" title="开始新对话" onClick={newChat}>
              <SquarePen size={14} /> 新对话
            </button>
          )}
          {busy ? (
            <button type="button" className="send" title="停止" onClick={() => stopChat(episode.id)}>
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button type="submit" className="send" title="发送" disabled={!input.trim() || blocked}>
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </form>
      <p className="model-note">
        {provider ? `回答由 AI 生成 · ${provider.name}` : "回答由 AI 生成，可能有误"}
      </p>
      {prefsOpen && <ChatPrefsDialog onClose={() => setPrefsOpen(false)} />}
    </div>
  );
}
