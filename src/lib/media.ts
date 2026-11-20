/**
 * [INPUT]: Episode、offline.audioSrc / isSaved
 * [OUTPUT]: preferAudio / initialAudioOnly / usesAudioEngine / usesYtEngine — 起播引擎选择
 * [POS]: AudioEngine 与 YtEngine 互斥认领 player；有音轨默认音频秒开；断网已下载的 YouTube 强制仅音频
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { Episode } from "./api";
import { audioSrc, isSaved } from "./offline";

/** 有可播音轨（远端或离线）时优先音频，避开 iframe 冷启动。 */
export function preferAudio(ep: Episode): boolean {
  return !!audioSrc(ep);
}

/**
 * 断网且本集已下载：YouTube 强制仅音频，避免去碰打不开的 iframe。
 * load / 单集页默认形态共用，与 Subcast「offline → startAudio」对齐。
 */
export function offlineYtForcesAudio(ep: Episode): boolean {
  return !!ep.videoId && typeof navigator !== "undefined" && !navigator.onLine && isSaved(ep.id);
}

/** load 时的初始 audioOnly：断网已下载 YouTube 优先，否则有音轨则音频。 */
export function initialAudioOnly(ep: Episode): boolean {
  return offlineYtForcesAudio(ep) || preferAudio(ep);
}

/** App 根 `<audio>` 认领播放权。 */
export function usesAudioEngine(ep: Episode | null, audioOnly: boolean): boolean {
  if (!ep) return false;
  if (!audioSrc(ep)) return false;
  return audioOnly || !ep.videoId;
}

/** App 根 YouTube 引擎认领播放权（含无独立音轨时的「仅音频」）。 */
export function usesYtEngine(ep: Episode | null, audioOnly: boolean): boolean {
  if (!ep?.videoId) return false;
  if (!audioSrc(ep)) return true;
  return !audioOnly;
}
