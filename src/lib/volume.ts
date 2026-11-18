/**
 * [INPUT]: localStorage 持久化；可选 YtPlayer
 * [OUTPUT]: useVolume、gainOf、setLevel、toggleMute、followVolume、applyYtPlayerVolume、applyYtVolume
 * [POS]: 全播放器共用音量；滑杆为感知刻度（立方），对齐 SubCast
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { YtPlayer } from "./youtube";
import { create } from "zustand";

const KEY = "subpodcast-volume";

interface Volume {
  level: number;
  muted: boolean;
}

function load(): Volume {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Volume | null;
    if (v && typeof v.level === "number") {
      return { level: Math.min(1, Math.max(0, v.level)), muted: !!v.muted };
    }
  } catch {
    /* ignore */
  }
  return { level: 1, muted: false };
}

export const useVolume = create<Volume>(() => load());
useVolume.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ level: s.level, muted: s.muted }));
  } catch {
    /* ignore */
  }
});

/** 播放器实际增益 0–1（感知立方）。 */
export const gainOf = (s: Volume = useVolume.getState()) => (s.muted ? 0 : s.level ** 3);

export function setLevel(level: number) {
  const l = Math.round(Math.min(1, Math.max(0, level)) * 100) / 100;
  useVolume.setState({ level: l, muted: l === 0 });
}

export function stepVolume(dir: 1 | -1): number {
  const s = useVolume.getState();
  setLevel((s.muted ? 0 : s.level) + dir * 0.1);
  return useVolume.getState().level;
}

/** 返回当前是否静音。从零取消静音时回到 0.5。 */
export function toggleMute(): boolean {
  const s = useVolume.getState();
  if (s.muted || s.level === 0) {
    useVolume.setState({ muted: false, level: s.level || 0.5 });
    return false;
  }
  useVolume.setState({ muted: true });
  return true;
}

/** 绑定 <audio>/<video> 到全局音量。 */
export function followVolume(el: HTMLMediaElement) {
  const apply = () => {
    el.volume = gainOf();
    el.muted = useVolume.getState().muted;
  };
  apply();
  return useVolume.subscribe(apply);
}

/** YouTube IFrame Player API：音量 0–100。 */
export function applyYtPlayerVolume(player: YtPlayer | null | undefined) {
  if (!player) return;
  const s = useVolume.getState();
  if (s.muted || s.level === 0) {
    player.mute();
    player.setVolume(0);
  } else {
    player.unMute();
    player.setVolume(Math.round(gainOf(s) * 100));
  }
}

/** 遗留：裸 iframe postMessage（无 Player 实例时兜底）。 */
export function applyYtVolume(frame: HTMLIFrameElement | null) {
  if (!frame?.contentWindow) return;
  const s = useVolume.getState();
  const win = frame.contentWindow;
  const post = (func: string, args: unknown[] = []) => {
    win.postMessage(JSON.stringify({ event: "command", func, args }), "*");
  };
  if (s.muted || s.level === 0) {
    post("mute");
    post("setVolume", [0]);
  } else {
    post("unMute");
    post("setVolume", [Math.round(gainOf(s) * 100)]);
  }
}
