/**
 * [INPUT]: markSentences 产出的句数组；tts.synthesizeText / speakSystemAsync；store.playing
 * [OUTPUT]: useReadAlong + start/seek/toggle/stop/resumeIndex — 进度跟 TTS 时钟，非播客播放头
 * [POS]: 精读跟读；与播客播放、字幕逐句、导读朗读互斥
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { create } from "zustand";
import { stopClip } from "./clip";
import { tNow } from "./i18n";
import { estimateMarks, spokenChars, type Mark } from "./sentences";
import {
  currentTtsService,
  hasWebSpeechVoices,
  registerReadStopper,
  speakSystemAsync,
  stopSpeaking,
  synthesizeText,
} from "./tts";
import { followVolume } from "./volume";
import { useStore } from "../store";

export type ReadState = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

interface ReadAlong {
  /** 正在朗读的文章标识，如 `deep:<episodeId>`；空闲为 null。 */
  owner: string | null;
  sentences: string[];
  index: number;
  state: ReadState;
  /** 当前句已读字符数（boundary 或时长估计）。 */
  spoken: number;
  error: string | null;
}

export const useReadAlong = create<ReadAlong>(() => ({
  owner: null,
  sentences: [],
  index: 0,
  state: "idle",
  spoken: 0,
  error: null,
}));

const set = (p: Partial<ReadAlong>) => useReadAlong.setState(p);

interface Synth {
  url: string;
  rate: number;
}

let gen = 0;
let audio: HTMLAudioElement | null = null;
let unsubVol: (() => void) | null = null;
let raf = 0;
/** 当前音频合成时的语速。 */
let madeAt = 1;
const cache = new Map<string, Promise<Synth>>();

const progressKey = (owner: string) => `subpodcast-read:${owner}`;

/** 上次停在哪一句；越界则从头。 */
export function resumeIndex(owner: string, total: number): number {
  try {
    const i = Number(localStorage.getItem(progressKey(owner)));
    return i > 0 && i < total ? i : 0;
  } catch {
    return 0;
  }
}

function remember(owner: string, index: number | null) {
  try {
    if (index == null) localStorage.removeItem(progressKey(owner));
    else localStorage.setItem(progressKey(owner), String(index));
  } catch {
    /* private mode */
  }
}

const usesWebSpeech = () =>
  currentTtsService(useStore.getState().settings).id === "system" && hasWebSpeechVoices();

const rateNow = () => useStore.getState().settings.ttsRate || 1;

const rateFix = (made: number) => Math.min(2, Math.max(0.5, rateNow() / made));

function pausePodcast() {
  const { player, playing } = useStore.getState();
  if (playing) player?.toggle();
}

function synth(text: string): Promise<Synth> {
  const s = useStore.getState().settings;
  const svc = currentTtsService(s);
  const key = `${svc.id}|${svc.voice}|${svc.model ?? ""}|${text}`;
  let p = cache.get(key);
  if (!p) {
    p = synthesizeText(text, { rate: rateNow() }).then((r) => ({ url: r.url, rate: r.rate }));
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
  }
  return p;
}

/** 停声不改 store（由调用方设 state）。 */
function halt() {
  gen++;
  cancelAnimationFrame(raf);
  unsubVol?.();
  unsubVol = null;
  if (audio) {
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio = null;
  }
  if (usesWebSpeech() || window.speechSynthesis?.speaking) window.speechSynthesis?.cancel();
}

async function playFrom(i: number) {
  const { owner, sentences } = useReadAlong.getState();
  if (!owner) return;
  halt();
  const g = gen;
  if (i >= sentences.length) {
    set({ state: "ended", index: Math.max(0, sentences.length - 1), spoken: 0 });
    remember(owner, null);
    return;
  }
  set({ index: i, spoken: 0, state: "loading", error: null });
  remember(owner, i);
  const text = sentences[i];
  const next = () => {
    if (g === gen) void playFrom(i + 1);
  };
  const fail = (e: unknown) => {
    if (g === gen) set({ state: "error", error: String((e as Error)?.message ?? e) });
  };
  try {
    if (usesWebSpeech()) {
      set({ state: "playing" });
      const svc = currentTtsService(useStore.getState().settings);
      await speakSystemAsync(text, {
        voice: svc.voice,
        rate: Math.min(2, Math.max(0.5, rateNow())),
        isCanceled: () => g !== gen,
        onBoundary: (n) => {
          if (g === gen) set({ spoken: n });
        },
      });
      next();
      return;
    }
    const res = await synth(text);
    if (g !== gen) return;
    if (i + 1 < sentences.length) synth(sentences[i + 1]).catch(() => {});
    const el = new Audio(res.url);
    audio = el;
    unsubVol = followVolume(el);
    el.playbackRate = rateFix(res.rate);
    madeAt = res.rate;
    let marks: Mark[] = [];
    el.onloadedmetadata = () => {
      marks = estimateMarks(text, el.duration);
    };
    el.onended = () => {
      set({ spoken: text.length });
      next();
    };
    el.onerror = () => fail(new Error(tNow("朗读音频播放失败")));
    const tick = () => {
      if (g !== gen) return;
      if (marks.length) {
        const n = spokenChars(marks, el.currentTime);
        if (n !== useReadAlong.getState().spoken) set({ spoken: n });
      }
      raf = requestAnimationFrame(tick);
    };
    await el.play();
    if (g !== gen) {
      el.pause();
      return;
    }
    set({ state: "playing" });
    raf = requestAnimationFrame(tick);
  } catch (e) {
    fail(e);
  }
}

/** 从 `index` 句开始朗读 `sentences`（归属 `owner`）。 */
export function startReading(owner: string, sentences: string[], index = 0) {
  stopSpeaking();
  stopClip();
  pausePodcast();
  set({ owner, sentences, index, state: "loading", spoken: 0, error: null });
  void playFrom(index);
}

/** 跳到第 `i` 句（点句 / 上一句 / 下一句）。 */
export function seekReading(i: number) {
  const { owner, sentences } = useReadAlong.getState();
  if (!owner) return;
  pausePodcast();
  void playFrom(Math.max(0, Math.min(sentences.length - 1, i)));
}

export function toggleReading() {
  const { state, index } = useReadAlong.getState();
  if (state === "playing" || state === "loading") {
    // WebKit 系统语音难可靠 pause：停句后从本句重读。
    if (audio && state === "playing") {
      audio.pause();
      cancelAnimationFrame(raf);
      set({ state: "paused" });
      return;
    }
    halt();
    set({ state: "paused", spoken: 0 });
    return;
  }
  if (state === "paused" && audio) {
    pausePodcast();
    const el = audio;
    const g = gen;
    void el
      .play()
      .then(() => {
        if (g !== gen) return;
        set({ state: "playing" });
        resumeTicker(el, g);
      })
      .catch((e) => set({ state: "error", error: String(e?.message ?? e) }));
    return;
  }
  seekReading(state === "ended" ? 0 : index);
}

function resumeTicker(el: HTMLAudioElement, g: number) {
  const { sentences, index } = useReadAlong.getState();
  const marks = estimateMarks(sentences[index] ?? "", el.duration);
  cancelAnimationFrame(raf);
  const tick = () => {
    if (g !== gen || el.paused) return;
    const n = spokenChars(marks, el.currentTime);
    if (n !== useReadAlong.getState().spoken) set({ spoken: n });
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

export function stopReading() {
  halt();
  set({ owner: null, sentences: [], index: 0, state: "idle", spoken: 0, error: null });
}

registerReadStopper(() => {
  if (useReadAlong.getState().owner) stopReading();
});

// 播客起播 → 暂停跟读；语速变更立即作用到当前音频。
useStore.subscribe((s, prev) => {
  if (s.playing && !prev.playing && useReadAlong.getState().state === "playing") toggleReading();
  if (audio && s.settings.ttsRate !== prev.settings.ttsRate) audio.playbackRate = rateFix(madeAt);
});
