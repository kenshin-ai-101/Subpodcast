/**
 * [INPUT]: Episode、offline.audioSrc、store、playback、volume
 * [OUTPUT]: prepareAudio / pauseAudioHost / releaseAudioHost / getAudioEl / recoverStuckPlay
 * [POS]: 单例 Audio；load 预缓冲+offer；play 等 canplay；错误可见；同集不重绑
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
/** 当前挂上的逻辑 src（归一后），用于幂等 prepare */
let boundSrc: string | null = null;
let playGen = 0;

export function getAudioEl(): HTMLAudioElement {
  if (!el) {
    el = new Audio();
    el.preload = "auto";
    wire(el);
  }
  return el;
}

function failPlay(msg: string) {
  waiting(false);
  useStore.getState().notify(msg);
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
  a.addEventListener("error", () => {
    if (!epId || useStore.getState().current?.id !== epId) return;
    failPlay("音频加载失败，可能是网络问题或地址已失效");
  });
}

/** 等有可播数据再 play；失败必须清 waiting，禁止静默吞掉。 */
function playWhenReady(a: HTMLAudioElement) {
  waiting(true);
  const gen = ++playGen;

  const go = () => {
    if (gen !== playGen) return;
    void a.play().then(() => {
      if (gen !== playGen) return;
      if (!a.paused) waiting(false);
    }).catch((err: DOMException) => {
      if (gen !== playGen) return;
      if (err?.name === "AbortError") return;
      failPlay("音频暂时播不了，请再点一次或检查网络");
    });
  };

  if (a.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
    go();
    return;
  }

  let settled = false;
  const finish = (fn: () => void) => {
    if (settled || gen !== playGen) return;
    settled = true;
    a.removeEventListener("canplay", onCan);
    a.removeEventListener("error", onErr);
    window.clearTimeout(timer);
    fn();
  };
  const onCan = () => finish(go);
  const onErr = () => finish(() => failPlay("音频加载失败，可能是网络问题或地址已失效"));
  // 大文件 / 中段续播：等 canplay；超时仍试一次，避免「点了没反应」
  const timer = window.setTimeout(() => {
    finish(() => {
      if (a.readyState >= HTMLMediaElement.HAVE_METADATA) go();
      else failPlay("音频缓冲较慢，请再点播放；很长的单集会多等一会儿");
    });
  }, 12_000);

  a.addEventListener("canplay", onCan);
  a.addEventListener("error", onErr);
}

function bindHandle(a: HTMLAudioElement, id: string) {
  if (handle) withdrawPlayer(handle);
  offVol?.();
  const h: PlayerHandle = {
    episodeId: id,
    seek(seconds) {
      useStore.getState().set({ time: seconds });
      try {
        a.currentTime = seconds;
      } catch {
        /* 未就绪 */
      }
    },
    toggle() {
      if (a.paused) playWhenReady(a);
      else a.pause();
    },
    play() {
      playWhenReady(a);
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
 * 同集同源已绑定则跳过，避免 AudioEngine 重跑打断 playSoon。
 */
export function prepareAudio(ep: Episode): boolean {
  const src = audioSrc(ep);
  if (!src) return false;

  const a = getAudioEl();
  const resolved = (() => {
    try {
      return new URL(src, window.location.href).href;
    } catch {
      return src;
    }
  })();

  if (epId === ep.id && handle && boundSrc && (boundSrc === src || boundSrc === resolved || a.src === resolved)) {
    return true;
  }

  const time = useStore.getState().current?.id === ep.id
    ? useStore.getState().time || ep.progress || 0
    : ep.progress || 0;

  resetTrackSave();
  playGen += 1; // 作废上一次等 canplay 的 play
  const same = a.src === resolved || (a.src.length > 0 && (a.src === src || a.src.endsWith(src)));
  if (!same) {
    a.src = src;
    boundSrc = src;
  } else {
    boundSrc = src;
  }
  a.playbackRate = useStore.getState().rate;
  bindHandle(a, ep.id);

  const seek = () => {
    try {
      // 续听：等 metadata 再 seek；避免未就绪时赋值被忽略后「以为在播其实停在 0」
      if (time > 0.5 && Number.isFinite(a.duration) && time < a.duration - 1) {
        if (Math.abs(a.currentTime - time) > 0.75) a.currentTime = time;
      }
    } catch {
      /* 未就绪 */
    }
  };
  if (a.readyState >= HTMLMediaElement.HAVE_METADATA) seek();
  else a.addEventListener("loadedmetadata", seek, { once: true });

  return true;
}

/** waiting 卡住时由 playback 看门狗调用：再试一次 play，不擅自清进度。 */
export function recoverStuckPlay() {
  const a = el;
  const s = useStore.getState();
  if (!a || !s.current || epId !== s.current.id) {
    s.notify("音频还在缓冲，请再点播放");
    return;
  }
  playWhenReady(a);
}

/** @deprecated 用 prepareAudio；保留别名以免旧调用崩 */
export function kickAudio(ep: Episode, opts?: { time?: number; play?: boolean }): boolean {
  const ok = prepareAudio(ep);
  if (!ok) return false;
  if (opts?.play) playWhenReady(getAudioEl());
  return true;
}

export function pauseAudioHost() {
  el?.pause();
}

export function releaseAudioHost() {
  playGen += 1;
  if (handle) {
    withdrawPlayer(handle);
    handle = null;
  }
  offVol?.();
  offVol = null;
  epId = null;
  boundSrc = null;
}
