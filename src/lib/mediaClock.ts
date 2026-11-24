/**
 * [INPUT]: 播放器原始时钟（YouTube getCurrentTime / audio.currentTime）、playbackRate、playing
 * [OUTPUT]: createMediaClock — 在粗粒度采样之间用墙钟外推，驱动字幕时间
 * [POS]: YtEngine / audioHost 采样层；store.time 仍经 playback.track 写入
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

/** YouTube IFrame 的 getCurrentTime 常几十到几百毫秒才跳一格；外推让叠字不卡顿、不拖后。 */
export type MediaClock = {
  setRate: (rate: number) => void;
  setPlaying: (playing: boolean) => void;
  /** 喂入播放器采样，返回用于字幕的平滑时间（秒）。 */
  sample: (raw: number) => number;
  reset: (raw?: number) => void;
};

/** 单次无新采样时的最大外推时长（秒）：挡住缓冲卡顿期间字幕失控前跑。 */
const MAX_EXTRAPOLATE = 0.5;

export function createMediaClock(): MediaClock {
  let media = 0;
  let wall = performance.now();
  let rate = 1;
  let playing = false;

  const extrapolated = () => {
    const dt = Math.max(0, (performance.now() - wall) / 1000) * rate;
    return media + Math.min(MAX_EXTRAPOLATE, dt);
  };

  const reanchor = (raw: number) => {
    media = raw;
    wall = performance.now();
    return raw;
  };

  return {
    setRate(r) {
      // 调速瞬间按当前外推点重锚，避免突变
      if (playing) {
        media = extrapolated();
        wall = performance.now();
      }
      rate = Number.isFinite(r) && r > 0 ? r : 1;
    },
    setPlaying(p) {
      if (p === playing) return;
      if (playing) {
        media = extrapolated();
        wall = performance.now();
      } else {
        wall = performance.now();
      }
      playing = p;
    },
    sample(raw) {
      if (!Number.isFinite(raw)) return playing ? extrapolated() : media;
      if (!playing) return reanchor(raw);
      // 明显跳转（seek / 缓冲后回跳）：跟播放器
      if (raw > media + 0.4 || raw < media - 0.2) return reanchor(raw);
      // 播放器时钟前进：重锚到真实值
      if (raw > media + 0.001) return reanchor(raw);
      // 同一读数或微小抖动：墙钟外推（带上限）
      return extrapolated();
    },
    reset(raw = 0) {
      playing = false;
      reanchor(raw);
    },
  };
}
