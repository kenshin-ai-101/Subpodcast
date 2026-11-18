/**
 * [INPUT]: @tauri-apps/api invoke
 * [OUTPUT]: 类型化后端命令封装
 * [POS]: 前后端边界；字段名与 Rust camelCase 对齐
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { invoke } from "@tauri-apps/api/core";

export interface Show {
  id: string;
  kind: "youtube" | "podcast" | "xiaoyuzhou" | "single" | string;
  title: string;
  author?: string | null;
  cover?: string | null;
  feedUrl: string;
  link?: string | null;
  description?: string | null;
  updatedAt: number;
  unplayed?: number;
}

export interface Episode {
  id: string;
  showId: string;
  guid: string;
  title: string;
  published?: number | null;
  duration?: number | null;
  audioUrl?: string | null;
  videoId?: string | null;
  link?: string | null;
  cover?: string | null;
  notes?: string | null;
  transcriptUrl?: string | null;
  transcriptType?: string | null;
  progress: number;
  hasTranscript: boolean;
  showTitle?: string | null;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  episodeId: string;
  source: string;
  language: string;
  segments: Segment[];
}

export interface ChatMessage {
  role: string;
  content: string;
}

export const api = {
  addSubscription: (input: string) => invoke<Show>("add_subscription", { input }),
  refreshShow: (showId: string) => invoke<number>("refresh_show", { showId }),
  refreshAll: () => invoke<number>("refresh_all"),
  listShows: () => invoke<Show[]>("list_shows"),
  listEpisodes: (showId?: string | null, limit = 100) =>
    invoke<Episode[]>("list_episodes", { showId: showId ?? null, limit }),
  getEpisode: (episodeId: string) => invoke<Episode | null>("get_episode", { episodeId }),
  removeShow: (showId: string) => invoke<void>("remove_show", { showId }),
  setProgress: (episodeId: string, progress: number) => invoke<void>("set_progress", { episodeId, progress }),
  searchPodcasts: (term: string, country?: string) =>
    invoke<Show[]>("search_podcasts", { term, country: country ?? null }),
  youtubeSubscriptions: (browser: string) =>
    invoke<{ id: string; title: string; thumbnail: string }[]>("youtube_subscriptions", { browser }),
  openPrivacySettings: () => invoke<void>("open_privacy_settings"),
  loadTranscript: (episodeId: string) => invoke<Transcript | null>("load_transcript", { episodeId }),
  fetchOfficialTranscript: (episodeId: string) =>
    invoke<Transcript | null>("fetch_official_transcript", { episodeId }),
  getBlob: (episodeId: string, kind: string) => invoke<string | null>("get_blob", { episodeId, kind }),
  setBlob: (episodeId: string, kind: string, data: string) => invoke<void>("set_blob", { episodeId, kind, data }),
  getSettings: () => invoke<string | null>("get_settings"),
  setSettings: (value: string) => invoke<void>("set_settings", { value }),
  setApiKey: (provider: string, key: string) => invoke<void>("set_api_key", { provider, key }),
  hasApiKey: (provider: string) => invoke<boolean>("has_api_key", { provider }),
  llmChat: (req: {
    provider: string;
    baseUrl: string;
    model: string;
    protocol: string;
    messages: ChatMessage[];
    stream?: boolean;
  }) => invoke<string>("llm_chat", { req }),
  translateBatch: (req: {
    texts: string[];
    target?: string;
    engine?: string;
    provider?: string;
    baseUrl?: string;
    model?: string;
    protocol?: string;
  }) => invoke<string[]>("translate_batch", { req }),
  cloudTranscribe: (req: {
    episodeId: string;
    audioUrl: string;
    provider: string;
    baseUrl: string;
    model: string;
    language?: string;
  }) => invoke<Transcript>("cloud_transcribe", { req }),
  listModels: (req: { provider: string; baseUrl: string; protocol: string }) =>
    invoke<string[]>("list_models", { req }),
  exportOpml: () => invoke<string>("export_opml"),
  storageInfo: () =>
    invoke<{ downloads: number; models: number; library: number; temp: number }>("storage_info"),
  openDataFolder: (kind: string) => invoke<void>("open_data_folder", { kind }),
  clearTemp: () => invoke<void>("clear_temp"),
};

export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
