/**
 * [INPUT]: api.mcpAgents* / cliStatus；store.notify / set；agentMarks；lucide
 * [OUTPUT]: AgentSettings（设置 › 让 AI 助手调用声译）+ AgentConnectDialogHost（启动提示卡）+ maybePromptAgentConnect
 * [POS]: 布局对齐 SubCast agent-connect 列表（品牌标 + 状态色 + 行内操作）；启动提示仍为右下角卡片
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useState } from "react";
import { create } from "zustand";
import { Check, Loader2, Plug, RefreshCw } from "lucide-react";
import { api, errText, type AgentClientInfo } from "../lib/api";
import { agentMarkSvg } from "../lib/agentMarks";
import { useT } from "../lib/i18n";
import { useStore } from "../store";

const seenKey = "subpodcast.mcpPrompt.seen";
const usePrompt = create(() => ({ clients: [] as AgentClientInfo[] }));
const pending = (c: AgentClientInfo) => c.installed && (!c.connected || c.needsUpdate);

function AgentMark({ id, name, size = 28 }: { id: string; name: string; size?: number }) {
  const icon = agentMarkSvg(id);
  if (icon) {
    return (
      <span
        className="ms-mark has-icon"
        style={{ width: size, height: size }}
        aria-hidden
        dangerouslySetInnerHTML={{ __html: icon }}
      />
    );
  }
  const letters = name
    .replace(/[（(].*$/, "")
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className="ms-mark" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden>
      {letters || id.slice(0, 2).toUpperCase()}
    </span>
  );
}

export async function maybePromptAgentConnect() {
  try {
    const [clients, cli] = await Promise.all([api.mcpAgentsDetect(), api.cliStatus()]);
    const list = clients.filter(pending);
    const signature = list.map((c) => c.id).sort().join(",");
    if (!signature || (!cli.installed && !cli.bundled) || document.querySelector(".modal-back")) return;
    if (localStorage.getItem(seenKey) === signature || localStorage.getItem("subpodcast.mcpPrompt.never") === "1") return;
    localStorage.setItem(seenKey, signature);
    usePrompt.setState({ clients: list });
  } catch {
    /* 启动探测可失败，不打扰 */
  }
}

async function connect(clients: AgentClientInfo[]) {
  const failures: string[] = [];
  let count = 0;
  for (const client of clients) {
    try {
      await api.mcpAgentsConnect([client.id]);
      count++;
    } catch (error) {
      failures.push(client.name + " · " + errText(error));
    }
  }
  return { count, failures };
}

export function AgentSettings() {
  const t = useT();
  const [clients, setClients] = useState<AgentClientInfo[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const notify = useStore((s) => s.notify);

  async function refresh() {
    try {
      setClients((await api.mcpAgentsDetect()).filter((c) => c.installed));
      setError("");
    } catch (e) {
      setError(errText(e));
      setClients([]);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function changeOne(client: AgentClientInfo) {
    const remove = client.connected && !client.needsUpdate;
    setBusyId(client.id);
    try {
      if (remove) await api.mcpAgentDisconnect(client.id);
      else {
        const result = await connect([client]);
        if (result.count) notify(t("已接入 {name}，重新打开它就能用", { name: client.name }));
        if (result.failures.length) notify(result.failures.join("\n"));
      }
      if (remove) notify(t("已从 {name} 移除", { name: client.name }));
    } catch (e) {
      notify(errText(e));
    } finally {
      setBusyId(null);
      await refresh();
    }
  }

  async function changeAll(list: AgentClientInfo[]) {
    setBusyId("*");
    try {
      const result = await connect(list);
      if (result.count) notify(t("已接入 {n} 个 AI 助手，重新打开后生效", { n: result.count }));
      if (result.failures.length) notify(result.failures.join("\n"));
    } catch (e) {
      notify(errText(e));
    } finally {
      setBusyId(null);
      await refresh();
    }
  }

  if (error) return <p className="muted small" role="alert">{error}</p>;
  if (!clients) {
    return (
      <p className="muted small">
        <Loader2 size={13} className="spin" /> {t("正在查找本机的 AI 助手…")}
      </p>
    );
  }
  if (!clients.length) {
    return (
      <p className="muted small">
        {t("没有找到支持的 AI 助手。装好 Claude Code、Codex、Antigravity CLI 等之后，回来点「重新查找」。")}{" "}
        <button type="button" className="link-btn small" onClick={() => void refresh()}>
          {t("重新查找")}
        </button>
      </p>
    );
  }

  const todo = clients.filter(pending);
  const locked = busyId != null;

  return (
    <div className="agent-connect">
      <div className="agent-connect-head">
        <p className="muted small">{t("接入后，可以直接对它们说：帮我总结最新一期播客。")}</p>
        {todo.length > 1 && (
          <button type="button" className="btn primary sm" disabled={locked} onClick={() => void changeAll(todo)}>
            <Plug size={13} /> {t("全部接入")}
          </button>
        )}
      </div>
      <ul className="agent-list">
        {clients.map((c) => {
          const rowBusy = busyId === c.id || busyId === "*";
          return (
            <li className="agent-row" key={c.id}>
              <AgentMark id={c.id} name={c.name} size={28} />
              <div className="agent-row-text">
                <p>{c.name}</p>
                <p className="muted small">
                  {c.needsUpdate ? (
                    <span className="warn-text">{t("指向旧位置的声译，点「更新」修好")}</span>
                  ) : c.connected ? (
                    <span className="ok-text">
                      <Check size={12} /> {t("已接入")}
                    </span>
                  ) : (
                    t("未接入")
                  )}
                </p>
              </div>
              <button
                type="button"
                className={`btn sm${c.connected && !c.needsUpdate ? " ghost" : ""}`}
                disabled={locked}
                title={c.configPath}
                onClick={() => void changeOne(c)}
              >
                {rowBusy ? <Loader2 size={13} className="spin" /> : c.needsUpdate ? <RefreshCw size={13} /> : null}
                {c.needsUpdate ? t("更新") : c.connected ? t("移除") : t("接入")}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="muted small">{t("声译只在对方的配置里加一条 subpodcast，原有设置不动；随时可以移除。")}</p>
    </div>
  );
}

export function AgentConnectDialogHost() {
  const clients = usePrompt((s) => s.clients);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const notify = useStore((s) => s.notify);
  const t = useT();
  const close = () => usePrompt.setState({ clients: [] });
  useEffect(() => {
    if (!clients.length || busy) return;
    const dismiss = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [clients, busy]);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(close, 7000);
    return () => window.clearTimeout(timer);
  }, [message]);
  if (!clients.length) return null;
  async function accept() {
    setBusy(true);
    const result = await connect(clients);
    setBusy(false);
    setMessage(t("已接入 {n} 个 AI 助手，重新打开后生效", { n: result.count }));
    if (result.failures.length) notify(result.failures.join("\n"));
  }
  const names = clients
    .slice(0, 2)
    .map((c) => c.name)
    .join("、");
  return (
    <aside className="agent-offer" role="dialog" aria-labelledby="agent-title">
      <div className="agent-offer-marks" aria-hidden>
        {clients.slice(0, 3).map((c) => (
          <span key={c.id} className={busy ? "busy" : undefined}>
            <AgentMark id={c.id} name={c.name} size={26} />
          </span>
        ))}
      </div>
      <div className="agent-offer-body">
        <div className="agent-offer-head">
          <strong id="agent-title">
            {message ||
              t("让 {names} 也能用声译？", {
                names: clients.length > 2 ? t("{names} 等 {n} 个", { names, n: clients.length }) : names,
              })}
          </strong>
          <button type="button" className="icon-btn" disabled={busy} aria-label={t("关闭")} onClick={close}>
            ×
          </button>
        </div>
        {!message && (
          <>
            <p className="muted small">{t("接入后，可以直接对它们说：帮我总结最新一期播客。")}</p>
            <div className="agent-offer-actions">
              <button type="button" className="btn primary sm" disabled={busy} onClick={() => void accept()}>
                {busy ? <Loader2 size={13} className="spin" /> : <Plug size={13} />}
                {busy ? t("正在接入…") : t("一键接入")}
              </button>
              <button
                type="button"
                className="btn ghost sm"
                disabled={busy}
                onClick={() => {
                  close();
                  useStore.getState().set({ settingsOpen: true, settingsSection: "agents" });
                }}
              >
                {t("挑选")}
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
