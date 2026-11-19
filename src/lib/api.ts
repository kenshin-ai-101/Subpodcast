/**
 * [INPUT]: @tauri-apps/api invoke
 * [OUTPUT]: 类型化后端命令封装（含 shared_guide / share_guide / tts_speak / shared_transcript / saveDownload）
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
  /** 入库单集总数；侧栏角标与详情「全部」同源。 */
  episodeCount?: number;
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
  /** 乔木精读 / 改写长文可用。 */
  deep?: boolean;
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
  /** 回答所用模型标注，如「DeepSeek · deepseek-chat」。 */
  model?: string;
}

export interface ListenRow {
  day: string;
  hour: number;
  episodeId: string;
  showId: string;
  seconds: number;
  translated: boolean;
  showTitle: string;
  kind: string;
  cover: string;
  episodeTitle: string;
  video: boolean;
  duration: number;
  progress: number;
  published: number;
}

export interface PreviewShow {
  show: Show;
  episodes: Episode[];
  fetchedAt: number;
}

export const api = {
  addSubscription: (input: string) => invoke<Show>("add_subscription", { input }),
  refreshShow: (showId: string) => invoke<number>("refresh_show", { showId }),
  refreshAll: () => invoke<number>("refresh_all"),
  listShows: () => invoke<Show[]>("list_shows"),
  listEpisodes: (showId?: string | null, limit = 100) =>
    invoke<Episode[]>("list_episodes", { showId: showId ?? null, limit }),
  recentEpisodes: () => invoke<Episode[]>("recent_episodes"),
  logListen: (episodeId: string, showId: string, seconds: number, translated: boolean) =>
    invoke<void>("log_listen", { episodeId, showId, seconds, translated }),
  listeningStats: (since: string) => invoke<ListenRow[]>("listening_stats", { since }),
  previewShow: (input: string) => invoke<PreviewShow>("preview_show", { input }),
  cachedShow: (input: string) => invoke<PreviewShow | null>("cached_show", { input }),
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
  youtubeTracks: (episodeId: string) =>
    invoke<{ language: string; auto: boolean }[]>("youtube_tracks", { episodeId }),
  useYoutubeTrack: (episodeId: string, language: string, auto: boolean) =>
    invoke<Transcript>("use_youtube_track", { episodeId, language, auto }),
  sharedTranscript: (episodeId: string) =>
    invoke<Transcript | null>("shared_transcript", { episodeId }),
  sharedExists: (episodeIds: string[]) => invoke<string[]>("shared_exists", { episodeIds }),
  shareTranslation: (episodeId: string, engine: string, model: string) =>
    invoke<string>("share_translation", { episodeId, engine, model }),
  sharedGuide: (episodeId: string) => invoke<string | null>("shared_guide", { episodeId }),
  shareGuide: (episodeId: string, text: string, model: string) =>
    invoke<string>("share_guide", { episodeId, text, model }),
  ttsSpeak: (text: string, voice: string, resource?: string) =>
    invoke<string>("tts_speak", { text, voice, resource: resource ?? null }),
  getBlob: (episodeId: string, kind: string) => invoke<string | null>("get_blob", { episodeId, kind }),
  setBlob: (episodeId: string, kind: string, data: string) => invoke<void>("set_blob", { episodeId, kind, data }),
  qiaomuDetail: (episodeId: string) =>
    invoke<{ audio?: string | null; deepRead?: string | null }>("qiaomu_detail", { episodeId }),
  downloadEpisode: (episodeId: string) =>
    invoke<{ episodeId: string; path: string; bytes: number; savedAt: number }>("download_episode", {
      episodeId,
    }),
  listDownloads: () =>
    invoke<{ episodeId: string; path: string; bytes: number; savedAt: number }[]>("list_downloads"),
  deleteDownload: (episodeId: string) => invoke<void>("delete_download", { episodeId }),
  cancelJob: (id: string) => invoke<void>("cancel_job", { id }),
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
  translateTexts: (texts: string[], target?: string) =>
    invoke<string[]>("translate_texts", { texts, target: target ?? null }),
  cloudTranscribe: (req: {
    episodeId: string;
    audioUrl: string;
    provider: string;
    baseUrl: string;
    model: string;
    language?: string;
  }) => invoke<Transcript>("cloud_transcribe", { req }),
  localTranscribe: (req: { episodeId: string; model: string; language?: string }) =>
    invoke<Transcript>("local_transcribe", { req }),
  asrModels: () =>
    invoke<
      {
        id: string;
        name: string;
        engine: string;
        sizeMb: number;
        note: string;
        installed: boolean;
        from?: string | null;
      }[]
    >("asr_models"),
  rescanAsrModels: () =>
    invoke<
      {
        id: string;
        name: string;
        engine: string;
        sizeMb: number;
        note: string;
        installed: boolean;
        from?: string | null;
      }[]
    >("rescan_asr_models"),
  downloadAsrModel: (id: string, mirrorFirst?: boolean) =>
    invoke<void>("download_asr_model", { id, mirrorFirst: mirrorFirst ?? true }),
  deleteAsrModel: (id: string) => invoke<void>("delete_asr_model", { id }),
  listModels: (req: { provider: string; baseUrl: string; protocol: string }) =>
    invoke<string[]>("list_models", { req }),
  exportOpml: () => invoke<string>("export_opml"),
  /** 写到系统「下载」；binary 时 data 为 base64。 */
  saveDownload: (name: string, data: string, binary = false) =>
    invoke<string>("save_download", { name, data, binary }),
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
