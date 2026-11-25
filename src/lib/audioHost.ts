/**
 * [INPUT]: Episode、offline.*、ytHost.pauseYoutubeHost、store、playback、timemap、volume
 * [OUTPUT]: prepareAudio / takeAudioEngine / pauseAudioHost / releaseAudioHost / resumeAudioIfWanted / getAudioEl / recoverStuckPlay
 * [POS]: 单例 Audio；每次 prepare/交权前硬停 YouTube；rAF 采样经 toContent 写字幕时钟；seek 经 toPlay；对齐结果到达时无缝切源与重映射
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Episode } from "./api";
import { tNow } from "./i18n";
import { noteListening } from "./listening";
import { audioSrc, isLocalAssetSrc, isSaved, noteCachedAudio, remoteAudioSrc } from "./offline";
import { flushProgress, resetTrackSave, track, waiting } from "./playback";
import { currentMap, registerAudioAlignBridge, toContent, toPlay } from "./timemap";
import { followVolume } from "./volume";
import { pauseYoutubeHost } from "./ytHost";
import { offerPlayer, useStore, withdrawPlayer, type PlayerHandle } from "../store";

let el: HTMLAudioElement | null = null;
let handle: PlayerHandle | null = null;
let offVol: (() => void) | null = null;
let wired = false;
let epId: string | null = null;
/** 当前挂上的逻辑 src（归一后），用于幂等 prepare */
let boundSrc: string | null = null;
let playGen = 0;
/**
 * 待落地的跳转目标：
 * - `sub`：字幕时钟，落地前会按最新 TimeMap 映射（消除 load 与 loadAlign/alignAudio 竞态）
 * - `play`：播放文件时钟（进度条 / 广告跳过）
 */
let pendingSeek: { sub: number } | { play: number } | null = null;
let recoverCount = 0;
/** prepare / adopt 改 src 时抑制 pause→adopt 重入 */
let mutedSrcSwap = false;
/** 本集已从本地 asset 回退过远端，避免死循环 */
let fellBackRemoteFor: string | null = null;
/** 播放中 rAF 补采样：timeupdate 约 4Hz，长单集主线程忙时字幕会拖后 */
let sampleRaf = 0;
let lastSampleAt = 0;
/** 音频 currentTime 本身连续；50ms 足够驱动短句切换，又不会每帧打爆 store */
const SAMPLE_MS = 50;

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

function resolvePendingPlayTime(id: string, p: { sub: number } | { play: number }): number {
  return "sub" in p ? toPlay(currentMap(id), p.sub) : p.play;
}

/**
 * 落地 pendingSeek：
 * - readyState < HAVE_METADATA 或 duration 未就绪时保留不丢弃（streaming m4a/mp3 首帧常见）
 * - forceOnPlaying：已在出声但无有限 duration（极少数 chunked 流）时仍尝试 seek 并释放采样锁
 */
function applyPendingSeek(a: HTMLAudioElement, forceOnPlaying = false) {
  const p = pendingSeek;
  if (!p || !epId) return;
  if (a.readyState < HTMLMediaElement.HAVE_METADATA) return;
  const finiteDur = Number.isFinite(a.duration) && a.duration > 0;
  if (!finiteDur && !forceOnPlaying) return;

  const target = resolvePendingPlayTime(epId, p);
  pendingSeek = null;
  try {
    if (target <= 0.5) return;
    const clamped = finiteDur ? Math.min(target, Math.max(0, a.duration - 0.5)) : target;
    if (Math.abs(a.currentTime - clamped) > 0.5) {
      a.currentTime = clamped;
    }
  } catch {
    /* 尚未可 seek，留待后续 */
    if (!forceOnPlaying) pendingSeek = p;
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
  const subAt =
    useStore.getState().time ||
    toContent(currentMap(cur.id), a.currentTime).at ||
    cur.progress ||
    0;
  assignSrc(a, remote);
  pendingSeek = subAt > 0.5 ? { sub: subAt } : null;
  playNow(a);
  return true;
}

/**
 * 下载完成于暂停态：切到本地文件并保住进度（播中不打断，停了再切）。
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

  const subAt = useStore.getState().time || toContent(currentMap(cur.id), a.currentTime).at || 0;
  assignSrc(a, next);
  pendingSeek = subAt > 0.5 ? { sub: subAt } : null;
}

function stopSample() {
  if (sampleRaf) {
    cancelAnimationFrame(sampleRaf);
    sampleRaf = 0;
  }
}

function sampleClock(a: HTMLAudioElement) {
  const cur = useStore.getState().current;
  if (!cur || epId !== cur.id) return;
  // 元数据未就绪或待跳进度未落地：绝不用 0 覆盖 store.time
  if (a.readyState === 0 || pendingSeek != null) return;
  const gapEnd = track(cur, a.currentTime, a.duration);
  noteListening(cur, !a.paused);
  if (gapEnd && useStore.getState().settings.skipAds && !a.paused) {
    try {
      a.currentTime = gapEnd;
    } catch {
      /* mid-seek */
    }
  }
}

function sampleAudio(a: HTMLAudioElement) {
  stopSample();
  lastSampleAt = 0;
  const step = (now: number) => {
    sampleRaf = requestAnimationFrame(step);
    if (a.paused) return;
    if (now - lastSampleAt < SAMPLE_MS) return;
    lastSampleAt = now;
    sampleClock(a);
  };
  sampleRaf = requestAnimationFrame(step);
}

function wire(a: HTMLAudioElement) {
  if (wired) return;
  wired = true;
  a.addEventListener("play", () => {
    useStore.getState().set({ playing: true });
    if (a.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) waiting(true);
    else waiting(false);
    applyPendingSeek(a);
    sampleAudio(a);
  });
  a.addEventListener("pause", () => {
    stopSample();
    useStore.getState().set({ playing: false });
    const cur = useStore.getState().current;
    if (cur && epId === cur.id && a.readyState > 0 && pendingSeek == null) {
      flushProgress(cur, toContent(currentMap(cur.id), a.currentTime).at);
    }
    adoptLocalIfReady();
  });
  a.addEventListener("waiting", () => waiting(true));
  a.addEventListener("canplay", () => {
    applyPendingSeek(a);
  });
  a.addEventListener("playing", () => {
    waiting(false);
    recoverCount = 0;
    applyPendingSeek(a, true);
    sampleAudio(a);
  });
  a.addEventListener("timeupdate", () => {
    // rAF 已在播：跳过，避免双通道抢写 time
    if (sampleRaf && !a.paused) return;
    sampleClock(a);
  });
  a.addEventListener("loadedmetadata", () => {
    if (epId && useStore.getState().current?.id === epId) {
      useStore.getState().set({ length: a.duration || 0 });
      applyPendingSeek(a);
      if (pendingSeek == null) sampleClock(a);
    }
  });
  a.addEventListener("ended", () => {
    const cur = useStore.getState().current;
    if (!cur || epId !== cur.id) return;
    flushProgress(cur, toContent(currentMap(cur.id), a.duration || a.currentTime).at);
    void import("./queue").then((m) => m.playNext());
  });
  a.addEventListener("error", () => {
    if (!epId || useStore.getState().current?.id !== epId) return;
    if (fallbackToRemote(a)) return;
    failPlay(tNow("音频加载失败，可能是网络问题或地址已失效"));
  });
}

/**
 * 立刻 play，不等 canplay。
 * 小宇宙超长 m4a 的 moov 可达数 MB：等 canplay 再 play 只会 12s 误报「再点一次」。
 */
function playNow(a: HTMLAudioElement) {
  waiting(true);
  const gen = ++playGen;
  void a
    .play()
    .then(() => {
      if (gen !== playGen) return;
      if (!a.paused && a.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) waiting(false);
    })
    .catch((err: DOMException) => {
      if (gen !== playGen) return;
      if (err?.name === "AbortError") return;
      if (fallbackToRemote(a)) return;
      failPlay(tNow("音频暂时播不了，请再点一次或检查网络"));
    });
}

function bindHandle(a: HTMLAudioElement, id: string) {
  if (handle) withdrawPlayer(handle);
  offVol?.();
  const h: PlayerHandle = {
    episodeId: id,
    seek(seconds) {
      // seconds = 字幕时间
      const playAt = toPlay(currentMap(id), seconds);
      useStore.getState().set({ time: seconds, rawTime: playAt, gapEnd: null, scrubTime: null });
      if (a.readyState < HTMLMediaElement.HAVE_METADATA) {
        pendingSeek = { sub: seconds };
        return;
      }
      pendingSeek = null;
      try {
        a.currentTime = playAt;
      } catch {
        pendingSeek = { sub: seconds };
      }
    },
    seekRaw(seconds) {
      const mapped = toContent(currentMap(id), seconds);
      useStore.getState().set({
        time: mapped.at,
        rawTime: seconds,
        gapEnd: mapped.gapEnd ?? null,
        scrubTime: null,
      });
      if (a.readyState < HTMLMediaElement.HAVE_METADATA) {
        pendingSeek = { play: seconds };
        return;
      }
      pendingSeek = null;
      try {
        a.currentTime = seconds;
      } catch {
        pendingSeek = { play: seconds };
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

/** 供 timemap 同步：对齐完成/手调后立即刷新字幕时钟，必要时无缝切换到对齐好的本地音频缓存。 */
registerAudioAlignBridge({
  getRawTime(id) {
    if (!el || epId !== id) return null;
    if (el.readyState >= HTMLMediaElement.HAVE_METADATA) return el.currentTime;
    if (pendingSeek) return resolvePendingPlayTime(id, pendingSeek);
    return null;
  },
  onMapUpdated(id, alignedPath, localBytes) {
    const a = el;
    const st = useStore.getState();
    if (!a || epId !== id || st.current?.id !== id) return;

    if (alignedPath) {
      if (!isSaved(id)) noteCachedAudio(id, alignedPath, localBytes);
      const fileUrl = convertFileSrc(alignedPath);
      if (boundSrc && !sameSrc(boundSrc, fileUrl) && fellBackRemoteFor !== id) {
        const wasPlaying = !a.paused;
        const subAt = st.time || 0;
        pendingSeek = subAt > 0.5 ? { sub: subAt } : null;
        assignSrc(a, fileUrl);
        if (wasPlaying) playNow(a);
        return;
      }
    }

    // 同文件：若还在等 pendingSeek，保持字幕目标，落地时自然按新 TimeMap 换算；否则立即按新 TimeMap 重算 UI 时钟
    if (pendingSeek) {
      applyPendingSeek(a);
      return;
    }
    const raw =
      a.readyState >= HTMLMediaElement.HAVE_METADATA
        ? a.currentTime
        : (st.rawTime ?? a.currentTime);
    const { at, gapEnd } = toContent(currentMap(id), raw);
    st.set({ time: at, rawTime: raw, gapEnd: gapEnd ?? null });
  },
});

export type PrepareAudioOpts = {
  /** 覆盖 audioSrc；视频→音频切换时在线优先远端，避开未授权的本地 asset */
  src?: string;
  /** 强制重绑（忽略同 src 幂等），用于引擎交接后清掉 error 态 */
  force?: boolean;
};

/**
 * load 路径：换源 + preload + offer，不自动 play。
 * 同集正在播时：下载完成不换 src；暂停后再 adopt。
 */
export function prepareAudio(ep: Episode, opts?: PrepareAudioOpts): boolean {
  const src =
    opts?.src ??
    (fellBackRemoteFor === ep.id ? (remoteAudioSrc(ep) ?? audioSrc(ep)) : audioSrc(ep));
  if (!src) return false;

  const a = getAudioEl();
  const resolved = resolveHref(src);
  const mediaError = a.error != null || a.networkState === HTMLMediaElement.NETWORK_NO_SOURCE;

  if (
    !opts?.force &&
    !mediaError &&
    epId === ep.id &&
    handle &&
    boundSrc &&
    (sameSrc(boundSrc, src) || a.src === resolved)
  ) {
    return true;
  }

  // 播中：远端 → 本地不打断；停住后再切（强制交接除外）
  if (
    !opts?.force &&
    epId === ep.id &&
    handle &&
    boundSrc &&
    !a.paused &&
    !sameSrc(boundSrc, src)
  ) {
    return true;
  }

  const subTime =
    useStore.getState().current?.id === ep.id
      ? useStore.getState().time || ep.progress || 0
      : ep.progress || 0;

  resetTrackSave();
  playGen += 1;
  recoverCount = 0;
  pendingSeek = null;
  if (epId !== ep.id) fellBackRemoteFor = null;
  // 每次重绑都硬停 iframe（含同集从 YT shell 交出），挡 loadVideoById 迟到起播
  pauseYoutubeHost();

  const same =
    !opts?.force &&
    !mediaError &&
    (a.src === resolved || (a.src.length > 0 && (a.src === src || a.src.endsWith(src))));
  if (!same) assignSrc(a, src);
  else boundSrc = src;

  a.playbackRate = useStore.getState().rate;
  bindHandle(a, ep.id);

  if (subTime > 0.5) {
    pendingSeek = { sub: subTime };
    applyPendingSeek(a);
  }

  return true;
}

/** 引擎交权后：若 UI 仍显示在播 / 有起播意图，由音频台接手出声。 */
export function resumeAudioIfWanted() {
  const a = el;
  const s = useStore.getState();
  if (!a || !s.current || epId !== s.current.id) return;
  const wanted = !!s.loadingSince || s.playing || s.playWhenReady === s.current.id;
  if (!wanted) return;
  pauseYoutubeHost();
  s.set({ playWhenReady: null });
  playNow(a);
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
  // 本地一直卡住：试一次远端
  if (recoverCount >= 2 && boundSrc && isLocalAssetSrc(boundSrc) && fallbackToRemote(a)) {
    return;
  }
  playNow(a);
  if (recoverCount >= 2) {
    s.notify(tNow("超长单集仍在缓冲，马上就好"));
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
  stopSample();
  if (handle) {
    withdrawPlayer(handle);
    handle = null;
  }
  offVol?.();
  offVol = null;
  epId = null;
  boundSrc = null;
  fellBackRemoteFor = null;
  // 清空 src，避免视频→音频切换时带着 MEDIA_ERR / 旧缓冲去 play()
  if (el) {
    mutedSrcSwap = true;
    try {
      el.pause();
      el.removeAttribute("src");
      el.load();
    } catch {
      /* ignore */
    } finally {
      mutedSrcSwap = false;
    }
  }
}

/**
 * 视频→仅音频 / 换集到音频：先停 YouTube，再 release→prepare→可选 play（点击手势内同步起播）。
 */
export function takeAudioEngine(ep: Episode, opts?: { play?: boolean }): boolean {
  pauseYoutubeHost();
  releaseAudioHost();
  const ok = prepareAudio(ep);
  if (!ok) return false;
  if (opts?.play) playNow(getAudioEl());
  return true;
}
