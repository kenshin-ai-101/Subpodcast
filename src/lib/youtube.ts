/**
 * [INPUT]: youtube.com/iframe_api
 * [OUTPUT]: loadYouTube() → window.YT
 * [POS]: YouTube IFrame Player API 一次性加载；播放器组件消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

declare global {
  interface Window {
    YT?: {
      Player: new (el: HTMLElement | string, opts: Record<string, unknown>) => YtPlayer;
      PlayerState: { ENDED: number; PLAYING: number; PAUSED: number; BUFFERING: number; CUED: number };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

export interface YtPlayer {
  destroy(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
  getPlayerState(): number;
  getCurrentTime(): number;
  getDuration(): number;
  setPlaybackRate(rate: number): void;
  setVolume(vol: number): void;
  mute(): void;
  unMute(): void;
  unloadModule?(name: string): void;
  setOption?(module: string, option: string, value: unknown): void;
}

let loading: Promise<NonNullable<Window["YT"]>> | null = null;

export function loadYouTube(): Promise<NonNullable<Window["YT"]>> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    const fail = () => {
      window.clearTimeout(timer);
      loading = null;
      script.remove();
      reject(new Error("无法加载 YouTube 播放器，请检查网络或代理"));
    };
    script.onerror = fail;
    const timer = window.setTimeout(() => {
      if (!window.YT?.Player) fail();
    }, 12000);
    window.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timer);
      previous?.();
      resolve(window.YT!);
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** 关掉 YouTube 自带字幕，避免和我们叠字。 */
export function hideYouTubeCaptions(player: YtPlayer) {
  try {
    player.setOption?.("captions", "track", {});
  } catch {
    /* module not ready */
  }
  try {
    player.unloadModule?.("captions");
    player.unloadModule?.("cc");
  } catch {
    /* not loaded */
  }
}
