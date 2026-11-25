/**
 * [INPUT]: store、api.setProgress；audioHost.recoverStuckPlay；timemap.toContent
 * [OUTPUT]: track / waiting / cancelLoading / pressPlay / useLoadingFor / playSoon / SAVE_EVERY / activeIndex / SUBTITLE_LEAD
 * [POS]: armPlayerIntentListener 由 App mount 挂上；waiting 超时看门狗；加载中点播放=取消；字幕高亮带 150ms 读前量
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useState } from "react";
import { api, type Episode } from "./api";
import { tNow } from "./i18n";
import { currentMap, toContent } from "./timemap";
import { useStore } from "../store";

/** Play loading this long gets a slow-load note with ways out. */
export const SLOW_LOAD_MS = 8_000;

export const SAVE_EVERY = 10;
/** 大 m4a moov 常 >1MB：首段缓冲可能超过 15s，看门狗只静默续命 */
const STUCK_MS = 20_000;

let lastSaved = 0;
let stuckTimer: number | undefined;

/**
 * `raw` 是媒体元素时钟（YouTube 侧可为外推平滑值）；store.time 永远是字幕时间。
 * 返回广告空隙终点（播放时钟），供 skipAds 跳过。
 */
export function track(ep: Episode, raw: number, length?: number): number | undefined {
  const s = useStore.getState();
  if (s.current?.id !== ep.id) return;
  const { at: time, gapEnd } = toContent(currentMap(ep.id), raw);
  // 同毫秒级抖动不写 store，减轻叠字订阅压力
  if (
    Math.abs(time - s.time) < 0.02 &&
    Math.abs((s.rawTime ?? raw) - raw) < 0.02 &&
    (gapEnd ?? null) === (s.gapEnd ?? null) &&
    !(length && length > 0 && length !== s.length)
  ) {
    return gapEnd;
  }
  s.set({
    time,
    rawTime: raw,
    gapEnd: gapEnd ?? null,
    ...(length && length > 0 ? { length } : {}),
  });
  if (Math.abs(time - lastSaved) > SAVE_EVERY) {
    lastSaved = time;
    void api.setProgress(ep.id, time);
  }
  return gapEnd;
}

export function resetTrackSave() {
  lastSaved = 0;
}

/** `time` 须为字幕时间（pause 时先 toContent 再传入）。 */
export function flushProgress(ep: Episode, time: number) {
  lastSaved = time;
  void api.setProgress(ep.id, time);
}

/** 缓冲中：控制条可显示等待态；超时则恢复一次，避免一直转圈无声。 */
export function waiting(on: boolean) {
  const s = useStore.getState();
  if (on ? !s.loadingSince : s.loadingSince) s.set({ loadingSince: on ? Date.now() : null });
  window.clearTimeout(stuckTimer);
  if (!on) return;
  stuckTimer = window.setTimeout(() => {
    const st = useStore.getState();
    if (!st.loadingSince) return;
    // 纯音频引擎走 audioHost 恢复；YouTube 引擎若超 20s 仍在缓冲则解除无尽转圈并提示
    if (!st.audioOnly && st.current?.videoId) {
      st.set({ loadingSince: null });
      st.notify(tNow("视频加载较慢，可切换「仅音频」或稍后重试"));
      return;
    }
    void import("./audioHost").then((m) => m.recoverStuckPlay());
  }, STUCK_MS);
}

/** 取消进行中的起播/缓冲（清 loadingSince 与 playWhenReady）。 */
export function cancelLoading() {
  const s = useStore.getState();
  if (!s.loadingSince && !s.playWhenReady) return;
  window.clearTimeout(stuckTimer);
  s.set({ loadingSince: null, playWhenReady: null, playing: false });
}

/**
 * 主播放按钮：加载中点击 = 取消；已有 player 则 toggle。
 * 无 player 且未在加载时由调用方自行 takeOver。
 */
export function pressPlay(): "cancelled" | "toggled" | "none" {
  const s = useStore.getState();
  if (s.loadingSince) {
    // 有 player 时 toggle 会 pause（YtEngine 把 BUFFERING 当可暂停）
    if (s.player) {
      s.player.toggle();
      return "toggled";
    }
    cancelLoading();
    return "cancelled";
  }
  if (s.player) {
    s.player.toggle();
    return "toggled";
  }
  return "none";
}

/** 本集已缓冲至少 `after` ms（到点触发重渲）。 */
export function useLoadingFor(id: string | undefined, after = 0): boolean {
  const since = useStore((s) => (id && s.current?.id === id ? s.loadingSince ?? null : null));
  const [, tick] = useState(0);
  useEffect(() => {
    if (!since || !after) return;
    const left = since + after - Date.now();
    if (left <= 0) return;
    const timer = window.setTimeout(() => tick((n) => n + 1), left + 50);
    return () => window.clearTimeout(timer);
  }, [since, after]);
  return !!since && Date.now() - since >= after;
}

/**
 * 起播意图：同集已有 player 则立刻 play；
 * 否则 playWhenReady=id，等 offerPlayer 后由模块订阅触发。
 */
export function playSoon(episodeId: string) {
  waiting(true);
  const s = useStore.getState();
  if (s.current?.id === episodeId && s.player?.episodeId === episodeId) {
    s.player.play();
    s.set({ playWhenReady: null });
    return;
  }
  // 兼容尚未带 episodeId 的旧 handle
  if (s.current?.id === episodeId && s.player) {
    s.player.play();
    s.set({ playWhenReady: null });
    return;
  }
  s.set({ playWhenReady: episodeId });
}

/**
 * 消费 playWhenReady / seekWhenReady。必须在 App mount 后挂，
 * 禁止模块顶层 subscribe——store→audioHost→playback→store 环会在冷启动白屏。
 */
export function armPlayerIntentListener(): () => void {
  return useStore.subscribe((s, prev) => {
    if (!s.player || s.player === prev.player) return;
    const p = s.player;
    const wantSeek = s.seekWhenReady && s.current?.id === s.seekWhenReady.id ? s.seekWhenReady.at : null;
    const wantPlay = !!(s.playWhenReady && s.current?.id === s.playWhenReady);
    if (wantSeek != null) {
      useStore.setState({ seekWhenReady: null, ...(wantPlay ? { playWhenReady: null } : {}) });
      window.setTimeout(() => {
        const st = useStore.getState();
        // 迟到的 offer：已换引擎 / 换集则丢弃，避免双路起播
        if (st.player !== p || st.current?.id !== p.episodeId) return;
        p.seek(wantSeek);
        if (wantPlay) p.play();
      }, 0);
      return;
    }
    if (wantPlay) {
      useStore.setState({ playWhenReady: null });
      // waiting 由引擎 PLAYING / playing 事件清除，此处勿抢先 false
      window.setTimeout(() => {
        const st = useStore.getState();
        if (st.player !== p || st.current?.id !== p.episodeId) return;
        p.play();
      }, 0);
    }
  });
}

/** 跳转到指定单集的某秒：当前集直接 seek，非当前集先装载并排队 seek+play，避免跨集误跳正在播的另一集。 */
export function seekEpisode(ep: Episode, seconds: number, autoPlay = true) {
  const s = useStore.getState();
  if (s.current?.id === ep.id && s.player && s.player.episodeId === ep.id) {
    s.player.seek(seconds);
    if (autoPlay && !s.playing) s.player.play();
    return;
  }
  if (s.current?.id !== ep.id) {
    s.load(ep);
  }
  useStore.setState({
    time: seconds,
    seekWhenReady: { id: ep.id, at: seconds },
    ...(autoPlay ? { playWhenReady: ep.id } : {}),
  });
  if (autoPlay) waiting(true);
}

/** 字幕高亮略早于媒体时钟，阅读跟得上说话（与原站一致）。 */
export const SUBTITLE_LEAD = 0.15;

export function activeIndex(starts: number[], time: number) {
  if (!starts.length) return -1;
  const t = time + SUBTITLE_LEAD;
  let lo = 0;
  let hi = starts.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
