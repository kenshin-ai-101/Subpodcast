/**
 * [INPUT]: api.llmChat / getBlob / setBlob / sharedGuide / shareGuide；jobs 字幕译文；ai.qaSystem+summaryPrompt
 * [OUTPUT]: useGuides、ensureGuide、runGuide、stopGuide
 * [POS]: 导读任务态在面板外；本地 blob → 共享查找 → 生成并可选上传；切 tab 不丢流
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { qaSystem, summaryPrompt, transcriptForModel } from "./ai";
import { api, errText, type Episode } from "./api";
import { tNow } from "./i18n";
import { useJobs } from "./jobs";
import { resolveChatModel } from "./modelResolve";
import { useStore } from "../store";

export interface GuideJob {
  summary: string | null;
  streaming: string | null;
  error: string | null;
  needsSetup: boolean;
  loaded: boolean;
  shared?: boolean;
  checking?: boolean;
}

const empty = (): GuideJob => ({
  summary: null,
  streaming: null,
  error: null,
  needsSetup: false,
  loaded: false,
  shared: false,
  checking: false,
});

export const useGuides = create<Record<string, GuideJob>>(() => ({}));

function put(id: string, p: Partial<GuideJob>) {
  useGuides.setState((s) => ({ [id]: { ...(s[id] ?? empty()), ...p } }));
}

const aborts = new Map<string, { stop: boolean; unlisten: () => void; jobId: string }>();

export async function ensureGuide(ep: Episode) {
  if (useGuides.getState()[ep.id]?.streaming != null) return;
  try {
    const [v, from] = await Promise.all([
      api.getBlob(ep.id, "summary"),
      api.getBlob(ep.id, "summary-from"),
    ]);
    if (useGuides.getState()[ep.id]?.streaming != null) return;
    if (v) {
      put(ep.id, { summary: v, shared: from === "shared", loaded: true, checking: false });
      return;
    }
    put(ep.id, { summary: null, shared: false, checking: true, loaded: true });
    const hit = await api.sharedGuide(ep.id).catch(() => null);
    if (useGuides.getState()[ep.id]?.streaming != null) return;
    put(ep.id, {
      checking: false,
      ...(hit ? { summary: hit, shared: true } : { summary: null, shared: false }),
    });
  } catch {
    put(ep.id, { summary: null, loaded: true, checking: false, shared: false });
  }
}

export async function runGuide(ep: Episode) {
  if (useGuides.getState()[ep.id]?.streaming != null) return;
  const settings = useStore.getState().settings;
  const provider = settings.providers[settings.chatProvider];
  const transcript = useJobs.getState().transcripts[ep.id];
  const translation = useJobs.getState().translations[ep.id];

  if (!transcript?.segments.length) {
    put(ep.id, { error: tNow("需要先有字幕才能生成导读"), needsSetup: false });
    return;
  }
  const modelName = resolveChatModel(settings, provider);
  if (!provider || !modelName) {
    put(ep.id, { error: tNow("请先在设置里选择模型"), needsSetup: true });
    return;
  }
  if (provider.needsKey && !(await api.hasApiKey(provider.id))) {
    put(ep.id, { error: tNow("请先在设置里填写「{name}」的 API Key", { name: provider.name }), needsSetup: true });
    return;
  }

  put(ep.id, { error: null, needsSetup: false, streaming: "", shared: false, checking: false });
  let unlisten = () => {};
  const jobId = `guide:${ep.id}:${Date.now()}`;
  const handle = { stop: false, unlisten, jobId };
  aborts.set(ep.id, handle);
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
      const prev = useGuides.getState()[ep.id]?.streaming ?? "";
      put(ep.id, { streaming: prev + chunk });
    });
    handle.unlisten = unlisten;
    const context = transcriptForModel(transcript.segments, translation?.items);
    const length = transcript.segments[transcript.segments.length - 1]?.end ?? ep.duration ?? undefined;
    const full = await api.llmChat({
      provider: provider.id,
      baseUrl: provider.baseUrl,
      model: modelName,
      protocol: provider.protocol,
      stream: true,
      jobId,
      messages: [
        {
          role: "system",
          content: qaSystem(ep.title, ep.showTitle ?? "", context),
        },
        { role: "user", content: summaryPrompt(length ?? undefined) },
      ],
    });
    if (handle.stop) return;
    const streamed = useGuides.getState()[ep.id]?.streaming ?? "";
    const out = (full.trim() || streamed).trim();
    if (!out) throw new Error(tNow("模型没有返回内容，请重试或换一个模型"));
    put(ep.id, { summary: out, loaded: true, shared: false });
    await api.setBlob(ep.id, "summary", out);
    void api.shareGuide(ep.id, out, `${provider.name} · ${modelName}`).catch(() => {});
  } catch (e) {
    if (!handle.stop) put(ep.id, { error: errText(e), needsSetup: /设置|API Key|模型|Settings|model/i.test(errText(e)) });
  } finally {
    unlisten();
    aborts.delete(ep.id);
    put(ep.id, { streaming: null });
  }
}

export function stopGuide(episodeId: string) {
  const h = aborts.get(episodeId);
  if (!h) return;
  h.stop = true;
  h.unlisten();
  void api.cancelJob(h.jobId).catch(() => {});
  const partial = useGuides.getState()[episodeId]?.streaming?.trim();
  if (partial) {
    put(episodeId, { summary: partial, streaming: null, loaded: true });
    void api.setBlob(episodeId, "summary", partial);
  } else {
    put(episodeId, { streaming: null });
  }
}
