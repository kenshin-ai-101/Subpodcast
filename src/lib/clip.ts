/**
 * [INPUT]: api.learnClip；store.current/player；convertFileSrc；统一朗读引擎
 * [OUTPUT]: prepareClip / prefetchClip / playClip / toggleClip / stopClip / speak / useClipState / clipKey
 * [POS]: 学英语句级原声；当前集 seek+到点暂停，否则本地剪辑；按钮可显示 loading/playing
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { create } from "zustand";
import { api } from "./api";
import { speakWord, stopSpeaking } from "./tts";
import { useStore } from "../store";

/** 当前句 key + 是否在裁剪；按钮据此转圈 / 显示暂停。 */
export const useClipState = create<{ key: string | null; loading: boolean }>(() => ({
  key: null,
  loading: false,
}));
/** @deprecated 用 useClipState；保留别名以免旧调用崩。 */
export const useClipLoading = useClipState;

export const clipKey = (episodeId: string, start: number, end: number) =>
  `${episodeId}|${start.toFixed(2)}|${end.toFixed(2)}`;

let el: HTMLAudioElement | null = null;
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
  if (unwatch) {
    unwatch();
    unwatch = null;
    const s = useStore.getState();
    if (s.playing) s.player?.toggle();
  }
  if (el) el.pause();
  stopSpeaking();
  useClipState.setState({ key: null, loading: false });
}

/** 正在播同一句则停，否则开播。fallbackText：无剪辑时使用所选引擎朗读，仍可点暂停停掉。 */
export async function toggleClip(
  ep: { id: string },
  start: number,
  end: number,
  fallbackText?: string,
): Promise<boolean> {
  if (useClipState.getState().key === clipKey(ep.id, start, end)) {
    stopClip();
    return true;
  }
  return playClip(ep, start, end, fallbackText);
}

/** 无本地剪辑时，用 TTS 顶上，并挂上同一 key，以便按钮显示「暂停」。 */
function speakAsClip(key: string, text: string, mine: number) {
  useClipState.setState({ key, loading: false });
  void speakWord(text).finally(() => {
    if (mine === turn) useClipState.setState({ key: null, loading: false });
  });
  return true;
}

/** 播放 [start,end]。无可用音频且无 fallbackText 时返回 false。 */
export async function playClip(
  ep: { id: string },
  start: number,
  end: number,
  fallbackText?: string,
): Promise<boolean> {
  stopClip();
  const mine = turn;
  const s = useStore.getState();
  const pad = 0.15;
  const key = clipKey(ep.id, start, end);
  const span = Math.max(0.5, end - start);
  const done = () => {
    if (mine === turn) useClipState.setState({ key: null, loading: false });
  };

  if (s.current?.id === ep.id && s.player) {
    const player = s.player;
    const at = Math.max(0, start - pad);
    player.seek(at);
    player.play();
    useClipState.setState({ key, loading: false });
    const startedAt = Date.now();
    // YouTube/远程音频的 seek 常异步：tick 可能短暂回写旧 time（仍在句尾之后）。
    // 未进入本句窗口前不算「播完」，否则会清掉 key 却拦不住随后真正响起的 play。
    let armed = false;
    unwatch = useStore.subscribe((st, prev) => {
      if (mine !== turn) return;
      if (st.current?.id !== ep.id) {
        unwatch?.();
        unwatch = null;
        done();
        return;
      }
      const inWindow = st.time >= start - 1 && st.time <= end + pad + 0.5;
      if (!armed) {
        if (inWindow) armed = true;
        else if (Date.now() - startedAt > 2500) armed = true;
        else return;
      }
      const over = st.time >= end + pad || Date.now() - startedAt > (span + 8) * 1000;
      const userPaused = prev.playing && !st.playing && Date.now() - startedAt > 1500;
      if (over || userPaused) {
        unwatch?.();
        unwatch = null;
        if (over && st.playing) st.player?.toggle();
        done();
      }
    });
    return true;
  }

  useClipState.setState({ key, loading: true });
  const path = await prepareClip(ep.id, start, end);
  if (mine !== turn) return true;
  if (!path) {
    if (fallbackText && speakAsClip(key, fallbackText, mine)) return true;
    done();
    return false;
  }
  if (!el) el = new Audio();
  const a = el;
  a.onended = a.onpause = () => {
    if (a.paused) done();
  };
  el.src = convertFileSrc(path);
  el.currentTime = 0;
  useClipState.setState({ key, loading: false });
  try {
    await el.play();
  } catch {
    if (fallbackText && speakAsClip(key, fallbackText, mine)) return true;
    done();
    return false;
  }
  return true;
}

/** 生词按当前朗读引擎和语速播放。 */
export function speak(text: string) {
  stopClip();
  void speakWord(text);
}
