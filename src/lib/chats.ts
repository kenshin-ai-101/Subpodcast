/**
 * [INPUT]: api.getBlob/setBlob/llmChat；ai.qaSystem/transcriptForModel；jobs；settings
 * [OUTPUT]: useChats、loadChat、askChat、stopChat、saveChat、ArchivedChat
 * [POS]: 问答会话态在面板外；blob kind=chat / chat-archive
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { qaSystem, shortModel, transcriptForModel } from "./ai";
import { api, errText, type ChatMessage, type Episode } from "./api";
import { tNow } from "./i18n";
import { useJobs } from "./jobs";
import { resolveChatModel } from "./modelResolve";
import { useStore } from "../store";

export interface ArchivedChat {
  id: string;
  at: number;
  messages: ChatMessage[];
}

interface ChatState {
  messages: ChatMessage[];
  streaming: string | null;
  loaded: boolean;
}

const empty = (): ChatState => ({ messages: [], streaming: null, loaded: false });

export const useChats = create<Record<string, ChatState>>(() => ({}));

function put(id: string, p: Partial<ChatState>) {
  useChats.setState((s) => ({ [id]: { ...(s[id] ?? empty()), ...p } }));
}

const aborts = new Map<string, { stop: boolean; unlisten: () => void; jobId: string }>();

export function saveChat(episodeId: string, messages: ChatMessage[]) {
  put(episodeId, { messages, loaded: true });
  void api.setBlob(episodeId, "chat", JSON.stringify(messages));
}

export async function loadChat(episodeId: string) {
  if (useChats.getState()[episodeId]?.loaded) return;
  try {
    const raw = await api.getBlob(episodeId, "chat");
    let list: ChatMessage[] = [];
    try {
      list = raw ? (JSON.parse(raw) as ChatMessage[]) : [];
    } catch {
      list = [];
    }
    if (!useChats.getState()[episodeId]?.loaded) put(episodeId, { messages: list, loaded: true });
  } catch {
    put(episodeId, { messages: [], loaded: true });
  }
}

export async function loadArchive(episodeId: string): Promise<ArchivedChat[]> {
  try {
    const raw = await api.getBlob(episodeId, "chat-archive");
    return raw ? (JSON.parse(raw) as ArchivedChat[]) : [];
  } catch {
    return [];
  }
}

export function saveArchive(episodeId: string, archive: ArchivedChat[]) {
  void api.setBlob(episodeId, "chat-archive", JSON.stringify(archive.slice(0, 30)));
}

export async function askChat(ep: Episode, history: ChatMessage[]) {
  if (useChats.getState()[ep.id]?.streaming != null) return;
  const settings = useStore.getState().settings;
  const provider = settings.providers[settings.chatProvider];
  const transcript = useJobs.getState().transcripts[ep.id];
  const translation = useJobs.getState().translations[ep.id];

  const modelName = resolveChatModel(settings, provider);
  if (!transcript?.segments.length) throw Object.assign(new Error(tNow("需要先有字幕才能提问")), { setup: true });
  if (!provider || !modelName) throw Object.assign(new Error(tNow("请先在设置里选择模型")), { setup: true });
  if (provider.needsKey && !(await api.hasApiKey(provider.id))) {
    throw Object.assign(new Error(tNow("请先在设置里填写「{name}」的 API Key", { name: provider.name })), { setup: true });
  }

  const modelLabel = `${provider.name} · ${shortModel(modelName)}`;
  saveChat(ep.id, history);
  put(ep.id, { streaming: "" });

  let unlisten = () => {};
  const jobId = `chat:${ep.id}:${Date.now()}`;
  const handle = { stop: false, unlisten, jobId };
  aborts.set(ep.id, handle);
  let partial = "";
  try {
    unlisten = await listen<string | { requestId?: string; delta?: string }>("llm-delta", ({ payload }) => {
      if (handle.stop) return;
      const chunk =
        typeof payload === "string"
          ? payload
          : !payload?.requestId || payload.requestId === jobId
            ? (payload?.delta ?? "")
            : "";
      if (!chunk) return;
      partial += chunk;
      put(ep.id, { streaming: partial });
    });
    handle.unlisten = unlisten;
    const context = transcriptForModel(transcript.segments, translation?.items);
    const instruction = settings.chatPromptOn ? settings.chatPrompt : "";
    const full = await api.llmChat({
      provider: provider.id,
      baseUrl: provider.baseUrl,
      model: modelName,
      protocol: provider.protocol,
      stream: true,
      jobId,
      messages: [
        { role: "system", content: qaSystem(ep.title, ep.showTitle ?? "", context, instruction) },
        ...history.map((m) => ({ role: m.role, content: m.content })),
      ],
    });
    if (handle.stop) {
      const note = tNow("（已停止）");
      saveChat(ep.id, [
        ...history,
        { role: "assistant", content: partial ? `${partial}\n\n${note}` : note, model: modelLabel },
      ]);
      return;
    }
    const content = (full.trim() || partial).trim();
    saveChat(ep.id, [
      ...history,
      {
        role: "assistant",
        content: content || tNow("出错了：模型没有返回内容，请重试或换一个模型"),
        model: modelLabel,
      },
    ]);
  } catch (e) {
    const note = handle.stop ? tNow("（已停止）") : tNow("出错了：{msg}", { msg: errText(e) });
    saveChat(ep.id, [
      ...history,
      { role: "assistant", content: partial ? `${partial}\n\n${note}` : note, model: modelLabel },
    ]);
  } finally {
    unlisten();
    aborts.delete(ep.id);
    put(ep.id, { streaming: null });
  }
}

export function stopChat(episodeId: string) {
  const h = aborts.get(episodeId);
  if (!h) return;
  h.stop = true;
  h.unlisten();
  void api.cancelJob(h.jobId).catch(() => {});
}
