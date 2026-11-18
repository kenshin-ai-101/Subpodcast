/**
 * [INPUT]: api.getSettings / setSettings
 * [OUTPUT]: Settings、PRESETS、ASR_SERVICES、读写与迁移
 * [POS]: 用户偏好；Key 在钥匙串；字段布局对齐 SubCast 设置三栏
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { api } from "./api";

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  protocol: "openai" | "anthropic";
  needsKey: boolean;
  keyUrl?: string;
  models?: string[];
  group?: "relay" | "provider" | "local";
}

/** 云端识别（MVP 仅 OpenAI 兼容 /audio/transcriptions）。 */
export interface CloudAsr {
  id: string;
  name: string;
  note: string;
  protocol: "openai";
  baseUrl: string;
  model: string;
  models: string[];
  keyUrl?: string;
  needsKey: boolean;
}

export type SubtitleMode = "bilingual" | "original" | "translation";
export type SettingsSection = "subtitles" | "ai" | "general";
export type LangSetting = "auto" | "zh-CN" | "zh-TW" | "en";

export interface Settings {
  providers: Record<string, Provider>;
  chatProvider: string;
  translateProvider: string;
  /** auto：跟默认模型；google：始终谷歌；llm：始终模型（迁移为 auto）。 */
  translateMode: "auto" | "google" | "llm";
  translateQuality: "fast" | "best";
  proxy: string;
  /** local，或某个 cloudAsr id。 */
  asrEngine: string;
  asrModel: string;
  cloudAsr: Record<string, CloudAsr>;
  chatModel: string;
  subtitleMode: SubtitleMode;
  subtitleSize?: "s" | "m" | "l" | "xl";
  subtitleFont?: "system" | "serif" | "kai" | "sans";
  subtitleLook?: "box" | "outline";
  chatSize?: "m" | "l";
  audioNextLine?: boolean;
  autoNext?: boolean;
  shortcuts?: Partial<Record<import("./shortcuts").ActionId, string[]>>;
  uiLang: LangSetting;
  youtubePromo: boolean;
  homeBannerHidden: boolean;
  /** 偏好记住；MVP 暂不实际上传共享库。 */
  shareTranscripts: boolean;
  /** YouTube 验证时借用哪个浏览器登录（"" = 先问我）。 */
  ytCookiesBrowser?: string;
}

type G = Provider["group"];
const o = (
  id: string,
  name: string,
  group: G,
  baseUrl: string,
  keyUrl: string | undefined,
  models: string[] = [],
  needsKey = group !== "local",
): Provider => ({
  id,
  name,
  group,
  protocol: "openai",
  baseUrl,
  model: models[0] ?? "",
  needsKey,
  keyUrl,
  models,
});

export const PRESETS: Provider[] = [
  o("deepseek", "DeepSeek", "provider", "https://api.deepseek.com/v1", "https://platform.deepseek.com/api_keys", [
    "deepseek-chat",
    "deepseek-reasoner",
  ]),
  o("siliconflow", "硅基流动", "relay", "https://api.siliconflow.cn/v1", "https://cloud.siliconflow.cn/account/ak", [
    "deepseek-ai/DeepSeek-V3",
    "Qwen/Qwen2.5-72B-Instruct",
  ]),
  o("openrouter", "OpenRouter", "relay", "https://openrouter.ai/api/v1", "https://openrouter.ai/settings/keys", [
    "anthropic/claude-sonnet-4",
  ]),
  {
    id: "anthropic",
    name: "Claude（Anthropic）",
    group: "provider",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-0",
    needsKey: true,
    keyUrl: "https://console.anthropic.com/settings/keys",
    models: ["claude-sonnet-4-0", "claude-opus-4-0", "claude-haiku-4-0"],
  },
  o("openai", "OpenAI", "provider", "https://api.openai.com/v1", "https://platform.openai.com/api-keys", [
    "gpt-4o-mini",
    "gpt-4o",
  ]),
  o("moonshot", "Kimi（月之暗面）", "provider", "https://api.moonshot.cn/v1", "https://platform.moonshot.cn/console/api-keys", [
    "moonshot-v1-auto",
    "kimi-k2",
  ]),
  o("zhipu", "智谱 GLM", "provider", "https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/usercenter/apikeys"),
  o("qwen-cn", "通义千问（百炼）", "provider", "https://dashscope.aliyuncs.com/compatible-mode/v1", "https://bailian.console.aliyun.com/?apiKey=1"),
  o("doubao", "豆包（火山方舟）", "provider", "https://ark.cn-beijing.volces.com/api/v3", "https://ai.volcengine.com/console/apikey"),
  o("groq", "Groq", "provider", "https://api.groq.com/openai/v1", "https://console.groq.com/keys"),
  o("ollama", "Ollama", "local", "http://127.0.0.1:11434/v1", undefined, ["qwen2.5", "llama3.2"], false),
  o("lmstudio", "LM Studio", "local", "http://127.0.0.1:1234/v1", undefined),
  o("custom", "其他（OpenAI 兼容）", "provider", "", undefined, [], true),
];

export const GROUPS: { id: NonNullable<G>; name: string; note: string }[] = [
  { id: "relay", name: "一个 Key 用多家模型", note: "中转平台" },
  { id: "provider", name: "模型厂商", note: "官方接口" },
  { id: "local", name: "本机运行", note: "不需要 Key" },
];

export const CLOUD_ASR_MAIN = ["openai", "groq", "siliconflow"];

export const ASR_SERVICES: CloudAsr[] = [
  {
    id: "openai",
    name: "OpenAI",
    note: "Whisper / gpt-4o-transcribe",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-transcribe",
    models: ["whisper-1", "gpt-4o-mini-transcribe", "gpt-4o-transcribe"],
    keyUrl: "https://platform.openai.com/api-keys",
    needsKey: true,
  },
  {
    id: "groq",
    name: "Groq",
    note: "Whisper large-v3，极快",
    protocol: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "whisper-large-v3-turbo",
    models: ["whisper-large-v3-turbo", "whisper-large-v3"],
    keyUrl: "https://console.groq.com/keys",
    needsKey: true,
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    note: "Qwen3-ASR 等，便宜",
    protocol: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen3-ASR-1.7B",
    models: ["Qwen/Qwen3-ASR-1.7B", "FunAudioLLM/SenseVoiceSmall"],
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    needsKey: true,
  },
  {
    id: "glm",
    name: "智谱 GLM-ASR",
    note: "中文识别",
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-asr-2512",
    models: ["glm-asr-2512"],
    keyUrl: "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys",
    needsKey: true,
  },
  {
    id: "local-server",
    name: "本机识别服务",
    note: "OpenAI 兼容的本地服务",
    protocol: "openai",
    baseUrl: "http://127.0.0.1:8765/v1",
    model: "whisper-1",
    models: ["whisper-1"],
    needsKey: false,
  },
];

export const DEFAULTS: Settings = {
  providers: Object.fromEntries(PRESETS.map((p) => [p.id, p])),
  chatProvider: "deepseek",
  translateProvider: "deepseek",
  translateMode: "auto",
  translateQuality: "fast",
  proxy: "",
  asrEngine: "openai",
  asrModel: "gpt-4o-mini-transcribe",
  cloudAsr: Object.fromEntries(ASR_SERVICES.map((a) => [a.id, a])),
  chatModel: "",
  subtitleMode: "bilingual",
  subtitleSize: "m",
  subtitleFont: "sans",
  subtitleLook: "outline",
  chatSize: "m",
  audioNextLine: false,
  autoNext: false,
  uiLang: "auto",
  youtubePromo: true,
  homeBannerHidden: false,
  shareTranscripts: false,
  ytCookiesBrowser: "",
};

/** 当前选用的云端识别配置。 */
export function activeCloudAsr(s: Settings): CloudAsr | null {
  if (s.asrEngine === "local") return null;
  return s.cloudAsr[s.asrEngine] ?? ASR_SERVICES.find((a) => a.id === s.asrEngine) ?? null;
}

export async function loadSettings(): Promise<Settings> {
  const raw = await api.getSettings();
  if (!raw) return structuredClone(DEFAULTS);
  try {
    const parsed = JSON.parse(raw) as Partial<Settings> & {
      translateEngine?: string;
      asrProvider?: string;
      asrBaseUrl?: string;
    };
    const providers: Record<string, Provider> = {};
    for (const p of PRESETS) {
      providers[p.id] = {
        ...p,
        ...(parsed.providers?.[p.id] ?? {}),
        keyUrl: p.keyUrl,
        models: p.models,
        needsKey: p.needsKey,
        name: p.name,
        group: p.group,
      };
    }
    const cloudAsr: Record<string, CloudAsr> = {};
    for (const a of ASR_SERVICES) {
      cloudAsr[a.id] = {
        ...a,
        ...(parsed.cloudAsr?.[a.id] ?? {}),
        name: a.name,
        note: a.note,
        models: a.models,
        keyUrl: a.keyUrl,
        needsKey: a.needsKey,
        protocol: "openai",
      };
    }
    // 旧字段迁移
    let asrEngine = parsed.asrEngine ?? DEFAULTS.asrEngine;
    if (!parsed.asrEngine && parsed.asrProvider) {
      asrEngine = parsed.asrProvider;
      if (parsed.asrBaseUrl && cloudAsr[asrEngine]) {
        cloudAsr[asrEngine] = { ...cloudAsr[asrEngine], baseUrl: parsed.asrBaseUrl, model: parsed.asrModel ?? cloudAsr[asrEngine].model };
      }
    }
    let translateMode = parsed.translateMode ?? DEFAULTS.translateMode;
    if (!parsed.translateMode && parsed.translateEngine === "llm") translateMode = "auto";
    if (!parsed.translateMode && parsed.translateEngine === "google") translateMode = "google";
    if (translateMode === "llm") translateMode = "auto";

    const rawMode = (parsed as { subtitleMode?: string }).subtitleMode;
    const subtitleMode: SubtitleMode =
      rawMode === "zh" || rawMode === "translation"
        ? "translation"
        : rawMode === "original" || rawMode === "bilingual"
          ? rawMode
          : DEFAULTS.subtitleMode;

    return {
      ...DEFAULTS,
      ...parsed,
      providers,
      cloudAsr,
      asrEngine,
      translateMode,
      subtitleMode,
      translateProvider: parsed.translateProvider ?? parsed.chatProvider ?? DEFAULTS.translateProvider,
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await api.setSettings(JSON.stringify(s));
}
