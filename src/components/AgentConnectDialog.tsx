/**
 * [INPUT]: api.mcpAgents* / cliStatus；store.settings.agentsOffered / notify / set；agentMarks；lucide
 * [OUTPUT]: AgentSettings（设置 › 让 AI 助手调用声译）+ AgentConnectDialogHost（启动提示卡）
 * [POS]: 布局与交互对齐 SubCast AgentConnect（品牌标行表、官方 mcp add 由后端完成、agentsOffered 一次性提示）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useState } from "react";
import { Check, Loader2, Plug, RefreshCw, X } from "lucide-react";
import { api, errText, type AgentClientInfo } from "../lib/api";
import { agentMarkSvg } from "../lib/agentMarks";
import { useT } from "../lib/i18n";
import { useStore } from "../store";

const pending = (c: AgentClientInfo) => !c.connected || c.needsUpdate;
const EXAMPLE = (t: (k: string) => string) =>
  t("「总结一下 Lex Fridman 最新一期」「找出这期的高光片段」");

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

async function connectAll(
  list: AgentClientInfo[],
  put: (c: AgentClientInfo) => void,
  onBusy: (id: string | null) => void,
) {
  const done: string[] = [];
  let failed: string | null = null;
  for (const client of list) {
    onBusy(client.id);
    try {
      const updated = await api.mcpAgentConnect(client.id);
      put(updated);
      if (updated.connected) done.push(client.name);
    } catch (e) {
      failed ??= `${client.name}：${errText(e)}`;
    }
  }
  onBusy(null);
  return { done, failed };
}

export function AgentSettings() {
  const t = useT();
  const [clients, setClients] = useState<AgentClientInfo[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const notify = useStore((s) => s.notify);
  const saveSettings = useStore((s) => s.saveSettings);

  const markOffered = () => {
    if (!useStore.getState().settings.agentsOffered) void saveSettings({ agentsOffered: true });
  };

  const refresh = () => {
    void (async () => {
      try {
        const cli = await api.cliStatus();
        if (!cli.bundled && !cli.installed) {
          setUnavailable(true);
          setClients([]);
          return;
        }
        setClients(await api.mcpAgentsDetect());
        setUnavailable(false);
      } catch {
        setUnavailable(true);
      }
    })();
  };

  useEffect(() => {
    refresh();
  }, []);

  if (unavailable) {
    return <p className="muted small">{t("发布版才能接入（开发版没有附带命令行程序）。")}</p>;
  }
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
        <button type="button" className="link-btn small" onClick={refresh}>
          {t("重新查找")}
        </button>
      </p>
    );
  }

  const todo = clients.filter(pending);
  const put = (n: AgentClientInfo) => setClients((xs) => xs?.map((x) => (x.id === n.id ? n : x)) ?? xs);

  // 与原站一致：单次 invoke 返回该行最新状态，直接 put；不在 finally 里全量 refresh（避免路径误判把刚接入打成「需要更新」）。
  const toggle = async (c: AgentClientInfo) => {
    setBusyId(c.id);
    try {
      const n = c.connected && !c.needsUpdate ? await api.mcpAgentDisconnect(c.id) : await api.mcpAgentConnect(c.id);
      put(n);
      markOffered();
      notify(n.connected ? t("已接入 {name}，重新打开它就能用", { name: t(n.name) }) : t("已从 {name} 移除", { name: t(n.name) }));
    } catch (e) {
      notify(errText(e));
    } finally {
      setBusyId(null);
    }
  };

  const all = async () => {
    const { done, failed } = await connectAll(todo, put, setBusyId);
    markOffered();
    notify(failed ? failed : t("已接入 {n} 个 AI 助手，重新打开它们就能用", { n: done.length }));
  };

  return (
    <div className="agent-connect">
      <div className="agent-connect-head">
        <p className="muted small">{t("接入后，可以直接对它们说：{example}", { example: EXAMPLE(t) })}</p>
        {todo.length > 1 && (
          <button type="button" className="btn primary sm" disabled={busyId != null} onClick={() => void all()}>
            <Plug size={13} /> {t("全部接入")}
          </button>
        )}
      </div>
      <ul className="agent-list">
        {clients.map((c) => (
          <li className="agent-row" key={c.id}>
            <AgentMark id={c.icon || c.id} name={c.name} size={28} />
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
              disabled={busyId != null}
              title={c.configPath}
              onClick={() => void toggle(c)}
            >
              {busyId === c.id ? <Loader2 size={13} className="spin" /> : c.needsUpdate ? <RefreshCw size={13} /> : null}
              {c.needsUpdate ? t("更新") : c.connected ? t("移除") : t("接入")}
            </button>
          </li>
        ))}
      </ul>
      <p className="muted small">{t("声译只在对方的配置里加一条 subpodcast，原有设置不动；随时可以移除。")}</p>
    </div>
  );
}

export function AgentConnectDialogHost() {
  const offered = useStore((s) => s.settings.agentsOffered);
  const [list, setList] = useState<AgentClientInfo[] | null>(null);
  const [state, setState] = useState<"ask" | "busy" | "done">("ask");
  const [result, setResult] = useState("");
  const [allFailed, setAllFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const t = useT();
  const saveSettings = useStore((s) => s.saveSettings);

  useEffect(() => {
    if (offered) return;
    const timer = window.setTimeout(() => {
      void api
        .mcpAgentsDetect()
        .then((xs) => {
          const todo = xs.filter((x) => !x.connected);
          if (todo.length) setList(todo);
        })
        .catch(() => {});
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [offered]);

  if (offered && state !== "done") return null;
  if (!list) return null;

  const close = () => {
    setList(null);
    if (!useStore.getState().settings.agentsOffered) void saveSettings({ agentsOffered: true });
  };

  const names = list.map((x) => x.name);
  const shown =
    names.length > 3
      ? t("{names} 等 {n} 个", { names: names.slice(0, 3).join("、"), n: names.length })
      : names.join("、");

  const connect = async () => {
    setState("busy");
    const { done, failed } = await connectAll(list, () => {}, setBusyId);
    void saveSettings({ agentsOffered: true });
    setAllFailed(!!failed && !done.length);
    setResult(
      failed && !done.length
        ? failed
        : failed
          ? t("已接入 {n} 个，有一个没成功：{error}", { n: done.length, error: failed })
          : t("已接入 {n} 个。重新打开它们，就能让它们帮你总结、找高光、剪视频。", { n: done.length }),
    );
    setState("done");
    window.setTimeout(() => setList(null), failed ? 12000 : 7000);
  };

  return (
    <aside className="agent-offer update-card" role="status" aria-label={t("让 AI 助手调用声译")}>
      <div className="agent-offer-marks" aria-hidden>
        {list.slice(0, 3).map((c) => (
          <span key={c.id} className={busyId === c.id ? "busy" : undefined}>
            <AgentMark id={c.icon || c.id} name={c.name} size={26} />
          </span>
        ))}
      </div>
      <div className="agent-offer-body update-text">
        {state === "done" ? (
          <p className={`update-title${allFailed ? " error-text" : ""}`}>
            {!allFailed && <Check size={13} className="ok-text" />} {result}
          </p>
        ) : (
          <>
            <p className="update-title">{t("让 {names} 也能用声译？", { names: shown })}</p>
            <p className="muted small">{t("接入后，可以直接对它们说：{example}", { example: EXAMPLE(t) })}</p>
            <div className="agent-offer-actions">
              <button type="button" className="btn primary sm" disabled={state === "busy"} onClick={() => void connect()}>
                {state === "busy" ? <Loader2 size={13} className="spin" /> : <Plug size={13} />}
                {state === "busy" ? t("正在接入…") : t("一键接入")}
              </button>
              <button
                type="button"
                className="btn ghost sm"
                disabled={state === "busy"}
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
      {state !== "busy" && (
        <button type="button" className="icon-btn" title={t("不用了")} aria-label={t("不用了")} onClick={close}>
          <X size={14} />
        </button>
      )}
    </aside>
  );
}
