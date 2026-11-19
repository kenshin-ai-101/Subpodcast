/**
 * [INPUT]: api、settings
 * [OUTPUT]: 全局导航（含 words）、播放态（含 speaking/seekSoon）、settingsOpen/settingsSection
 * [POS]: UI 状态总线；与 SubCast 壳层行为对齐
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { create } from "zustand";
import { api, type Episode, type Show } from "./lib/api";
import { DEFAULTS, loadSettings, saveSettings, type Settings, type SettingsSection } from "./lib/settings";

export type View =
  | { kind: "home" }
  | { kind: "discover" }
  | { kind: "stats" }
  | { kind: "recent" }
  | { kind: "words" }
  | { kind: "channel"; input: string }
  | { kind: "show"; id: string }
  | { kind: "episode"; id: string };

export interface PlayerHandle {
  seek(seconds: number): void;
  toggle(): void;
  play(): void;
  setRate(rate: number): void;
}

interface State {
  ready: boolean;
  settings: Settings;
  shows: Show[];
  view: View;
  history: View[];
  current: Episode | null;
  time: number;
  length: number;
  playing: boolean;
  rate: number;
  /** 缓冲开始时间戳；null 表示未缓冲 */
  loadingSince: number | null;
  /** 媒体就绪后是否自动播放（换集时 true） */
  playWhenReady: boolean;
  /** 导读/精读朗读中 */
  speaking: boolean;
  player: PlayerHandle | null;
  toast: string | null;
  settingsOpen: boolean;
  /** 打开设置时落到哪一栏；关对话框后清掉。 */
  settingsSection: SettingsSection | null;
  addOpen: boolean;
  addTab: "search" | "link" | "import";
  init(): Promise<void>;
  go(view: View): void;
  back(): void;
  reloadShows(): Promise<void>;
  saveSettings(patch: Partial<Settings>): Promise<void>;
  openEpisode(ep: Episode): void;
  load(ep: Episode): void;
  notify(text: string): void;
  set(patch: Partial<State>): void;
}

let toastTimer: number | undefined;

export const useStore = create<State>((set, get) => ({
  ready: false,
  settings: DEFAULTS,
  shows: [],
  view: { kind: "home" },
  history: [],
  current: null,
  time: 0,
  length: 0,
  playing: false,
  rate: 1,
  loadingSince: null,
  playWhenReady: true,
  speaking: false,
  player: null,
  toast: null,
  settingsOpen: false,
  settingsSection: null,
  addOpen: false,
  addTab: "search",
  async init() {
    const [settings, shows] = await Promise.all([loadSettings(), api.listShows()]);
    set({ settings, shows, ready: true, rate: settings.playbackRate ?? 1 });
  },
  go(view) {
    const cur = get().view;
    const same =
      cur.kind === view.kind &&
      (view.kind !== "show" || (cur.kind === "show" && cur.id === view.id)) &&
      (view.kind !== "episode" || (cur.kind === "episode" && cur.id === view.id)) &&
      (view.kind !== "channel" || (cur.kind === "channel" && cur.input === view.input));
    if (same) return;
    set({ view, history: [...get().history, cur].slice(-40) });
  },
  back() {
    const history = [...get().history];
    const prev = history.pop();
    if (!prev) return;
    set({ view: prev, history });
  },
  async reloadShows() {
    set({ shows: await api.listShows() });
  },
  async saveSettings(patch) {
    const settings = { ...get().settings, ...patch };
    const next: Partial<State> = { settings };
    if (patch.playbackRate != null) next.rate = patch.playbackRate;
    set(next);
    await saveSettings(settings);
  },
  openEpisode(ep) {
    get().load(ep);
    get().go({ kind: "episode", id: ep.id });
  },
  load(ep) {
    const same = get().current?.id === ep.id;
    set({
      current: ep,
      time: ep.progress || 0,
      length: ep.duration || 0,
      playing: false,
      loadingSince: null,
      playWhenReady: true,
      // 换集清掉旧 handle，避免 playSoon 误点上一家播放器
      player: same ? get().player : null,
    });
  },
  notify(text) {
    set({ toast: text });
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => set({ toast: null }), 2800);
  },
  set(patch) {
    set(patch);
  },
}));

/** 播放器尚未挂上时先写入 time；挂上后由 PlayerBar 按 time 起播。 */
export function seekSoon(seconds: number) {
  const s = useStore.getState();
  if (s.player) {
    s.player.seek(seconds);
    return;
  }
  if (s.current) s.set({ time: seconds });
}
