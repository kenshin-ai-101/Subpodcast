/**
 * [INPUT]: Episode、offline.audioSrc / remoteAudioSrc / isLocalAssetSrc / isSaved、store、playback、volume
 * [OUTPUT]: prepareAudio / pauseAudioHost / releaseAudioHost / getAudioEl / recoverStuckPlay
 * [POS]: 单例 Audio；立刻 play；播中不抢切源、暂停再切本地；本地 asset 失败回退远端
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { Episode } from "./api";
import { noteListening } from "./listening";
import { audioSrc, isLocalAssetSrc, isSaved, remoteAudioSrc } from "./offline";
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
/** 超长单集：先出声再跳进度，避免 moov+中段 Range 堵死首播 */
let pendingSeek: number | null = null;
let recoverCount = 0;
/** prepare / adopt 改 src 时抑制 pause→adopt 重入 */
let mutedSrcSwap = false;
/** 本集已从本地 asset 回退过远端，避免死循环 */
let fellBackRemoteFor: string | null = null;

function resolveHref(src: string): string {
  try {
    return new URL(src, window.location.href).href;
  } catch {
    return src;
  }
}

function sameSrc(a: string, b: string): boolean {
  if (a === b) return true;
  return resolveHref(a) === resolveHref(b);
}

function assignSrc(a: HTMLAudioElement, src: string) {
  mutedSrcSwap = true;
  try {
    a.src = src;
  } finally {
    mutedSrcSwap = false;
  }
  boundSrc = src;
}

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

function applyPendingSeek(a: HTMLAudioElement) {
  const t = pendingSeek;
  if (t == null) return;
  pendingSeek = null;
  try {
    if (t > 0.5 && Number.isFinite(a.duration) && t < a.duration - 1) {
      if (Math.abs(a.currentTime - t) > 0.75) a.currentTime = t;
    }
  } catch {
    /* 未就绪则丢弃，下次用户拖进度条 */
  }
}

/**
 * 本地 asset 播不了（协议 scope / 文件损坏）时改挂远端 enclosure。
 * 返回 true 表示已换源并重新 play。
 */
function fallbackToRemote(a: HTMLAudioElement): boolean {
  const cur = useStore.getState().current;
  if (!cur || epId !== cur.id) return false;
  if (fellBackRemoteFor === cur.id) return false;
  if (!boundSrc || !isLocalAssetSrc(boundSrc)) return false;
  const remote = remoteAudioSrc(cur);
  if (!remote || sameSrc(boundSrc, remote)) return false;

  fellBackRemoteFor = cur.id;
  const time = useStore.getState().time || a.currentTime || cur.progress || 0;
  assignSrc(a, remote);
  if (time > 0.5) pendingSeek = time;
  playNow(a);
  return true;
}

/**
 * 下载完成于暂停态：切到本地文件并保住进度（对齐 Subcast：播中不切，停了再切）。
 */
function adoptLocalIfReady() {
  if (mutedSrcSwap) return;
  const a = el;
  const cur = useStore.getState().current;
  if (!a || !cur || epId !== cur.id) return;
  if (!isSaved(cur.id)) return;
  // 本集本地刚失败过：本会话不再抢回 asset
  if (fellBackRemoteFor === cur.id) return;
  const next = audioSrc(cur);
  if (!next || (boundSrc && sameSrc(boundSrc, next))) return;

  const time = a.currentTime;
  assignSrc(a, next);
  if (time > 0.5) pendingSeek = time;
}

function wire(a: HTMLAudioElement) {
  if (wired) return;
  wired = true;
  a.addEventListener("play", () => {
    useStore.getState().set({ playing: true });
    if (a.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) waiting(true);
    else waiting(false);
  });
  a.addEventListener("pause", () => {
    useStore.getState().set({ playing: false });
    const cur = useStore.getState().current;
    if (cur && epId === cur.id) flushProgress(cur, a.currentTime);
    adoptLocalIfReady();
  });
  a.addEventListener("waiting", () => waiting(true));
  a.addEventListener("playing", () => {
    waiting(false);
    recoverCount = 0;
    applyPendingSeek(a);
  });
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
    if (fallbackToRemote(a)) return;
    failPlay("音频加载失败，可能是网络问题或地址已失效");
  });
}

/**
 * 立刻 play，不等 canplay。
 * 小宇宙超长 m4a 的 moov 可达数 MB：等 canplay 再 play 只会 12s 误报「再点一次」。
 */
function playNow(a: HTMLAudioElement) {
  waiting(true);
  const gen = ++playGen;
  void a.play().then(() => {
    if (gen !== playGen) return;
    if (!a.paused && a.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) waiting(false);
  }).catch((err: DOMException) => {
    if (gen !== playGen) return;
    if (err?.name === "AbortError") return;
    if (fallbackToRemote(a)) return;
    failPlay("音频暂时播不了，请再点一次或检查网络");
  });
}

function bindHandle(a: HTMLAudioElement, id: string) {
  if (handle) withdrawPlayer(handle);
  offVol?.();
  const h: PlayerHandle = {
    episodeId: id,
    seek(seconds) {
      pendingSeek = null;
      useStore.getState().set({ time: seconds });
      try {
        a.currentTime = seconds;
      } catch {
        pendingSeek = seconds;
      }
    },
    toggle() {
      if (a.paused) playNow(a);
      else a.pause();
    },
    play() {
      playNow(a);
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
 * 同集正在播时：下载完成不换 src；暂停后再 adopt。
 */
export function prepareAudio(ep: Episode): boolean {
  const src = audioSrc(ep);
  if (!src) return false;

  const a = getAudioEl();
  const resolved = resolveHref(src);

  if (epId === ep.id && handle && boundSrc && (sameSrc(boundSrc, src) || a.src === resolved)) {
    return true;
  }

  // 播中：远端 → 本地不打断；停住后再切
  if (epId === ep.id && handle && boundSrc && !a.paused && !sameSrc(boundSrc, src)) {
    return true;
  }

  // 本集刚回退过远端：不要再被 audioSrc 的本地优先抢回去
  if (epId === ep.id && fellBackRemoteFor === ep.id) {
    const remote = remoteAudioSrc(ep);
    if (remote && boundSrc && sameSrc(boundSrc, remote)) return true;
  }

  const time = useStore.getState().current?.id === ep.id
    ? useStore.getState().time || ep.progress || 0
    : ep.progress || 0;

  resetTrackSave();
  playGen += 1;
  recoverCount = 0;
  pendingSeek = null;
  if (epId !== ep.id) fellBackRemoteFor = null;

  const prefer =
    fellBackRemoteFor === ep.id ? (remoteAudioSrc(ep) ?? src) : src;

  const same = a.src === resolveHref(prefer)
    || (a.src.length > 0 && (a.src === prefer || a.src.endsWith(prefer)));
  if (!same) assignSrc(a, prefer);
  else boundSrc = prefer;

  a.playbackRate = useStore.getState().rate;
  bindHandle(a, ep.id);

  if (time > 0.5) pendingSeek = time;

  return true;
}

/**
 * waiting 看门狗：静默再 play；多次仍卡住才轻提示。
 */
export function recoverStuckPlay() {
  const a = el;
  const s = useStore.getState();
  if (!a || !s.current || epId !== s.current.id) return;
  if (!a.paused && a.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
    waiting(false);
    return;
  }
  recoverCount += 1;
  if (recoverCount >= 2 && pendingSeek != null && a.currentTime < 1) {
    /* 保持 pendingSeek，继续从 0 缓冲 */
  }
  // 本地一直卡住：试一次远端
  if (recoverCount >= 2 && boundSrc && isLocalAssetSrc(boundSrc) && fallbackToRemote(a)) {
    return;
  }
  playNow(a);
  if (recoverCount >= 2) {
    s.notify("超长单集仍在缓冲，马上就好");
  }
}

/** @deprecated 用 prepareAudio；保留别名以免旧调用崩 */
export function kickAudio(ep: Episode, opts?: { time?: number; play?: boolean }): boolean {
  const ok = prepareAudio(ep);
  if (!ok) return false;
  if (opts?.play) playNow(getAudioEl());
  return true;
}

export function pauseAudioHost() {
  el?.pause();
}

export function releaseAudioHost() {
  playGen += 1;
  pendingSeek = null;
  recoverCount = 0;
  if (handle) {
    withdrawPlayer(handle);
    handle = null;
  }
  offVol?.();
  offVol = null;
  epId = null;
  boundSrc = null;
  fellBackRemoteFor = null;
}
