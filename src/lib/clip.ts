/**
 * [INPUT]: api.learnClip；store.current/player；convertFileSrc
 * [OUTPUT]: prepareClip / prefetchClip / playClip / stopClip / speak / useClipLoading
 * [POS]: 学英语句级原声；当前集走 seek+到点暂停，否则裁剪小段
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { create } from "zustand";
import { api } from "./api";
import { useStore } from "../store";

/** 正在拉取的剪辑 key，供按钮转圈。 */
export const useClipLoading = create<{ key: string | null }>(() => ({ key: null }));
export const clipKey = (episodeId: string, start: number, end: number) =>
  `${episodeId}|${start.toFixed(2)}|${end.toFixed(2)}`;

let el: HTMLAudioElement | null = null;
let stopTimer: number | undefined;
let unwatch: (() => void) | null = null;
/** 每次 play/stop 递增，避免迟到的剪辑覆盖新请求。 */
let turn = 0;

const made = new Map<string, Promise<string | null>>();

/** 句级本地剪辑，做成一次（失败则下次再试）。 */
export function prepareClip(episodeId: string, start: number, end: number): Promise<string | null> {
  const key = clipKey(episodeId, start, end);
  let p = made.get(key);
  if (!p) {
    p = api.learnClip(episodeId, start, end).catch(() => {
      made.delete(key);
      return null;
    });
    made.set(key, p);
  }
  return p;
}

const waiting: [string, number, number][] = [];
let running = 0;

/** 后台预裁，最多两路并行。 */
export function prefetchClip(episodeId: string, start: number, end: number) {
  if (made.has(clipKey(episodeId, start, end))) return;
  waiting.push([episodeId, start, end]);
  pump();
}

function pump() {
  while (running < 2 && waiting.length) {
    const [id, s, e] = waiting.shift()!;
    running++;
    void prepareClip(id, s, e).finally(() => {
      running--;
      pump();
    });
  }
}

export function stopClip() {
  turn++;
  window.clearTimeout(stopTimer);
  unwatch?.();
  unwatch = null;
  if (el) el.pause();
  useClipLoading.setState({ key: null });
}

/** 播放 [start,end]。无可用音频时返回 false（调用方可系统朗读）。 */
export async function playClip(ep: { id: string }, start: number, end: number): Promise<boolean> {
  stopClip();
  const mine = turn;
  const s = useStore.getState();
  const pad = 0.15;
  if (s.current?.id === ep.id && s.player) {
    const player = s.player;
    player.seek(Math.max(0, start - pad));
    player.play();
    const startedAt = Date.now();
    unwatch = useStore.subscribe((st) => {
      if (st.time >= end + pad || Date.now() - startedAt > (end - start + 8) * 1000) {
        unwatch?.();
        unwatch = null;
        if (st.playing) st.player?.toggle();
      }
    });
    return true;
  }
  const key = clipKey(ep.id, start, end);
  useClipLoading.setState({ key });
  const path = await prepareClip(ep.id, start, end);
  if (mine !== turn) return true;
  useClipLoading.setState({ key: null });
  if (!path) return false;
  if (!el) el = new Audio();
  el.src = convertFileSrc(path);
  el.currentTime = 0;
  try {
    await el.play();
  } catch {
    return false;
  }
  return true;
}

/** 系统 TTS 读英文（单词，或无音频时的句子）。 */
export function speak(text: string, rate = 0.9) {
  const synth = window.speechSynthesis;
  if (!synth) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.rate = rate;
  const voice =
    synth.getVoices().find((v) => v.lang === "en-US" && /Samantha|Alex|Ava|Allison/.test(v.name)) ??
    synth.getVoices().find((v) => v.lang.startsWith("en"));
  if (voice) u.voice = voice;
  synth.speak(u);
}
