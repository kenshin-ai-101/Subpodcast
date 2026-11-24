/**
 * [INPUT]: 引擎偏好、api.ttsSynthesize、本机 Web Speech 音色
 * [OUTPUT]: 统一朗读、试听、停止和分段合成
 * [POS]: 导读、精读、生词和原声缺失时共用一条朗读路径
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useStore } from "../store";
import { api, errText } from "./api";
import { tNow } from "./i18n";
import { DEFAULTS, type Settings, type TtsService } from "./settings";
import { followVolume } from "./volume";

export const useTtsPreview = create<{ active: string | null }>(() => ({ active: null }));
let playback: AbortController | undefined;
let externalStopper: (() => void) | null = null;

/** 允许字幕逐句朗读注册互斥停止回调，避免两路朗读重叠。 */
export function registerReadStopper(fn: () => void) {
  externalStopper = fn;
}

export function currentTtsService(settings: Settings): TtsService {
  return settings.ttsServices[settings.ttsEngine] ?? DEFAULTS.ttsServices.system;
}

/** 优先在句末断开，超长的句子仍完整保留。 */
export function chunks(text: string, max = 240): string[] {
  const lines = text.trim().split(/(?<=[。！？!?；;\n])|(?<=\.)\s+/u);
  const result: string[] = [];
  let current = "";
  for (const line of lines) {
    const sentence = line.trim();
    if (!sentence) continue;
    const words = Array.from(sentence);
    if (current && Array.from(current).length + words.length + 1 > max) {
      result.push(current);
      current = "";
    }
    for (let start = 0; start < words.length; start += max) {
      const part = words.slice(start, start + max).join("");
      current = current ? `${current} ${part}` : part;
      if (start + max < words.length) {
        result.push(current);
        current = "";
      }
    }
  }
  if (current) result.push(current);
  return result;
}

/** 仅停止导读/精读/试听这一路朗读（供字幕逐句朗读启动时调用，不递归停止自身）。 */
export function stopGeneralSpeaking() {
  const active = playback;
  playback = undefined;
  active?.abort();
  if (useTtsPreview.getState().active !== null) useTtsPreview.setState({ active: null });
  if (useStore.getState().speaking) useStore.getState().set({ speaking: false });
}

export function stopSpeaking() {
  stopGeneralSpeaking();
  externalStopper?.();
}

const novelty = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Junior|Kathy|Organ|Ralph|Superstar|Trinoids|Whisper|Wobble|Zarvox)$/i;

function webVoices(): SpeechSynthesisVoice[] {
  return (window.speechSynthesis?.getVoices?.() ?? []).filter((v) => v.localService && !novelty.test(v.name));
}

export function hasWebSpeechVoices(): boolean {
  return webVoices().length > 0;
}

export function listWebSystemVoices() {
  return webVoices().map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang }));
}

function webVoice(text: string, voice: string): SpeechSynthesisVoice | undefined {
  const voices = webVoices();
  if (voice) return voices.find((v) => v.voiceURI === voice || v.name === voice);
  const zh = /\p{Script=Han}/u.test(text);
  const matches = voices.filter((v) => v.lang.toLowerCase().startsWith(zh ? "zh" : "en"));
  const order = zh ? ["zh-cn", "zh-tw"] : ["en-us", "en-gb"];
  return matches.find((v) => /Premium|Enhanced/i.test(v.name))
    ?? matches.find((v) => v.lang.toLowerCase() === order[0] && /Tingting|Samantha|Ava|Alex/i.test(v.name))
    ?? order.map((lang) => matches.find((v) => v.lang.toLowerCase() === lang)).find(Boolean)
    ?? matches[0];
}

function speakWeb(text: string, voice: SpeechSynthesisVoice, rate: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const synth = window.speechSynthesis;
    const utterance = new SpeechSynthesisUtterance(text);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      utterance.onend = utterance.onerror = null;
      if (error) reject(error);
      else resolve();
    };
    const cancel = () => {
      finish();
      synth.cancel();
    };
    const timeout = window.setTimeout(() => {
      finish(new Error(tNow("等待系统朗读超时")));
      synth.cancel();
    }, Math.max(45_000, text.length * 700 / rate));
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = rate;
    utterance.onend = () => finish();
    utterance.onerror = () => finish(new Error(tNow("系统音色无法播放")));
    signal.addEventListener("abort", cancel, { once: true });
    try {
      synth.speak(utterance);
    } catch {
      finish(new Error(tNow("系统音色无法播放")));
    }
  });
}

export function speakWebLine(text: string, voiceId: string, rate: number, signal: AbortSignal): Promise<void> | null {
  const voice = webVoice(text, voiceId);
  if (!voice) return null;
  return speakWeb(text, voice, rate, signal);
}

function playbackOnly(service: TtsService): boolean {
  return service.protocol === "deepseek" || service.protocol === "qwen";
}

export function requestRate(service: TtsService, rate: number): number {
  if (playbackOnly(service)) return 1;
  return service.protocol === "elevenlabs" ? Math.min(rate, 1.2) : rate;
}

export function synthesize(text: string, service: TtsService, rate: number) {
  return api.ttsSynthesize({
    engine: service.id, protocol: service.protocol, voice: service.voice,
    model: service.model, baseUrl: service.baseUrl, resource: service.resource,
    needsKey: service.needsKey, text, rate: requestRate(service, rate),
  });
}

async function playFile(path: string, usedRate: number, signal: AbortSignal): Promise<void> {
  const audio = new Audio(convertFileSrc(path));
  const unsubVol = followVolume(audio);
  const speed = (rate: number) => { audio.playbackRate = Math.min(2, Math.max(0.5, rate / usedRate)); };
  speed(useStore.getState().settings.ttsRate);
  const unsubscribe = useStore.subscribe((state, old) => {
    if (state.settings.ttsRate !== old.settings.ttsRate) speed(state.settings.ttsRate);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        signal.removeEventListener("abort", stop);
        audio.onended = audio.onerror = null;
        if (error) reject(error);
        else resolve();
      };
      const stop = () => finish();
      signal.addEventListener("abort", stop, { once: true });
      audio.onended = () => finish();
      audio.onerror = () => finish(new Error(tNow("朗读音频播放失败")));
      void audio.play().catch(() => finish(new Error(tNow("朗读音频播放失败"))));
    });
  } finally {
    unsubVol();
    unsubscribe();
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
}

async function run(text: string, service: TtsService, onError?: (message: string) => void, preview?: string) {
  const parts = chunks(text, service.protocol === "system" ? 240 : 480);
  if (!parts.length) return;
  stopSpeaking();
  const controller = new AbortController();
  playback = controller;
  const { signal } = controller;
  const store = useStore.getState();
  if (store.playing) store.player?.toggle();
  if (preview) useTtsPreview.setState({ active: preview });
  else store.set({ speaking: true });

  // 仅预取下一段，并在创建 Promise 时接住错误，允许用户在等待中停止。
  const prepare = (part: string, selected = service) => {
    const rate = useStore.getState().settings.ttsRate;
    return synthesize(part, selected, rate).then(
      ({ path }) => ({ path, rate: requestRate(selected, rate) } as const),
      (error: unknown) => ({ error } as const),
    );
  };

  try {
    let next: ReturnType<typeof prepare> | undefined;
    for (const [i, part] of parts.entries()) {
      if (signal.aborted) break;
      let fallback = service;
      if (service.protocol === "system") {
        const voice = webVoice(part, service.voice);
        if (voice) {
          try {
            await speakWeb(part, voice, useStore.getState().settings.ttsRate, signal);
            continue;
          } catch {
            fallback = { ...service, voice: service.voice ? voice.name : "" };
          }
        }
      }
      if (signal.aborted) break;
      const file = await (next ?? prepare(part, fallback));
      if (signal.aborted) break;
      if ("error" in file) throw file.error;
      next = service.protocol !== "system" && i + 1 < parts.length ? prepare(parts[i + 1]) : undefined;
      await playFile(file.path, file.rate, signal);
    }
  } catch (error) {
    if (!signal.aborted) (onError ?? useStore.getState().notify)(errText(error));
  } finally {
    if (playback === controller) stopSpeaking();
  }
}

export function speak(text: string, onError?: (message: string) => void): Promise<void> {
  return run(text, currentTtsService(useStore.getState().settings), onError);
}

/** 学英语走当前引擎；多语言服务有专用英文音色时优先使用。 */
export function speakWord(text: string) {
  const service = currentTtsService(useStore.getState().settings);
  if (service.protocol === "system") return run(text, { ...service, voice: "" });
  const englishVoices = service.id === "mimo"
    ? ["Mia", "Chloe", "Milo", "Dean"]
    : service.voices.filter((voice) => /^en[-_]/i.test(voice.id)).map((voice) => voice.id);
  if (englishVoices.includes(service.voice) || !englishVoices.length) return run(text, service);
  return run(text, {
    ...service,
    voice: englishVoices[0],
    resource: service.id === "doubao" ? "seed-tts-2.0" : service.resource,
  });
}

export function previewVoice(engineId: string, voiceId: string, onError?: (message: string) => void, model?: string) {
  const service = useStore.getState().settings.ttsServices[engineId];
  if (!service) return;
  const id = `${engineId}:${model ?? service.model ?? ""}:${voiceId}`;
  if (useTtsPreview.getState().active === id) {
    stopSpeaking();
    return;
  }
  const lang = webVoices().find((v) => v.voiceURI === voiceId)?.lang ?? voiceId;
  const english = /^en[-_]|Samantha|Ava|Alex|Andrew|Emma/i.test(lang);
  const sample = english ? "Hello! This is how your reading voice sounds." : "你好，欢迎使用声译。这是当前音色的试听。";
  return run(sample, { ...service, voice: voiceId, model: model ?? service.model }, onError, id);
}
