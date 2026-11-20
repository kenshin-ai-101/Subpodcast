/**
 * [INPUT]: api、settings、media.initialAudioOnly、audioHost / ytKick、offline.loadDownloads
 * [OUTPUT]: 全局导航；播放态（playWhenReady 按集、seekWhenReady、audioOnly、theater）；offerPlayer
 * [POS]: view 与 current 正交；openEpisode 只导航；load 只装载+预缓冲；init 先拉离线清单再 ready
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { create } from "zustand";
import { api, type Episode, type Show } from "./lib/api";
import { prepareAudio, pauseAudioHost, releaseAudioHost } from "./lib/audioHost";
import { initialAudioOnly, usesAudioEngine, usesYtEngine } from "./lib/media";
import { loadDownloads } from "./lib/offline";
import { DEFAULTS, loadSettings, saveSettings, type Settings, type SettingsSection } from "./lib/settings";
import { kickYoutube } from "./lib/ytKick";

/** load 当下预缓冲；play 留给 playSoon。 */
function prepareEngines(ep: Episode, audioOnly: boolean) {
  if (usesAudioEngine(ep, audioOnly)) {
    prepareAudio(ep);
    return;
  }
  pauseAudioHost();
  releaseAudioHost();
  if (usesYtEngine(ep, audioOnly)) {
    kickYoutube(ep, { play: false });
  }
}

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
  /** 该 handle 服务的单集；用于防误触 */
  episodeId?: string;
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
  /** 就绪后自动播放的单集 id；null=无意图 */
  playWhenReady: string | null;
  /** 播放器出现后 seek 到此 */
  seekWhenReady: { id: string; at: number } | null;
  /** true=仅音频引擎；false=视频（YouTube）。有音轨时默认 true。 */
  audioOnly: boolean;
  /** 视频 theater 全屏（布局级，非 element Fullscreen API） */
  theater: boolean;
  /** 导读/精读朗读中 */
  speaking: boolean;
  player: PlayerHandle | null;
  toast: string | null;
  settingsOpen: boolean;
  settingsSection: SettingsSection | null;
  addOpen: boolean;
  addTab: "search" | "link" | "import";
  init(): Promise<void>;
  go(view: View): void;
  back(): void;
  reloadShows(): Promise<void>;
  saveSettings(patch: Partial<Settings>): Promise<void>;
  /** 只导航到单集页，不装载、不起播 */
  openEpisode(ep: Episode): void;
  /** 装入播放器并预缓冲；不起播（起播用 playSoon） */
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
  playWhenReady: null,
  seekWhenReady: null,
  audioOnly: true,
  theater: false,
  speaking: false,
  player: null,
  toast: null,
  settingsOpen: false,
  settingsSection: null,
  addOpen: false,
  addTab: "search",
  async init() {
    // 离线清单与 shows 并行：ready 前 isSaved 已可信，断网 YouTube 才能正确仅音频
    const downloadsP = loadDownloads();
    const [settings, shows] = await Promise.all([loadSettings(), api.listShows()]);
    await downloadsP;
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
    get().go({ kind: "episode", id: ep.id });
  },
  load(ep) {
    const prev = get().current;
    // 同集后台补全只合并元数据，不打断播放
    if (prev?.id === ep.id) {
      set({
        current: {
          ...prev,
          ...ep,
          videoId: ep.videoId ?? prev.videoId,
          audioUrl: ep.audioUrl ?? prev.audioUrl,
          cover: ep.cover ?? prev.cover,
        },
        length: ep.duration || get().length,
      });
      return;
    }
    const audioOnly = initialAudioOnly(ep);
    const keep =
      get().player?.episodeId === ep.id ? get().player : null;
    set({
      current: ep,
      time: ep.progress || 0,
      length: ep.duration || 0,
      playing: false,
      loadingSince: null,
      playWhenReady: null,
      seekWhenReady: null,
      audioOnly,
      player: keep,
    });
    prepareEngines(ep, audioOnly);
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

/** 播放器尚未挂上时先排队；挂上后按集 seek。 */
export function seekSoon(seconds: number) {
  const s = useStore.getState();
  if (s.player && s.current && s.player.episodeId === s.current.id) {
    s.player.seek(seconds);
    return;
  }
  if (s.current) s.set({ time: seconds, seekWhenReady: { id: s.current.id, at: seconds } });
}

export function offerPlayer(handle: PlayerHandle) {
  useStore.getState().set({ player: handle });
}

export function withdrawPlayer(handle: PlayerHandle) {
  const s = useStore.getState();
  if (s.player === handle) s.set({ player: null });
}
