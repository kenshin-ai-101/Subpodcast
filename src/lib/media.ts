/**
 * [INPUT]: Episode、offline.audioSrc
 * [OUTPUT]: preferAudio / usesAudioEngine / usesYtEngine — 起播引擎选择
 * [POS]: AudioEngine 与 YtEngine 互斥认领 player；有音轨默认音频秒开
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { Episode } from "./api";
import { audioSrc } from "./offline";

/** 有可播音轨（远端或离线）时优先音频，避开 iframe 冷启动。 */
export function preferAudio(ep: Episode): boolean {
  return !!audioSrc(ep);
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
