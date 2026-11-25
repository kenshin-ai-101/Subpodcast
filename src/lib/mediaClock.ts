/**
 * [INPUT]: 播放器原始时钟（YouTube getCurrentTime / audio.currentTime）、playbackRate、playing
 * [OUTPUT]: createMediaClock — 粗粒度采样墙钟外推 + 异步 seek 目标锁（防 YouTube seekTo 期间旧读数回跳）
 * [POS]: YtEngine / audioHost 采样层；store.time 仍经 playback.track 写入
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

/** YouTube IFrame 的 getCurrentTime 常几十到几百毫秒才跳一格；外推让叠字不卡顿、不拖后。 */
export type MediaClock = {
  setRate: (rate: number) => void;
  setPlaying: (playing: boolean) => void;
  /** 喂入播放器采样，返回用于字幕的平滑时间（秒）。 */
  sample: (raw: number) => number;
  /** 发起异步 seek（如 YouTube seekTo）：在播放器追上目标前锁住目标时间，避免旧读数把字幕拉回。 */
  seek: (target: number, origin?: number) => void;
  reset: (raw?: number) => void;
};

/** 单次无新采样时的最大外推时长（秒）：挡住缓冲卡顿期间字幕失控前跑。 */
const MAX_EXTRAPOLATE = 0.5;
/** YouTube 往往贴齐关键帧，到达目标 ±2.5s 内即视为 seek 落地。 */
const SEEK_SETTLE_NEAR = 2.5;
/** 长 GOP 视频关键帧偏差放宽上限（秒）。 */
const SEEK_SETTLE_KEYFRAME = 8;
/** 短距离 seek（≤2.5s）最迟收敛时间（ms）。 */
const SEEK_SHORT_MS = 500;
/** 关键帧落点放宽等待时间（ms）。 */
const SEEK_KEYFRAME_MS = 400;
/** 正在播放时的安全兜底超时（ms）：避免目标超出片尾等极端情况永久锁死。 */
const SEEK_PLAYING_TIMEOUT_MS = 3000;

export function createMediaClock(nowFn: () => number = () => performance.now()): MediaClock {
  let media = 0;
  let wall = nowFn();
  let rate = 1;
  let playing = false;
  let pending: { target: number; origin: number; at: number } | null = null;

  const extrapolated = () => {
    const dt = Math.max(0, (nowFn() - wall) / 1000) * rate;
    return media + Math.min(MAX_EXTRAPOLATE, dt);
  };

  const reanchor = (raw: number) => {
    media = raw;
    wall = nowFn();
    return raw;
  };

  return {
    setRate(r) {
      // 调速瞬间按当前外推点重锚，避免突变；待落地 seek 期间保持锁点
      if (playing && !pending) {
        media = extrapolated();
        wall = nowFn();
      }
      rate = Number.isFinite(r) && r > 0 ? r : 1;
    },
    setPlaying(p) {
      if (p === playing) return;
      if (playing && !pending) {
        media = extrapolated();
        wall = nowFn();
      } else {
        wall = nowFn();
      }
      playing = p;
    },
    sample(raw) {
      if (pending) {
        if (!Number.isFinite(raw)) return pending.target;
        const elapsed = Math.max(0, nowFn() - pending.at);
        const distTarget = Math.abs(raw - pending.target);
        const distOrigin = Math.abs(raw - pending.origin);
        const shortJump = Math.abs(pending.origin - pending.target) <= SEEK_SETTLE_NEAR;
        const arrivedNear = shortJump
          ? distTarget <= 0.6 ||
            (pending.target < pending.origin && raw < pending.origin - 0.15) ||
            elapsed >= SEEK_SHORT_MS
          : distTarget <= SEEK_SETTLE_NEAR;
        const arrivedKeyframe =
          !shortJump &&
          distOrigin > 0.5 &&
          distTarget <= SEEK_SETTLE_KEYFRAME &&
          elapsed >= SEEK_KEYFRAME_MS;
        const timedOutPlaying = playing && elapsed >= SEEK_PLAYING_TIMEOUT_MS;
        if (arrivedNear || arrivedKeyframe || timedOutPlaying) {
          pending = null;
          return reanchor(raw);
        }
        return pending.target;
      }
      if (!Number.isFinite(raw)) return playing ? extrapolated() : media;
      if (!playing) return reanchor(raw);
      // 明显跳转（seek / 缓冲后回跳）：跟播放器
      if (raw > media + 0.4 || raw < media - 0.2) return reanchor(raw);
      // 播放器时钟前进：重锚到真实值
      if (raw > media + 0.001) return reanchor(raw);
      // 同一读数或微小抖动：墙钟外推（带上限）
      return extrapolated();
    },
    seek(target, origin) {
      const safeTarget = Number.isFinite(target) ? Math.max(0, target) : 0;
      const safeOrigin = Number.isFinite(origin) ? origin! : media;
      media = safeTarget;
      wall = nowFn();
      pending = { target: safeTarget, origin: safeOrigin, at: wall };
    },
    reset(raw = 0) {
      playing = false;
      pending = null;
      reanchor(raw);
    },
  };
}
