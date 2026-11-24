/**
 * [INPUT]: Episode、offline.audioSrc / isSaved
 * [OUTPUT]: preferAudio / initialAudioOnly / usesAudioEngine / usesYtEngine — 起播引擎选择
 * [POS]: AudioEngine 与 YtEngine 互斥认领 player；在线有 videoId 默认视频（与 YouTube 字幕同源对齐）；纯音频/断网已下载走音频
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { Episode } from "./api";
import { audioSrc, isSaved } from "./offline";

/** 本集是否有可播独立音轨（远端或离线），用于「仅音频」切换与视频失败回退。 */
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

/**
 * load 时的初始 audioOnly：
 * - 无 videoId → 纯音频（true）
 * - 有 videoId 且断网已下载 → 仅音频（true）
 * - 有 videoId 且在线 → 视频优先（false），避免默认播 RSS 音频却配 YouTube 字幕导致广告/剪辑错位
 */
export function initialAudioOnly(ep: Episode): boolean {
  if (!ep.videoId) return true;
  return offlineYtForcesAudio(ep);
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
