/**
 * [INPUT]: localStorage `subpodcast-layout`
 * [OUTPUT]: useLayout（sideOpen / subsOpen / subsAll / sidebar / panel / panelOpen / transcriptBelow）、SIDEBAR / PANEL、clamp 宽
 * [POS]: 左右栏几何与收起态（订阅区折叠、长列表展开、字幕列表在右栏或播放器下方）；读写时钳制宽度，避免右栏被存成 0 后「消失」
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { create } from "zustand";

export const SIDEBAR = { min: 180, max: 320, def: 220, snap: 130 };
export const PANEL = { min: 340, max: 760, def: 460, snap: 260 };

interface Layout {
  sidebar: number;
  sideOpen: boolean;
  subsOpen: boolean;
  /** 订阅超过 12 档时是否展开完整列表（否则只显示前 8 + 当前打开） */
  subsAll: boolean;
  panel: number;
  panelOpen: boolean;
  /** true：字幕列表在播放器下方；精读/导读/问答仍在右栏 */
  transcriptBelow: boolean;
}

const KEY = "subpodcast-layout";

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.round(Math.min(max, Math.max(min, v)));
}

function sanitize(raw: Partial<Layout>): Layout {
  return {
    sidebar: clamp(raw.sidebar, SIDEBAR.min, SIDEBAR.max, SIDEBAR.def),
    sideOpen: raw.sideOpen !== false,
    subsOpen: raw.subsOpen !== false,
    subsAll: raw.subsAll === true,
    panel: clamp(raw.panel, PANEL.min, PANEL.max, PANEL.def),
    panelOpen: raw.panelOpen !== false,
    transcriptBelow: raw.transcriptBelow === true,
  };
}

const read = (): Layout => {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Layout>;
    return sanitize({
      sidebar: SIDEBAR.def,
      sideOpen: true,
      subsOpen: true,
      subsAll: false,
      panel: PANEL.def,
      panelOpen: true,
      transcriptBelow: false,
      ...parsed,
    });
  } catch {
    return {
      sidebar: SIDEBAR.def,
      sideOpen: true,
      subsOpen: true,
      subsAll: false,
      panel: PANEL.def,
      panelOpen: true,
      transcriptBelow: false,
    };
  }
};

let saveTimer = 0;

export const useLayout = create<Layout & { put: (p: Partial<Layout>) => void }>((set, get) => ({
  ...read(),
  put: (p) => {
    const cur = get();
    const next = sanitize({ ...cur, ...p });
    // 布尔项允许显式 false，不受 sanitize 里「缺省 true」影响
    if ("sideOpen" in p) next.sideOpen = !!p.sideOpen;
    if ("subsOpen" in p) next.subsOpen = !!p.subsOpen;
    if ("subsAll" in p) next.subsAll = !!p.subsAll;
    if ("panelOpen" in p) next.panelOpen = !!p.panelOpen;
    if ("transcriptBelow" in p) next.transcriptBelow = !!p.transcriptBelow;
    if ("sidebar" in p) next.sidebar = clamp(p.sidebar, SIDEBAR.min, SIDEBAR.max, cur.sidebar);
    if ("panel" in p) next.panel = clamp(p.panel, PANEL.min, PANEL.max, cur.panel);
    set(next);
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const { sidebar, sideOpen, subsOpen, subsAll, panel, panelOpen, transcriptBelow } = get();
      try {
        localStorage.setItem(
          KEY,
          JSON.stringify({ sidebar, sideOpen, subsOpen, subsAll, panel, panelOpen, transcriptBelow }),
        );
      } catch {
        /* private mode */
      }
    }, 300);
  },
}));
