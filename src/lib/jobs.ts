/**
 * [INPUT]: api、settings；event asr；asrModels；store.time（播放头优先机翻）；offline.loadDownloads
 * [OUTPUT]: ensureTranscript、autoTranslate、translateEpisode、generateTranscript、switchYoutubeTrack、llmReady
 * [POS]: 跨屏幕长任务；缓存→官方（含 twin 回填）→共享库→空态→用户触发识别；ASR 落盘后刷新离线清单；机翻播放头优先
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api, errText, type Episode, type Segment, type Transcript } from "./api";
import { useAsrModels } from "./asrModels";
import { tNow } from "./i18n";
import { resolveChatModel } from "./modelResolve";
import { loadDownloads } from "./offline";
import { activeCloudAsr } from "./settings";
import { loadAlign } from "./timemap";
import { useStore } from "../store";

export type OfficialState = "idle" | "searching" | "found" | "none" | "error";
export type TranslateEngine = "google" | "llm" | "youtube" | "shared";

const RATE_LIMIT = /429|rate.?limit|quota|too many|限流|超限/i;
const FATAL = /401|403|invalid.?api|api.?key|未配置|没有.?key/i;
const BATCH = 6;

type Batch = { ids: number[] };

const controllers = new Map<string, AbortController>();
const saveTimers = new Map<string, number>();

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const t = window.setTimeout(() => resolve(), ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function toBatches(total: number, items: (string | null)[]): Batch[] {
  const missing = Array.from({ length: total }, (_, i) => i).filter((i) => items[i] == null);
  const out: Batch[] = [];
  for (let i = 0; i < missing.length; i += BATCH) {
    out.push({ ids: missing.slice(i, i + BATCH) });
  }
  return out;
}

function concurrencyLimits(engine: TranslateEngine): { start: number; max: number } {
  return engine === "google" ? { start: 2, max: 2 } : { start: 2, max: 4 };
}

export type AsrProgress = {
  stage: string;
  progress: number;
  message?: string;
  live?: Segment[];
};

export type TranslationJob = {
  items: (string | null)[];
  running: boolean;
  error?: string;
  engine?: TranslateEngine;
};

interface Jobs {
  transcripts: Record<string, Transcript | null | undefined>;
  official: Record<string, OfficialState>;
  officialError: Record<string, string>;
  translations: Record<string, TranslationJob>;
  asrRunning: Record<string, boolean>;
  asrProgress: Record<string, AsrProgress | undefined>;
  asrError: Record<string, string | undefined>;
}

export const useJobs = create<Jobs>(() => ({
  transcripts: {},
  official: {},
  officialError: {},
  translations: {},
  asrRunning: {},
  asrProgress: {},
  asrError: {},
}));

let asrListening = false;

async function ensureAsrListen() {
  if (asrListening) return;
  asrListening = true;
  await listen<{
    episodeId: string;
    stage: string;
    progress: number;
    message?: string | null;
    segment?: Segment;
  }>("asr", (e) => {
    const { episodeId, stage, progress, message, segment } = e.payload;
    const cur = useJobs.getState().asrProgress[episodeId];
    const live = cur?.live ? [...cur.live] : [];
    if (segment?.text) live.push(segment);
    patch("asrProgress", episodeId, {
      stage,
      progress,
      message: message ?? undefined,
      live: live.length ? live : undefined,
    });
  });
}

function patch<K extends keyof Jobs>(key: K, id: string, value: Jobs[K][string]) {
  useJobs.setState((s) => ({ [key]: { ...s[key], [id]: value } }) as Partial<Jobs>);
}

/** 中文节目标题却缓存了非中文 YouTube 轨：需要重拉（用户手动选轨除外）。 */
function staleYoutubeCache(ep: Episode, cached: Transcript): boolean {
  if (!cached.source.startsWith("youtube")) return false;
  if (!/[\u4e00-\u9fff].*[\u4e00-\u9fff]/.test(ep.title)) return false;
  if (/[\u3040-\u30ff]/.test(ep.title)) return false;
  return !cached.language.toLowerCase().startsWith("zh");
}

/** 官方拉成功后丢掉内存译文，好重新读 blob zh（含节目方中文）。 */
function forgetTranslation(id: string) {
  useJobs.setState((s) => {
    const translations = { ...s.translations };
    delete translations[id];
    return { translations };
  });
}

function acceptTranscript(epId: string, t: Transcript) {
  forgetTranslation(epId);
  patch("transcripts", epId, t);
  patch("official", epId, "found");
}

/** 缓存 → 官方 → 共享库；都没有才标 none。出错时仍回落缓存/共享库。 */
export async function ensureTranscript(ep: Episode) {
  const s = useJobs.getState();
  // 已有内存字幕（含空对象以外的命中）或正在搜，不重复进
  if (s.transcripts[ep.id] || s.official[ep.id] === "searching") return;

  let cached: Awaited<ReturnType<typeof api.loadTranscript>> = null;
  try {
    cached = await api.loadTranscript(ep.id);
  } catch {
    cached = null;
  }

  const stale = !!(cached?.segments?.length && staleYoutubeCache(ep, cached));
  if (cached?.segments?.length && !stale) {
    acceptTranscript(ep.id, cached);
    return;
  }
  if (stale) {
    const picked = await api.getBlob(ep.id, "track-picked").catch(() => null);
    if (picked) {
      acceptTranscript(ep.id, cached!);
      return;
    }
  }

  patch("official", ep.id, "searching");
  patch("officialError", ep.id, "");

  const fromShared = async () => {
    const sh = await api.sharedTranscript(ep.id).catch(() => null);
    if (sh?.segments?.length) {
      acceptTranscript(ep.id, sh);
      return true;
    }
    return false;
  };

  // 即使前端看不到 videoId，也要调官方拉取：Rust 会给词元等双形态回填 YouTube 轨
  try {
    const t = await api.fetchOfficialTranscript(ep.id);
    if (t?.segments?.length) {
      acceptTranscript(ep.id, t);
      if (stale && !t.language.toLowerCase().startsWith("zh")) {
        void api.setBlob(ep.id, "track-picked", "auto");
      }
      return;
    }
    try {
      cached = await api.loadTranscript(ep.id);
    } catch {
      cached = null;
    }
    if (cached?.segments?.length) {
      acceptTranscript(ep.id, cached);
      return;
    }
    if (!(await fromShared())) {
      patch("transcripts", ep.id, null);
      patch("official", ep.id, "none");
    }
  } catch (e) {
    try {
      cached = await api.loadTranscript(ep.id);
    } catch {
      cached = null;
    }
    if (cached?.segments?.length) {
      acceptTranscript(ep.id, cached);
      return;
    }
    if (await fromShared()) return;
    patch("transcripts", ep.id, null);
    patch("officialError", ep.id, errText(e));
    patch("official", ep.id, "error");
  }
}

export function looksChinese(language: string, sample: string) {
  if (language.toLowerCase().startsWith("zh")) return true;
  const hits = (sample.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return hits >= 4;
}

export function needsTranslation(t: Transcript) {
  return !looksChinese(
    t.language,
    t.segments.slice(0, 5).map((s) => s.text).join(""),
  );
}

export async function loadTranslation(id: string, total: number) {
  if (useJobs.getState().translations[id]) return;
  const raw = await api.getBlob(id, "zh");
  let items: (string | null)[] = [];
  try {
    items = raw ? JSON.parse(raw) : [];
  } catch {
    items = [];
  }
  if (items.length !== total) items = Array.from({ length: total }, (_, i) => items[i] ?? null);
  const engine = ((await api.getBlob(id, "zh-engine")) as TranslateEngine | null) ?? undefined;
  patch("translations", id, { items, running: false, engine });
}

/** 外语字幕就绪后自动补中文；原文模式不跑。节目方中文轨只填缺口。 */
export function autoTranslate(ep: Episode) {
  const t = useJobs.getState().transcripts[ep.id];
  if (!t?.segments.length) return;
  if (useStore.getState().settings.subtitleMode === "original") return;
  if (!needsTranslation(t)) return;
  void loadTranslation(ep.id, t.segments.length).then(() => {
    const job = useJobs.getState().translations[ep.id];
    if (!job || job.running || job.error || job.items.every((x) => x != null)) return;
    void translateEpisode(ep, t).catch((e) =>
      patch("translations", ep.id, {
        ...useJobs.getState().translations[ep.id],
        running: false,
        error: errText(e),
      }),
    );
  });
}

export async function translateEpisode(ep: Episode, t: Transcript, force?: TranslateEngine) {
  const settings = useStore.getState().settings;
  const total = t.segments.length;
  await loadTranslation(ep.id, total);
  const job = useJobs.getState().translations[ep.id];
  if (job.running) return;

  const useLlm = force === "llm" || (force !== "google" && settings.translateMode !== "google");
  const engine: TranslateEngine =
    force === "youtube" ? "youtube" : useLlm ? "llm" : "google";
  const keep =
    (job.engine === "youtube" || job.engine === "shared") && force == null;
  let items =
    job.engine && job.engine !== engine && !keep
      ? t.segments.map(() => null)
      : [...job.items];
  const label: TranslateEngine = keep ? job.engine! : engine;
  if (items.every((x) => x != null)) {
    patch("translations", ep.id, { items, running: false, engine: label });
    return;
  }

  controllers.get(ep.id)?.abort();
  const controller = new AbortController();
  controllers.set(ep.id, controller);
  const { signal } = controller;

  patch("translations", ep.id, { items, running: true, engine: label });
  void api.setBlob(ep.id, "zh-engine", label);

  const provider =
    settings.providers[settings.translateProvider] ?? settings.providers[settings.chatProvider];
  const queue = toBatches(total, items);
  const save = () => {
    window.clearTimeout(saveTimers.get(ep.id));
    saveTimers.set(
      ep.id,
      window.setTimeout(() => {
        const cur = useJobs.getState().translations[ep.id];
        if (cur) void api.setBlob(ep.id, "zh", JSON.stringify(cur.items));
      }, 800),
    );
  };
  const merge = (got: Map<number, string>) => {
    const cur = useJobs.getState().translations[ep.id];
    if (!cur || signal.aborted) return;
    items = [...cur.items];
    for (const [i, text] of got) items[i] = text;
    patch("translations", ep.id, { ...cur, items });
    save();
  };
  const next = (): Batch | undefined => {
    const s = useStore.getState();
    const now = s.current?.id === ep.id ? s.time : 0;
    let best = -1;
    let bestCost = Infinity;
    queue.forEach((b, i) => {
      const at = t.segments[b.ids[0]]!.start;
      const end = t.segments[b.ids[b.ids.length - 1]!]!.end;
      const cost = end < now ? (now - end) * 2 : Math.max(0, at - now);
      if (cost < bestCost) {
        bestCost = cost;
        best = i;
      }
    });
    return best < 0 ? undefined : queue.splice(best, 1)[0];
  };

  const limits = concurrencyLimits(engine);
  let limit = limits.start;
  let active = 0;
  let streak = 0;
  let limited = 0;
  let lastError = "";

  const one = async (b: Batch) => {
    try {
      if (engine === "google") {
        const out = await api.translateTexts(b.ids.map((i) => t.segments[i]!.text));
        merge(new Map(b.ids.map((id, j) => [id, out[j] ?? ""])));
      } else {
        const texts = b.ids.map((i) => t.segments[i]!.text);
        const out = await api.translateBatch({
          texts,
          target: "zh-CN",
          engine: "llm",
          quality: settings.translateQuality,
          provider: provider?.id,
          baseUrl: provider?.baseUrl,
          model: provider?.model,
          protocol: provider?.protocol,
        });
        merge(new Map(b.ids.map((id, j) => [id, out[j] ?? ""])));
      }
      limited = 0;
      if (++streak >= 20 && limit < limits.max) {
        limit++;
        streak = 0;
      }
    } catch (err) {
      if (signal.aborted) return;
      lastError = errText(err);
      if (RATE_LIMIT.test(lastError) && limited < 6) {
        limited++;
        streak = 0;
        limit = Math.max(1, Math.floor(limit / 2));
        queue.unshift(b);
        await sleep(1000 * 2 ** limited + Math.random() * 1000, signal).catch(() => undefined);
        return;
      }
      if (FATAL.test(lastError) || RATE_LIMIT.test(lastError)) {
        controller.abort();
        return;
      }
      if (b.ids.length >= 4) {
        const h = Math.ceil(b.ids.length / 2);
        queue.push({ ids: b.ids.slice(0, h) }, { ids: b.ids.slice(h) });
      }
    }
  };

  await new Promise<void>((done) => {
    const pump = () => {
      if (signal.aborted && active === 0) return done();
      while (!signal.aborted && active < limit && queue.length) {
        const b = next()!;
        active++;
        void one(b).finally(() => {
          active--;
          pump();
        });
      }
      if (active === 0 && (!queue.length || signal.aborted)) done();
    };
    pump();
  });

  controllers.delete(ep.id);
  const final = useJobs.getState().translations[ep.id];
  if (!final) return;
  await api.setBlob(ep.id, "zh", JSON.stringify(final.items));
  patch("translations", ep.id, {
    ...final,
    running: false,
    error: signal.aborted ? lastError || undefined : undefined,
  });
  if (
    !signal.aborted &&
    (engine === "llm" || engine === "google") &&
    !keep &&
    final.items.every((x) => x != null)
  ) {
    void api
      .shareTranslation(ep.id, engine, engine === "llm" ? provider?.model ?? "" : "")
      .catch(() => {});
  }
}

export function stopTranslation(id: string) {
  controllers.get(id)?.abort();
}

/** 换 YouTube 字幕语言；清译文缓存后按新轨重走 autoTranslate。 */
export async function switchYoutubeTrack(ep: Episode, language: string, auto: boolean) {
  stopTranslation(ep.id);
  const t = await api.useYoutubeTrack(ep.id, language, auto);
  useJobs.setState((s) => {
    const translations = { ...s.translations };
    delete translations[ep.id];
    return {
      translations,
      transcripts: { ...s.transcripts, [ep.id]: t },
      official: { ...s.official, [ep.id]: "found" as OfficialState },
    };
  });
  const st = useStore.getState();
  if (st.current?.id === ep.id) {
    void loadAlign(ep.id, !ep.videoId || st.audioOnly);
  }
  autoTranslate(ep);
}

/** @deprecated 用 generateTranscript；保留别名以免旧调用断裂 */
export async function runCloudAsr(ep: Episode) {
  return generateTranscript(ep);
}

/** 按设置走本机（Qwen3/Whisper）或云端；缺本机模型时先下载。 */
export async function generateTranscript(ep: Episode) {
  const settings = useStore.getState().settings;
  const local = settings.asrEngine === "local";
  if (!ep.audioUrl && !ep.videoId) throw new Error(tNow("这集没有可识别的音频"));

  await ensureAsrListen();
  patch("asrRunning", ep.id, true);
  patch("asrError", ep.id, undefined);
  patch("asrProgress", ep.id, { stage: "prepare", progress: 0, message: tNow("准备中…") });

  try {
    let t: Transcript;
    if (local) {
      const modelId = settings.asrModel || "qwen3-asr";
      await useAsrModels.getState().refresh();
      let info = useAsrModels.getState().models.find((m) => m.id === modelId);
      if (!info?.installed) {
        await useAsrModels.getState().rescan();
        info = useAsrModels.getState().models.find((m) => m.id === modelId);
      }
      if (!info?.installed) {
        patch("asrProgress", ep.id, { stage: "download", progress: 0, message: tNow("下载本机模型…") });
        await useAsrModels.getState().download(modelId);
      }
      t = await api.localTranscribe({ episodeId: ep.id, model: modelId, language: "auto" });
    } else {
      const cloud = activeCloudAsr(settings);
      if (!cloud) throw new Error(tNow("请先在设置 › 字幕里选择云端识别服务"));
      t = await api.cloudTranscribe({
        episodeId: ep.id,
        audioUrl: ep.audioUrl ?? undefined,
        provider: cloud.needsKey ? `asr.${cloud.id}` : cloud.id,
        baseUrl: cloud.baseUrl,
        model: cloud.model,
        language: "auto",
      });
    }
    patch("transcripts", ep.id, t);
    patch("official", ep.id, "found");
    patch("translations", ep.id, { items: [], running: false });
    patch("asrProgress", ep.id, { stage: "done", progress: 1 });
    // ASR 可能将播客音频写入 audio-cache/：刷新清单，并同步重置/载入当前集时间映射
    void loadDownloads();
    const st = useStore.getState();
    if (st.current?.id === ep.id) {
      void loadAlign(ep.id, !ep.videoId || st.audioOnly);
    }
    autoTranslate(ep);
  } catch (e) {
    const msg = errText(e);
    patch("asrError", ep.id, msg);
    patch("asrProgress", ep.id, { stage: "error", progress: 0, message: msg });
    throw e;
  } finally {
    patch("asrRunning", ep.id, false);
  }
}

export async function cancelAsr(epId: string) {
  await api.cancelJob(epId);
}

/** 问答/导读用的模型是否已就绪（有模型，且需要 Key 时已填）。 */
export async function llmReady(use: "chat" | "translate" = "chat"): Promise<boolean> {
  const settings = useStore.getState().settings;
  if (use === "translate" && settings.translateMode === "google") return false;
  const p =
    use === "translate"
      ? (settings.providers[settings.translateProvider] ?? settings.providers[settings.chatProvider])
      : settings.providers[settings.chatProvider];
  const model = use === "chat" ? resolveChatModel(settings, p) : (p?.model ?? "");
  return Boolean(model && p && p.baseUrl !== "" && (!p.needsKey || (await api.hasApiKey(p.id))));
}
