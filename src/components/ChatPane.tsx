/**
 * [INPUT]: jobs.transcript、settings、api.llmChat；可跳转到设置 › AI
 * [OUTPUT]: 右侧问答面板（.chat / .composer，对齐 SubCast）
 * [POS]: 理解层
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { listen } from "@tauri-apps/api/event";
import { Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, errText, type Episode } from "../lib/api";
import { useJobs } from "../lib/jobs";
import { useStore } from "../store";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

const PROMPTS = [
  "用三分钟讲清这期在说什么",
  "最有价值的三个观点是什么？",
  "嘉宾是谁，他们的立场？",
  "有哪些反直觉或有争议的地方？",
];

function renderAnswer(text: string, onSeek: (sec: number) => void) {
  const parts = text.split(/(\[\d{1,2}:\d{2}(?::\d{2})?\])/g);
  return parts.map((p, i) => {
    const m = p.match(/^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]$/);
    if (!m) return <span key={i}>{p}</span>;
    const sec = m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
    return (
      <button key={i} className="stamp" type="button" onClick={() => onSeek(sec)}>
        {p}
      </button>
    );
  });
}

export function ChatPane({ episode }: { episode: Episode }) {
  const transcript = useJobs((s) => s.transcripts[episode.id]);
  const settings = useStore((s) => s.settings);
  const player = useStore((s) => s.player);
  const notify = useStore((s) => s.notify);
  const set = useStore((s) => s.set);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const provider = settings.providers[settings.chatProvider];

  useEffect(() => {
    setMessages([]);
  }, [episode.id]);

  const context = useMemo(() => {
    if (!transcript?.segments.length) return "";
    return transcript.segments
      .map((s) => {
        const m = Math.floor(s.start / 60);
        const sec = Math.floor(s.start % 60);
        return `[${m}:${sec.toString().padStart(2, "0")}] ${s.text}`;
      })
      .join("\n");
  }, [transcript]);

  const ask = async (question: string) => {
    if (!question.trim() || !context || busy) return;
    if (!provider) {
      notify("请先在设置里选择模型");
      set({ settingsOpen: true, settingsSection: "ai" });
      return;
    }
    setMessages((m) => [...m, { role: "user", content: question.trim() }, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);
    let unlisten = () => {};
    try {
      unlisten = await listen<string>("llm-delta", ({ payload }) => {
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last?.role === "assistant") copy[copy.length - 1] = { role: "assistant", content: last.content + payload };
          return copy;
        });
      });
      const system = `你是播客学习助手「声译」。根据带时间戳的文稿回答。
用中文。引用观点时必须带 [mm:ss]。不要编造文稿没有的内容。

文稿：
${context.slice(0, 120_000)}`;
      const full = await api.llmChat({
        provider: provider.id,
        baseUrl: provider.baseUrl,
        model: provider.model,
        protocol: provider.protocol,
        stream: true,
        messages: [
          { role: "system", content: system },
          ...messages.map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: question.trim() },
        ],
      });
      setMessages((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        if (last?.role === "assistant" && (!last.content || full.length > last.content.length)) {
          copy[copy.length - 1] = { role: "assistant", content: full };
        }
        return copy;
      });
    } catch (e) {
      notify(errText(e));
      setMessages((m) => m.slice(0, -1));
    } finally {
      unlisten();
      setBusy(false);
    }
  };

  if (!transcript?.segments.length) {
    return (
      <div className="chat">
        <div className="panel-empty">
          <p className="lead">字幕准备好后就可以提问</p>
          <p className="muted">回答会带可点击时间戳，点一下跳回原话。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="chat">
      <div className="chat-scroll">
        {messages.length === 0 && (
          <div className="chat-intro">
            <p className="lead">问这期节目</p>
            <p className="muted small">基于整集字幕回答，引用可跳转</p>
            <div className="chips">
              {PROMPTS.map((p) => (
                <button key={p} className="chip" onClick={() => void ask(p)}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === "assistant" ? renderAnswer(m.content, (sec) => player?.seek(sec)) : m.content}
          </div>
        ))}
      </div>
      <div className="composer">
        <textarea
          value={input}
          rows={1}
          placeholder="问这期节目任何问题…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask(input);
            }
          }}
        />
        <button className="send" disabled={busy || !input.trim()} onClick={() => void ask(input)} aria-label="发送">
          <Send size={15} />
        </button>
      </div>
      <p className="model-note">
        {provider ? (
          `${provider.name} · ${provider.model}`
        ) : (
          <button type="button" className="link-btn" onClick={() => set({ settingsOpen: true, settingsSection: "ai" })}>
            去设置 › AI
          </button>
        )}
      </p>
    </div>
  );
}
