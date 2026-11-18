/**
 * [INPUT]: api、settings；监听无（翻译/问答在组件内）
 * [OUTPUT]: 字幕加载瀑布、翻译任务状态
 * [POS]: 跨屏幕长任务；官方字幕 → 空状态 → 用户触发云端识别
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { create } from "zustand";
import { api, errText, type Episode, type Transcript } from "./api";
import { activeCloudAsr } from "./settings";
import { useStore } from "../store";

export type OfficialState = "idle" | "searching" | "found" | "none" | "error";

interface Jobs {
  transcripts: Record<string, Transcript | null | undefined>;
  official: Record<string, OfficialState>;
  officialError: Record<string, string>;
  translations: Record<string, { items: (string | null)[]; running: boolean; error?: string }>;
  asrRunning: Record<string, boolean>;
}

export const useJobs = create<Jobs>(() => ({
  transcripts: {},
  official: {},
  officialError: {},
  translations: {},
  asrRunning: {},
}));

function patch<K extends keyof Jobs>(key: K, id: string, value: Jobs[K][string]) {
  useJobs.setState((s) => ({ [key]: { ...s[key], [id]: value } }) as Partial<Jobs>);
}

/** 缓存 → 官方字幕；都没有才标 none，不自动下载模型。 */
export async function ensureTranscript(ep: Episode) {
  const s = useJobs.getState();
  if (s.transcripts[ep.id] || s.official[ep.id] === "searching") return;
  const cached = await api.loadTranscript(ep.id);
  if (cached?.segments?.length) {
    patch("transcripts", ep.id, cached);
    patch("official", ep.id, "found");
    return;
  }
  if (!ep.videoId && !ep.transcriptUrl) {
    patch("official", ep.id, "none");
    return;
  }
  patch("official", ep.id, "searching");
  try {
    const t = await api.fetchOfficialTranscript(ep.id);
    if (t?.segments?.length) {
      patch("transcripts", ep.id, t);
      patch("official", ep.id, "found");
    } else {
      patch("official", ep.id, "none");
    }
  } catch (e) {
    patch("officialError", ep.id, errText(e));
    patch("official", ep.id, "error");
  }
}

export function looksChinese(language: string, sample: string) {
  if (language.toLowerCase().startsWith("zh")) return true;
  const hits = (sample.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return hits >= 4;
}

export async function translateEpisode(ep: Episode, t: Transcript) {
  const settings = useStore.getState().settings;
  const total = t.segments.length;
  const raw = await api.getBlob(ep.id, "zh");
  let items: (string | null)[] = [];
  try {
    items = raw ? JSON.parse(raw) : [];
  } catch {
    items = [];
  }
  if (items.length !== total) items = Array.from({ length: total }, (_, i) => items[i] ?? null);
  if (items.every(Boolean)) {
    patch("translations", ep.id, { items, running: false });
    return;
  }
  patch("translations", ep.id, { items, running: true });
  const useLlm = settings.translateMode !== "google";
  const provider = settings.providers[settings.translateProvider] ?? settings.providers[settings.chatProvider];
  const missing = t.segments.map((s, i) => ({ i, text: s.text })).filter((x) => !items[x.i]);
  const BATCH = 6;
  try {
    for (let i = 0; i < missing.length; i += BATCH) {
      const chunk = missing.slice(i, i + BATCH);
      const texts = chunk.map((c) => c.text);
      const out = await api.translateBatch({
        texts,
        target: "zh-CN",
        engine: useLlm ? "llm" : "google",
        provider: provider?.id,
        baseUrl: provider?.baseUrl,
        model: provider?.model,
        protocol: provider?.protocol,
      });
      chunk.forEach((c, j) => {
        items[c.i] = out[j] ?? null;
      });
      patch("translations", ep.id, { items: [...items], running: true });
    }
    await api.setBlob(ep.id, "zh", JSON.stringify(items));
    patch("translations", ep.id, { items, running: false });
  } catch (e) {
    patch("translations", ep.id, { items, running: false, error: errText(e) });
  }
}

export async function runCloudAsr(ep: Episode) {
  if (!ep.audioUrl) throw new Error("这集没有音频地址，无法云端识别");
  const settings = useStore.getState().settings;
  const cloud = activeCloudAsr(settings);
  if (!cloud) throw new Error("请先在设置 › 字幕里选择云端识别服务");
  patch("asrRunning", ep.id, true);
  try {
    const t = await api.cloudTranscribe({
      episodeId: ep.id,
      audioUrl: ep.audioUrl,
      provider: cloud.needsKey ? `asr.${cloud.id}` : cloud.id,
      baseUrl: cloud.baseUrl,
      model: cloud.model,
      language: "auto",
    });
    patch("transcripts", ep.id, t);
    patch("official", ep.id, "found");
    patch("translations", ep.id, { items: [], running: false });
  } finally {
    patch("asrRunning", ep.id, false);
  }
}
