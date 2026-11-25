/**
 * [INPUT]: settings.shortcuts 覆盖
 * [OUTPUT]: ACTIONS、keymap、comboOf、prettyCombo、录制校验
 * [POS]: 设置 › 通用 › 快捷键；与播放快捷键共用注册表
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { create } from "zustand";

export type ActionId =
  | "playPause"
  | "back"
  | "forward"
  | "backShort"
  | "forwardShort"
  | "prevLine"
  | "nextLine"
  | "fullscreen"
  | "subtitleMode"
  | "subBigger"
  | "subSmaller"
  | "speedUp"
  | "speedDown"
  | "mute"
  | "volumeUp"
  | "volumeDown"
  | "toggleSidebar"
  | "togglePanel"
  | "search"
  | "settings"
  | "keysHelp";

export interface ActionDef {
  id: ActionId;
  label: string;
  group: string;
  keys: string[];
  global?: boolean;
}

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export const ACTIONS: ActionDef[] = [
  { id: "playPause", label: "播放 / 暂停", group: "播放", keys: ["Space", "K"] },
  { id: "back", label: "后退 15 秒", group: "播放", keys: ["ArrowLeft", "J"] },
  { id: "forward", label: "前进 30 秒", group: "播放", keys: ["ArrowRight", "L"] },
  { id: "backShort", label: "后退 5 秒", group: "播放", keys: ["Shift+ArrowLeft"] },
  { id: "forwardShort", label: "前进 5 秒", group: "播放", keys: ["Shift+ArrowRight"] },
  { id: "prevLine", label: "上一句", group: "播放", keys: ["ArrowUp"] },
  { id: "nextLine", label: "下一句", group: "播放", keys: ["ArrowDown"] },
  { id: "speedUp", label: "加快播放", group: "播放", keys: ["Shift+."] },
  { id: "speedDown", label: "减慢播放", group: "播放", keys: ["Shift+,"] },
  { id: "mute", label: "静音", group: "播放", keys: ["M"] },
  { id: "volumeUp", label: "调高音量", group: "播放", keys: ["Mod+ArrowUp", "="] },
  { id: "volumeDown", label: "调低音量", group: "播放", keys: ["Mod+ArrowDown", "-"] },
  { id: "fullscreen", label: "全屏看视频", group: "视频与字幕", keys: ["F"] },
  { id: "subtitleMode", label: "切换字幕：双语 / 中文 / 原文", group: "视频与字幕", keys: ["C"] },
  { id: "subBigger", label: "字幕变大", group: "视频与字幕", keys: ["Mod+="] },
  { id: "subSmaller", label: "字幕变小", group: "视频与字幕", keys: ["Mod+-"] },
  { id: "toggleSidebar", label: "显示 / 收起侧栏", group: "窗口", keys: ["Mod+B"], global: true },
  { id: "togglePanel", label: "显示 / 收起字幕栏", group: "窗口", keys: ["Mod+\\"], global: true },
  { id: "search", label: "搜索节目", group: "窗口", keys: ["Mod+L"], global: true },
  { id: "settings", label: "打开设置", group: "窗口", keys: ["Mod+,"], global: true },
  { id: "keysHelp", label: "查看快捷键", group: "窗口", keys: ["Mod+/"], global: true },
];

export const useKeysHelp = create<{ open: boolean }>(() => ({ open: false }));

const RESERVED = new Set([
  "Mod+Q",
  "Mod+W",
  "Mod+H",
  "Mod+M",
  "Mod+C",
  "Mod+V",
  "Mod+X",
  "Mod+A",
  "Mod+Z",
  "Mod+Shift+Z",
  "Mod+Tab",
  "Alt+F4",
  "Mod+F",
  "Escape",
  "Tab",
  "Enter",
]);

const KEY_NAMES: Record<string, string> = { " ": "Space", Spacebar: "Space", Esc: "Escape" };

export function comboOf(e: KeyboardEvent): string | null {
  if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"].includes(e.key)) return null;
  let key = e.code.startsWith("Key")
    ? e.code.slice(3)
    : e.code.startsWith("Digit")
      ? e.code.slice(5)
      : (KEY_NAMES[e.key] ?? e.key);
  if (key.length === 1) key = key.toUpperCase();
  if (e.code === "Comma") key = ",";
  else if (e.code === "Period") key = ".";
  else if (e.code === "Backslash") key = "\\";
  else if (e.code === "Slash") key = "/";
  else if (e.code === "Equal") key = "=";
  else if (e.code === "Minus") key = "-";
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  const parts = [mod && "Mod", !IS_MAC && e.metaKey && "Meta", IS_MAC && e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", key].filter(
    Boolean,
  );
  return parts.join("+");
}

const SYMBOLS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Space: "Space",
  Escape: "Esc",
  Backspace: "⌫",
};

export function prettyCombo(c: string): string {
  const parts = c.split("+");
  if (IS_MAC) return parts.map((p) => ({ Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" }[p] ?? SYMBOLS[p] ?? p)).join("");
  return parts.map((p) => ({ Mod: "Ctrl", Alt: "Alt", Shift: "Shift" }[p] ?? SYMBOLS[p] ?? p)).join("+");
}

export function kbd(display: string): string {
  return display;
}

export function keymap(custom?: Partial<Record<ActionId, string[]>>): Record<ActionId, string[]> {
  return Object.fromEntries(ACTIONS.map((a) => [a.id, custom?.[a.id] ?? a.keys])) as Record<ActionId, string[]>;
}

export function checkCombo(
  combo: string,
  forAction: ActionId,
  custom?: Partial<Record<ActionId, string[]>>,
): { reserved: boolean; takenBy: ActionId | null } {
  if (RESERVED.has(combo)) return { reserved: true, takenBy: null };
  const map = keymap(custom);
  return { reserved: false, takenBy: ACTIONS.find((a) => a.id !== forAction && map[a.id].includes(combo))?.id ?? null };
}
