/**
 * [INPUT]: Episode、offline.audioSrc、store、playback、volume
 * [OUTPUT]: prepareAudio / pauseAudioHost / releaseAudioHost / getAudioEl / recoverStuckPlay
 * [POS]: 单例 Audio；立刻 play（大 m4a 不等 canplay）；续听延后 seek；同集不重绑
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
/** 超长单集：先出声再跳进度，避免 moov+中段 Range 堵死首播 */
let pendingSeek: number | null = null;
let recoverCount = 0;

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

function wire(a: HTMLAudioElement) {
  if (wired) return;
  wired = true;
  a.addEventListener("play", () => {
    // play 事件早于足够缓冲；仍缺数据时保持转圈
    useStore.getState().set({ playing: true });
    if (a.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) waiting(true);
    else waiting(false);
  });
  a.addEventListener("pause", () => {
    useStore.getState().set({ playing: false });
    const cur = useStore.getState().current;
    if (cur && epId === cur.id) flushProgress(cur, a.currentTime);
  });
  a.addEventListener("waiting", () => waiting(true));
  a.addEventListener("playing", () => {
    waiting(false);
    recoverCount = 0;
    // 首段已经出声后再跳续听点——大 m4a 的 moov 常 >1MB，先 seek 会空等
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
 * 续听进度 >5s：先挂 pendingSeek，等 playing 后再跳，缩短「点播放到出声」。
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
  playGen += 1;
  recoverCount = 0;
  pendingSeek = null;

  const same = a.src === resolved || (a.src.length > 0 && (a.src === src || a.src.endsWith(src)));
  if (!same) {
    a.src = src;
    boundSrc = src;
  } else {
    boundSrc = src;
  }
  a.playbackRate = useStore.getState().rate;
  bindHandle(a, ep.id);

  // 本地文件 / 短偏移：metadata 后立刻 seek；远程长续听延到出声后
  const remote = /^https?:/i.test(src);
  if (time > 5 && remote) {
    pendingSeek = time;
  } else if (time > 0.5) {
    const seek = () => {
      try {
        if (Number.isFinite(a.duration) && time < a.duration - 1 && Math.abs(a.currentTime - time) > 0.75) {
          a.currentTime = time;
        }
      } catch {
        pendingSeek = time;
      }
    };
    if (a.readyState >= HTMLMediaElement.HAVE_METADATA) seek();
    else a.addEventListener("loadedmetadata", seek, { once: true });
  }

  return true;
}

/**
 * waiting 看门狗：静默再 play；多次仍卡住才轻提示（不要求用户「再点」）。
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
  // 中段 pending 太久：先保证片头能出声，playing 后再跳
  if (recoverCount >= 2 && pendingSeek != null && a.currentTime < 1) {
    /* 保持 pendingSeek，继续从 0 缓冲 */
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
}
