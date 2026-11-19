/**
 * [INPUT]: Episode、offline.audioSrc、store、playback、volume
 * [OUTPUT]: prepareAudio / pauseAudioHost / releaseAudioHost / getAudioEl
 * [POS]: 单例 Audio；load 时预缓冲+offer；play 由 playSoon 触发
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { Episode } from "./api";
import { noteListening } from "./listening";
import { audioSrc } from "./offline";
import { flushProgress, resetTrackSave, track, waiting } from "./playback";
import { followVolume } from "./volume";
import { offerPlayer, useStore, withdrawPlayer, type PlayerHandle } from "../store";

let el: HTMLAudioElement | null = null;
let handle: PlayerHandle | null = null;
let offVol: (() => void) | null = null;
let wired = false;
let epId: string | null = null;

export function getAudioEl(): HTMLAudioElement {
  if (!el) {
    el = new Audio();
    el.preload = "auto";
    wire(el);
  }
  return el;
}

function wire(a: HTMLAudioElement) {
  if (wired) return;
  wired = true;
  a.addEventListener("play", () => {
    waiting(false);
    useStore.getState().set({ playing: true });
  });
  a.addEventListener("pause", () => {
    useStore.getState().set({ playing: false });
    const cur = useStore.getState().current;
    if (cur && epId === cur.id) flushProgress(cur, a.currentTime);
  });
  a.addEventListener("waiting", () => waiting(true));
  a.addEventListener("playing", () => waiting(false));
  a.addEventListener("timeupdate", () => {
    const cur = useStore.getState().current;
    if (!cur || epId !== cur.id) return;
    track(cur, a.currentTime, a.duration);
    noteListening(cur, !a.paused);
  });
  a.addEventListener("loadedmetadata", () => {
    if (epId && useStore.getState().current?.id === epId) {
      useStore.getState().set({ length: a.duration || 0 });
    }
  });
  a.addEventListener("ended", () => {
    const cur = useStore.getState().current;
    if (!cur || epId !== cur.id) return;
    flushProgress(cur, cur.duration || a.currentTime);
    void import("./queue").then((m) => m.playNext());
  });
}

function bindHandle(a: HTMLAudioElement, id: string) {
  if (handle) withdrawPlayer(handle);
  offVol?.();
  const h: PlayerHandle = {
    episodeId: id,
    seek(seconds) {
      useStore.getState().set({ time: seconds });
      a.currentTime = seconds;
    },
    toggle() {
      if (a.paused) void a.play().catch(() => {});
      else a.pause();
    },
    play() {
      void a.play().catch(() => {});
    },
    setRate(r) {
      useStore.getState().set({ rate: r });
      void useStore.getState().saveSettings({ playbackRate: r });
      a.playbackRate = r;
    },
  };
  handle = h;
  epId = id;
  offerPlayer(h);
  offVol = followVolume(a);
}

/**
 * load 路径：换源 + preload + offer，不自动 play。
 * metadata 就绪后按 store.time / progress seek。
 */
export function prepareAudio(ep: Episode): boolean {
  const src = audioSrc(ep);
  if (!src) return false;

  const a = getAudioEl();
  const time = useStore.getState().current?.id === ep.id
    ? useStore.getState().time || ep.progress || 0
    : ep.progress || 0;

  resetTrackSave();
  const same = a.src === src || (a.src.length > 0 && a.src.endsWith(src));
  if (!same) a.src = src;
  a.playbackRate = useStore.getState().rate;
  bindHandle(a, ep.id);

  const seek = () => {
    try {
      if (time > 0.5 && Math.abs(a.currentTime - time) > 0.75) a.currentTime = time;
    } catch {
      /* 未就绪 */
    }
  };
  if (a.readyState >= 1) seek();
  else a.addEventListener("loadedmetadata", seek, { once: true });

  return true;
}

/** @deprecated 用 prepareAudio；保留别名以免旧调用崩 */
export function kickAudio(ep: Episode, opts?: { time?: number; play?: boolean }): boolean {
  const ok = prepareAudio(ep);
  if (!ok) return false;
  if (opts?.play) {
    const a = getAudioEl();
    waiting(true);
    void a.play().catch(() => waiting(false));
  }
  return true;
}

export function pauseAudioHost() {
  el?.pause();
}

export function releaseAudioHost() {
  if (handle) {
    withdrawPlayer(handle);
    handle = null;
  }
  offVol?.();
  offVol = null;
  epId = null;
}
