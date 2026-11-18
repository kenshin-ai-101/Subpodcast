/**
 * [INPUT]: store、api.setProgress
 * [OUTPUT]: track / waiting / playSoon / SAVE_EVERY — 进度心跳与就绪后开播
 * [POS]: 音频与 YouTube 共用的播放进度心跳
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { api, type Episode } from "./api";
import { useStore } from "../store";

export const SAVE_EVERY = 10;

let lastSaved = 0;
let playSoonOff: (() => void) | undefined;

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

/** 缓冲中：控制条可显示等待态。 */
export function waiting(on: boolean) {
  const s = useStore.getState();
  if (on ? !s.loadingSince : s.loadingSince) s.set({ loadingSince: on ? Date.now() : null });
}

/**
 * 打开单集后尽快开播：同集已有 player 则下一拍 play；
 * 换集则等 PlayerBar 挂上新 handle（YouTube 冷启动尤其需要）。
 */
export function playSoon(episodeId: string) {
  playSoonOff?.();
  playSoonOff = undefined;
  waiting(true);
  useStore.getState().set({ playWhenReady: true });

  const kick = () => {
    const cur = useStore.getState();
    if (cur.current?.id !== episodeId || !cur.player || !cur.playWhenReady) return false;
    cur.player.play();
    cur.set({ playing: true, playWhenReady: false });
    waiting(false);
    return true;
  };

  playSoonOff = useStore.subscribe((next, prev) => {
    if (!next.player || next.player === prev.player) return;
    if (next.current?.id !== episodeId) return;
    window.setTimeout(() => {
      if (kick()) {
        playSoonOff?.();
        playSoonOff = undefined;
      }
    }, 0);
  });

  window.setTimeout(() => {
    if (kick()) {
      playSoonOff?.();
      playSoonOff = undefined;
    }
  }, 0);
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
