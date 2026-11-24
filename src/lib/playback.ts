/**
 * [INPUT]: store、api.setProgress；audioHost.recoverStuckPlay
 * [OUTPUT]: track / waiting / playSoon / SAVE_EVERY — 进度心跳与按集起播意图
 * [POS]: armPlayerIntentListener 由 App mount 挂上；waiting 超时看门狗防「点了没反应」
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { api, type Episode } from "./api";
import { tNow } from "./i18n";
import { useStore } from "../store";

export const SAVE_EVERY = 10;
/** 大 m4a moov 常 >1MB：首段缓冲可能超过 15s，看门狗只静默续命 */
const STUCK_MS = 20_000;

let lastSaved = 0;
let stuckTimer: number | undefined;

/** 播放中周期性写进度；换集时重置。 */
export function track(ep: Episode, time: number, length?: number) {
  const s = useStore.getState();
  if (s.current?.id !== ep.id) return;
  s.set({ time, ...(length && length > 0 ? { length } : {}) });
  if (Math.abs(time - lastSaved) > SAVE_EVERY) {
    lastSaved = time;
    void api.setProgress(ep.id, time);
  }
}

export function resetTrackSave() {
  lastSaved = 0;
}

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
        p.seek(wantSeek);
        if (wantPlay) p.play();
      }, 0);
      return;
    }
    if (wantPlay) {
      useStore.setState({ playWhenReady: null });
      // waiting 由引擎 PLAYING / playing 事件清除，此处勿抢先 false
      window.setTimeout(() => p.play(), 0);
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

export function activeIndex(starts: number[], time: number) {
  let lo = 0;
  let hi = starts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= time) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
