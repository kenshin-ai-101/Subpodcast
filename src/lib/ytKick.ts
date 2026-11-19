/**
 * [INPUT]: Episode、youtube.loadYouTube、store
 * [OUTPUT]: kickYoutube / useYtKick — load 时预热/换片信号（默认不自动播）
 * [POS]: YtEngine 订阅后建/换片；起播由 playSoon 消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { create } from "zustand";
import type { Episode } from "./api";
import { loadYouTube } from "./youtube";

export interface YtKick {
  gen: number;
  episodeId: string;
  videoId: string;
  startAt: number;
  play: boolean;
}

export const useYtKick = create<{ kick: YtKick | null }>(() => ({ kick: null }));

/** 同步预热 API 并投递换片；play=false 时只准备，等 playSoon。 */
export function kickYoutube(ep: Episode, opts?: { time?: number; play?: boolean }): boolean {
  if (!ep.videoId) return false;
  const play = opts?.play ?? false;
  const startAt = Math.floor(opts?.time ?? ep.progress ?? 0);
  void loadYouTube().catch(() => {});
  useYtKick.setState({
    kick: {
      gen: (useYtKick.getState().kick?.gen ?? 0) + 1,
      episodeId: ep.id,
      videoId: ep.videoId,
      startAt: startAt > 0 ? startAt : 0,
      play,
    },
  });
  return true;
}
