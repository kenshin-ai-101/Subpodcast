/**
 * [INPUT]: api.getSettings / setSettings
 * [OUTPUT]: Settings、LearnLevel、PRESETS、TTS_SERVICES、ASR_SERVICES、BUILTIN_PROMPTS、quickPrompts、clipExportDir、读写与迁移
 * [POS]: 用户偏好；Key 在钥匙串；含问答/朗读/学英语与高光导出目录
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { api, type TtsRequest } from "./api";

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
export type SettingsSection = "subtitles" | "ai" | "tts" | "general" | "learn" | "agents";
export type LangSetting = "auto" | "zh-CN" | "zh-TW" | "en";
export type ThemeSetting = "system" | "light" | "dark";
export type LearnLevel = "cet4" | "cet6" | "ky" | "ielts";

export interface QuickPrompt {
  id: string;
  title: string;
  body: string;
  enabled: boolean;
}

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
  /** 问答全局指令；chatPromptOn 关闭时不注入。 */
  chatPrompt: string;
  chatPromptOn: boolean;
  /** null = 用内置提示词。 */
  quickPrompts: QuickPrompt[] | null;
  subtitleMode: SubtitleMode;
  subtitleSize?: "s" | "m" | "l" | "xl";
  /** 中文字幕缩放倍率（0.7 ~ 2.0）；未设时回退 subtitleSize 四档。 */
  subtitleScale?: number;
  /** 原文字幕缩放倍率（0.7 ~ 2.0）；未设时跟随 subtitleScale。 */
  subtitleOrigScale?: number;
  /** 视频叠字幕垂直位移（单位 cqh，-4 ~ 70）；拖拽产生，双击清零。 */
  subtitleLift?: number;
  subtitleFont?: "system" | "serif" | "kai" | "sans";
  subtitleLook?: "box" | "outline";
  chatSize?: "m" | "l";
  audioNextLine?: boolean;
  /** 有 TimeMap 时自动跳过仅播放文件有的空隙（多半是广告）。 */
  skipAds?: boolean;
  autoNext?: boolean;
  /** 播放倍速（与控制条同步）。 */
  playbackRate?: number;
  shortcuts?: Partial<Record<import("./shortcuts").ActionId, string[]>>;
  uiLang: LangSetting;
  theme?: ThemeSetting;
  youtubePromo: boolean;
  homeBannerHidden: boolean;
  /** 匿名分享字幕、译文与导读（默认关，用户显式开启后生效；私有源永不上传）。 */
  shareTranscripts: boolean;
  shareTranscriptsAsked?: boolean;
  /** 启动时是否已提示过「让 AI 助手调用声译」（对齐 SubCast agentsOffered）。 */
  agentsOffered?: boolean;
  /** 当前使用的朗读引擎。 */
  ttsEngine: string;
  ttsServices: Record<string, TtsService>;
  ttsRate: number;
  /** YouTube 验证时借用哪个浏览器登录（"" = 先问我）。 */
  ytCookiesBrowser?: string;
  /** 英语学习模式（设置 › 学英语）。默认关；下列项仅开启后生效。 */
  learnOn: boolean;
  /** 听众水平：字幕里标出超过该水平的词。 */
  learnLevel: LearnLevel;
  learnMark: boolean;
  learnCard: boolean;
  /** 用默认模型解释「在这句里」的意思。 */
  learnAi: boolean;
  learnSide: boolean;
  /** 每天新学词数。 */
  learnDaily: number;
  learnRemind: boolean;
  /** 拼写复习时的按键/对错音效。 */
  learnSounds: boolean;
  /** 是否已回答过「想顺便学英语吗？」。 */
  learnAsked: boolean;
  /** 高光剪辑导出目录；空则系统「下载」。 */
  clipExportDir?: string;
}

/** 导读/精读朗读可选音色。 */
export const VOICES: [string, string][] = [
  ["zh_female_vv_uranus_bigtts", "Vivi 2.0"],
  ["zh_male_liufei_uranus_bigtts", "刘飞 2.0"],
  ["zh_female_xiaohe_uranus_bigtts", "小何 2.0"],
  ["zh_male_m191_uranus_bigtts", "云舟 2.0"],
  ["zh_male_taocheng_uranus_bigtts", "小天 2.0"],
  ["zh_male_shenyeboke_uranus_bigtts", "深夜播客 2.0"],
  ["zh_male_youyoujunzi_uranus_bigtts", "悠悠君子 2.0"],
  ["zh_female_shuangkuaisisi_uranus_bigtts", "爽快思思 2.0"],
  ["zh_female_cancan_uranus_bigtts", "知性灿灿 2.0"],
  ["en_male_tim_uranus_bigtts", "Tim"],
  ["en_female_dacey_uranus_bigtts", "Dacey"],
];

export const BUILTIN_PROMPTS: QuickPrompt[] = (
  [
    ["brief", "三分钟看懂这期", "用三分钟能读完的篇幅讲清这期节目：主要聊了什么、得出了什么结论、为什么值得关注。最后推荐 3 个最值得听的片段，附时间戳。"],
    ["insights", "最有价值的观点", "列出这期最有信息量的 5–8 个观点，按重要性排序。每条写：一句加粗的观点、嘉宾给出的理由、原话时间戳。"],
    ["guest", "嘉宾是谁", "嘉宾是谁？结合节目内容介绍他的身份、经历和代表作，说明他为什么有资格谈这个话题。节目里没提到、属于常识补充的内容请标出来。"],
    ["debate", "反直觉和有争议的地方", "这期有哪些反直觉或有争议的观点？逐条说明：通常大家怎么看、嘉宾怎么说、他的理由站不站得住、可能漏掉了什么。"],
    ["numbers", "数据和预测", "把节目里出现的具体数字、时间表和对未来的预测整理成表格，列：内容、谁说的、时间戳、可信度和理由。"],
    ["resources", "提到的书和资源", "整理节目里提到的书、论文、公司、产品、工具和人物，按类别列出，每项一句话说明，并附时间戳。"],
    ["action", "我能用上什么", "站在普通从业者的角度，这期有哪些马上能用到工作或生活里的方法和建议？写成具体可做的动作，每条附出处时间戳。"],
    ["terms", "术语和黑话", "列出节目里出现的专业术语、缩写和圈内说法，给出英文原文、通俗的中文解释和出现的时间戳。"],
    ["followup", "值得追问的问题", "如果我能采访这位嘉宾，最值得追问的 3 个问题是什么？说明为什么要问，以及节目里哪里没讲透。"],
    ["share", "写一段分享", "把这期的精华写成一段适合发朋友圈的分享，200 字以内，口语化，突出一个最有冲击力的观点。"],
  ] as const
).map(([id, title, body]) => ({ id: `builtin-${id}`, title, body, enabled: true }));

export const PROMPT_HINTS = ["先给结论，再展开", "简洁，不说套话", "多用列表和表格", "术语保留英文原文", "讲给外行听，多打比方"];

export function quickPrompts(s: Settings): QuickPrompt[] {
  return s.quickPrompts ?? BUILTIN_PROMPTS.map((p) => ({ ...p }));
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

export interface TtsVoice { id: string; name: string }

export interface TtsService {
  id: string;
  name: string;
  protocol: TtsRequest["protocol"];
  group: "local" | "cloud";
  voice: string;
  voices: TtsVoice[];
  model?: string;
  models?: string[];
  baseUrl?: string;
  needsKey?: boolean;
  keyUrl?: string;
  resource?: string;
  sharedAccounts?: string[];
}

export const TTS_CLOUD_MAIN = ["doubao", "deepseek", "mimo", "qwen", "openai", "edge"];

function voiceOptions(names: (string | [string, string])[]): TtsVoice[] {
  return names.map((item) => typeof item === "string" ? { id: item, name: item } : { id: item[0], name: item[1] });
}

function cloudTts(
  id: string, name: string, protocol: TtsService["protocol"], names: (string | [string, string])[],
  config: Pick<TtsService, "baseUrl" | "models" | "keyUrl" | "sharedAccounts" | "resource"> = {},
): TtsService {
  const voices = voiceOptions(names);
  return {
    id, name, protocol, group: "cloud", voices, voice: voices[0]?.id ?? "alloy",
    needsKey: !["edge", "custom"].includes(id), model: config.models?.[0], ...config,
  };
}

export const TTS_SERVICES: TtsService[] = [
  { id: "system", name: "系统语音", group: "local", protocol: "system", voice: "", voices: [] },
  {
    id: "local", name: "本地语音", group: "local", protocol: "local", model: "melo", voice: "zf_001",
    voices: voiceOptions([
      ["zf_001", "知夏"], ["zf_002", "清禾"], ["zf_003", "晴岚"], ["zf_004", "沐言"],
      ["zm_009", "言川"], ["zm_010", "远山"], ["zm_011", "景和"], ["zm_012", "明朗"],
    ]),
  },
  cloudTts("doubao", "豆包语音", "doubao", VOICES, {
    resource: "seed-tts-2.0", keyUrl: "https://console.volcengine.com/speech/new/setting/apikeys?projectName=default",
    sharedAccounts: ["asr.doubao", "doubao"],
  }),
  cloudTts("deepseek", "DeepSeek", "deepseek", [["stella", "Stella"], ["tide", "Tide"]], {
    keyUrl: "https://platform.deepseek.com/api_keys", sharedAccounts: ["deepseek", "asr.deepseek"],
  }),
  cloudTts("mimo", "小米 MiMo", "mimo", [
    ["mimo_default", "默认"], "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean",
  ], {
    models: ["mimo-v2.5-tts"], keyUrl: "https://platform.xiaomimimo.com/", sharedAccounts: ["mimo"],
  }),
  cloudTts("qwen", "通义 Qwen-TTS", "qwen", ["Cherry", "Ethan", "Chelsie", "Serena", "Dylan", "Jada", "Sunny"], {
    models: ["qwen3-tts-flash", "qwen-tts"], keyUrl: "https://bailian.console.aliyun.com/?apiKey=1", sharedAccounts: ["qwen-cn"],
  }),
  cloudTts("openai", "OpenAI", "openai", ["alloy", "ash", "coral", "echo", "nova", "onyx", "sage", "shimmer"], {
    models: ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"], keyUrl: "https://platform.openai.com/api-keys", sharedAccounts: ["openai", "asr.openai"],
  }),
  cloudTts("edge", "Edge 在线语音", "edge", [
    ["zh-CN-YunxiNeural", "云希"], ["zh-CN-XiaoxiaoNeural", "晓晓"], ["zh-CN-YunjianNeural", "云健"],
    ["zh-CN-XiaoyiNeural", "晓伊"], ["zh-CN-YunyangNeural", "云扬"], ["zh-TW-HsiaoChenNeural", "晓臻（台湾）"],
    ["zh-HK-HiuMaanNeural", "晓曼（粤语）"], ["en-US-AndrewMultilingualNeural", "Andrew"], ["en-US-EmmaMultilingualNeural", "Emma"],
  ]),
  cloudTts("siliconflow", "硅基流动", "openai", ["anna", "alex", "bella", "benjamin", "claire", "charles", "diana", "david"], {
    models: ["FunAudioLLM/CosyVoice2-0.5B", "fnlp/MOSS-TTSD-v0.5"], keyUrl: "https://cloud.siliconflow.cn/account/ak",
    sharedAccounts: ["siliconflow", "asr.siliconflow"],
  }),
  cloudTts("minimax", "MiniMax", "minimax", [
    ["male-qn-qingse", "青涩青年"], ["female-shaonv", "少女"], ["male-qn-jingying", "精英青年"], ["female-yujie", "御姐"],
    ["presenter_male", "男主持"], ["presenter_female", "女主持"], ["audiobook_male_1", "有声书男声"], ["audiobook_female_1", "有声书女声"],
  ], {
    models: ["speech-02-hd", "speech-02-turbo", "speech-2.6-hd"],
    keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key", sharedAccounts: ["minimax-cn"],
  }),
  cloudTts("elevenlabs", "ElevenLabs", "elevenlabs", [
    ["JBFqnCBsd6RMkjVDRZzb", "George"], ["21m00Tcm4TlvDq8ikWAM", "Rachel"], ["EXAVITQu4vr4xnSDxMaL", "Sarah"],
    ["pNInz6obpgDQGcFmaJgB", "Adam"], ["Xb7hH8MSUJpSbSDYk0k2", "Alice"],
  ], {
    models: ["eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5"], keyUrl: "https://elevenlabs.io/app/settings/api-keys",
    sharedAccounts: ["elevenlabs"],
  }),
  cloudTts("custom", "其他（OpenAI 兼容）", "openai", [], { baseUrl: "http://127.0.0.1:8880/v1", models: ["tts-1"] }),
];

export const TTS_RATES = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;

export const DEFAULTS: Settings = {
  providers: Object.fromEntries(PRESETS.map((p) => [p.id, p])),
  chatProvider: "deepseek",
  translateProvider: "deepseek",
  translateMode: "auto",
  translateQuality: "fast",
  proxy: "",
  asrEngine: "local",
  asrModel: "qwen3-asr",
  cloudAsr: Object.fromEntries(ASR_SERVICES.map((a) => [a.id, a])),
  chatModel: "",
  chatPrompt: "",
  chatPromptOn: true,
  quickPrompts: null,
  subtitleMode: "bilingual",
  subtitleSize: "m",
  subtitleFont: "sans",
  subtitleLook: "outline",
  chatSize: "m",
  audioNextLine: false,
  skipAds: false,
  autoNext: false,
  playbackRate: 1,
  uiLang: "auto",
  theme: "system",
  youtubePromo: true,
  homeBannerHidden: false,
  shareTranscripts: false,
  shareTranscriptsAsked: false,
  agentsOffered: false,
  ttsEngine: "system",
  ttsServices: Object.fromEntries(TTS_SERVICES.map((service) => [service.id, service])),
  ttsRate: 1,
  ytCookiesBrowser: "",
  learnOn: false,
  learnLevel: "cet6",
  learnMark: true,
  learnCard: true,
  learnAi: true,
  learnSide: true,
  learnDaily: 20,
  learnRemind: false,
  learnSounds: true,
  learnAsked: false,
  clipExportDir: "",
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
      ttsVoice?: string;
      ttsResource?: string;
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

    const ttsServices = Object.fromEntries(TTS_SERVICES.map((service) => {
      const stored = parsed.ttsServices?.[service.id];
      const restored: TtsService = {
        ...service,
        model: stored?.model ?? service.model,
        voice: stored?.voice ?? service.voice,
        resource: stored?.resource ?? service.resource,
      };
      if (service.id === "custom") restored.baseUrl = stored?.baseUrl ?? service.baseUrl;
      return [service.id, restored];
    }));
    const { ttsVoice, ttsResource, ...prefs } = parsed;
    let ttsEngine = parsed.ttsEngine ?? DEFAULTS.ttsEngine;
    if (!parsed.ttsServices?.doubao) {
      ttsServices.doubao.voice = ttsVoice || ttsServices.doubao.voice;
      ttsServices.doubao.resource = ttsResource || ttsServices.doubao.resource;
      if (!parsed.ttsEngine && (ttsVoice || ttsResource)) {
        const accounts = ["tts.doubao", ...(ttsServices.doubao.sharedAccounts ?? [])];
        const configured = await Promise.all(accounts.map((account) => api.hasApiKey(account).catch(() => false)));
        if (configured.some(Boolean)) ttsEngine = "doubao";
      }
    }
    const savedRate = parsed.ttsRate;
    const ttsRate = typeof savedRate === "number" && Number.isFinite(savedRate)
      ? Math.min(1.5, Math.max(0.8, savedRate))
      : DEFAULTS.ttsRate;

    return {
      ...DEFAULTS,
      ...prefs,
      ttsEngine: Object.hasOwn(ttsServices, ttsEngine) ? ttsEngine : DEFAULTS.ttsEngine,
      ttsServices,
      ttsRate,
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
