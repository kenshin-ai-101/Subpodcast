/**
 * [INPUT]: localStorage `subpodcast-layout`
 * [OUTPUT]: useLayout（sideOpen / subsOpen / sidebar / panel / panelOpen）、SIDEBAR / PANEL、clamp 宽
 * [POS]: 左右栏几何与收起态（含订阅区折叠态）；读写时钳制宽度，避免右栏被存成 0 后「消失」
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { create } from "zustand";

export const SIDEBAR = { min: 180, max: 320, def: 220, snap: 130 };
export const PANEL = { min: 340, max: 760, def: 460, snap: 260 };

interface Layout {
  sidebar: number;
  sideOpen: boolean;
  subsOpen: boolean;
  panel: number;
  panelOpen: boolean;
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
    panel: clamp(raw.panel, PANEL.min, PANEL.max, PANEL.def),
    panelOpen: raw.panelOpen !== false,
  };
}

const read = (): Layout => {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Layout>;
    return sanitize({
      sidebar: SIDEBAR.def,
      sideOpen: true,
      subsOpen: true,
      panel: PANEL.def,
      panelOpen: true,
      ...parsed,
    });
  } catch {
    return { sidebar: SIDEBAR.def, sideOpen: true, subsOpen: true, panel: PANEL.def, panelOpen: true };
  }
};

let saveTimer = 0;

export const useLayout = create<Layout & { put: (p: Partial<Layout>) => void }>((set, get) => ({
  ...read(),
  put: (p) => {
    const cur = get();
    const next = sanitize({ ...cur, ...p });
    // sideOpen / subsOpen / panelOpen 允许显式 false，不受 sanitize 里「缺省 true」影响
    if ("sideOpen" in p) next.sideOpen = !!p.sideOpen;
    if ("subsOpen" in p) next.subsOpen = !!p.subsOpen;
    if ("panelOpen" in p) next.panelOpen = !!p.panelOpen;
    if ("sidebar" in p) next.sidebar = clamp(p.sidebar, SIDEBAR.min, SIDEBAR.max, cur.sidebar);
    if ("panel" in p) next.panel = clamp(p.panel, PANEL.min, PANEL.max, cur.panel);
    set(next);
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const { sidebar, sideOpen, subsOpen, panel, panelOpen } = get();
      try {
        localStorage.setItem(KEY, JSON.stringify({ sidebar, sideOpen, subsOpen, panel, panelOpen }));
      } catch {
        /* private mode */
      }
    }, 300);
  },
}));
