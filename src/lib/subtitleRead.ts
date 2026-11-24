/**
 * [INPUT]: tts 统一合成/系统音色、store.settings.ttsRate、volume.followVolume、clip.stopClip
 * [OUTPUT]: useSubtitleRead / startSubtitleRead / stopSubtitleRead — 外语单集切到中文后的逐句中文朗读
 * [POS]: 字幕面板「中文」模式朗读入口；播中自动暂停原音频，原音频恢复播放时自动退让；支持实时变速与向后预取
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useStore } from "../store";
import { errText } from "./api";
import { stopClip } from "./clip";
import { tNow } from "./i18n";
import {
  currentTtsService,
  hasWebSpeechVoices,
  registerReadStopper,
  requestRate,
  speakWebLine,
  stopGeneralSpeaking,
  synthesize,
  type currentTtsService as _SvcFn,
} from "./tts";
import { followVolume } from "./volume";

interface SubtitleReadState {
  episodeId: string | null;
  lineIndex: number | null;
}

export const useSubtitleRead = create<SubtitleReadState>(() => ({
  episodeId: null,
  lineIndex: null,
}));

const PREFETCH_AHEAD = 2;

let runSeq = 0;
let activeAbort: AbortController | null = null;
let activeAudio: HTMLAudioElement | null = null;
let activeSynthRate = 1;
let unsubStore: (() => void) | null = null;
let unsubVolume: (() => void) | null = null;

function clampSpeed(target: number, base: number): number {
  const ratio = (target || 1) / (base || 1);
  return Math.min(2, Math.max(0.5, ratio));
}

function releaseAudio() {
  unsubVolume?.();
  unsubVolume = null;
  if (activeAudio) {
    activeAudio.onended = null;
    activeAudio.onerror = null;
    activeAudio.pause();
    activeAudio.removeAttribute("src");
    activeAudio.load();
    activeAudio = null;
  }
}

export function stopSubtitleRead() {
  runSeq += 1;
  const ctrl = activeAbort;
  activeAbort = null;
  ctrl?.abort();
  releaseAudio();
  window.speechSynthesis?.cancel();
  unsubStore?.();
  unsubStore = null;
  const cur = useSubtitleRead.getState();
  if (cur.episodeId !== null || cur.lineIndex !== null) {
    useSubtitleRead.setState({ episodeId: null, lineIndex: null });
  }
}

registerReadStopper(stopSubtitleRead);

function playAudioFile(path: string, synthRate: number, signal: AbortSignal): Promise<void> {
  releaseAudio();
  const el = new Audio(convertFileSrc(path));
  activeAudio = el;
  activeSynthRate = synthRate;
  el.playbackRate = clampSpeed(useStore.getState().settings.ttsRate, synthRate);
  unsubVolume = followVolume(el);

  return new Promise<void>((resolve, reject) => {
    const cleanup = (err?: Error) => {
      signal.removeEventListener("abort", onAbort);
      if (activeAudio === el) {
        releaseAudio();
      } else {
        el.onended = null;
        el.onerror = null;
        el.pause();
      }
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => cleanup();
    if (signal.aborted) {
      cleanup();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    el.onended = () => cleanup();
    el.onerror = () => cleanup(new Error(tNow("朗读音频播放失败")));
    void el.play().catch(() => cleanup(new Error(tNow("朗读音频播放失败"))));
  });
}

/** 从 `fromIndex` 起逐句朗读中文译文；遇到缺失 Key 等错误回调给 UI 展开朗读设置。 */
export async function startSubtitleRead(
  episodeId: string,
  items: (string | null | undefined)[],
  fromIndex: number,
  onError: (message: string) => void,
) {
  stopSubtitleRead();
  stopGeneralSpeaking();
  stopClip();

  const mySeq = ++runSeq;
  const controller = new AbortController();
  activeAbort = controller;
  const { signal } = controller;

  const store = useStore.getState();
  if (store.playing) store.player?.toggle();

  // 原音频/视频恢复播放时停止朗读；语速变更时立刻作用于当前正在读的句子
  unsubStore = useStore.subscribe((next, prev) => {
    if (mySeq !== runSeq) return;
    if (next.playing && !prev.playing) {
      stopSubtitleRead();
      return;
    }
    if (activeAudio && next.settings.ttsRate !== prev.settings.ttsRate) {
      activeAudio.playbackRate = clampSpeed(next.settings.ttsRate, activeSynthRate);
    }
  });

  const queue: number[] = [];
  for (let i = Math.max(0, fromIndex); i < items.length; i += 1) {
    if (items[i]?.trim()) queue.push(i);
  }
  if (!queue.length) {
    stopSubtitleRead();
    onError(tNow("这里往后还没有中文翻译"));
    return;
  }

  useSubtitleRead.setState({ episodeId, lineIndex: queue[0]! });
  const service: ReturnType<typeof _SvcFn> = currentTtsService(store.settings);

  try {
    if (service.protocol === "system" && hasWebSpeechVoices()) {
      for (const idx of queue) {
        if (mySeq !== runSeq || signal.aborted) return;
        const text = items[idx]!.trim();
        useSubtitleRead.setState({ episodeId, lineIndex: idx });
        const rate = Math.min(2, Math.max(0.5, useStore.getState().settings.ttsRate || 1));
        const spoken = speakWebLine(text, service.voice, rate, signal);
        if (spoken) {
          try {
            await spoken;
            continue;
          } catch {
            if (mySeq !== runSeq || signal.aborted) return;
          }
        }
        const synthRate = requestRate(service, rate);
        const res = await synthesize(text, service, rate);
        if (mySeq !== runSeq || signal.aborted) return;
        await playAudioFile(res.path, synthRate, signal);
      }
      return;
    }

    type Prepared = { path: string; synthRate: number } | { error: unknown };
    const prefetched = new Map<number, Promise<Prepared>>();
    const ensurePrefetch = (pos: number) => {
      if (pos >= queue.length || prefetched.has(pos)) return;
      const text = items[queue[pos]!]!.trim();
      const rate = useStore.getState().settings.ttsRate || 1;
      const synthRate = requestRate(service, rate);
      const task = synthesize(text, service, rate).then(
        (res): Prepared => ({ path: res.path, synthRate }),
        (error: unknown): Prepared => ({ error }),
      );
      prefetched.set(pos, task);
    };

    for (let pos = 0; pos < queue.length; pos += 1) {
      if (mySeq !== runSeq || signal.aborted) return;
      for (let ahead = 0; ahead <= PREFETCH_AHEAD; ahead += 1) {
        ensurePrefetch(pos + ahead);
      }
      const ready = await prefetched.get(pos)!;
      prefetched.delete(pos);
      if (mySeq !== runSeq || signal.aborted) return;
      if ("error" in ready) throw ready.error;
      useSubtitleRead.setState({ episodeId, lineIndex: queue[pos]! });
      await playAudioFile(ready.path, ready.synthRate, signal);
    }
  } catch (err) {
    if (mySeq === runSeq && !signal.aborted) {
      onError(errText(err));
    }
  } finally {
    if (mySeq === runSeq) {
      stopSubtitleRead();
    }
  }
}
