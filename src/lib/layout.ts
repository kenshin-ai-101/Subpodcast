/**
 * [INPUT]: localStorage `subpodcast-layout`
 * [OUTPUT]: useLayout（sideOpen / sidebar / panel / panelOpen）、SIDEBAR / PANEL 常量
 * [POS]: 左右栏几何与收起态；侧栏 rail / 右栏折叠共用，非设置页数据
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { create } from "zustand";

export const SIDEBAR = { min: 180, max: 320, def: 220, snap: 130 };
export const PANEL = { min: 340, max: 760, def: 460, snap: 260 };

interface Layout {
  sidebar: number;
  sideOpen: boolean;
  panel: number;
  panelOpen: boolean;
}

const KEY = "subpodcast-layout";

const read = (): Layout => {
  try {
    return {
      sidebar: SIDEBAR.def,
      sideOpen: true,
      panel: PANEL.def,
      panelOpen: true,
      ...JSON.parse(localStorage.getItem(KEY) ?? "{}"),
    };
  } catch {
    return { sidebar: SIDEBAR.def, sideOpen: true, panel: PANEL.def, panelOpen: true };
  }
};

let saveTimer = 0;

export const useLayout = create<Layout & { put: (p: Partial<Layout>) => void }>((set, get) => ({
  ...read(),
  put: (p) => {
    set(p);
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const { sidebar, sideOpen, panel, panelOpen } = get();
      try {
        localStorage.setItem(KEY, JSON.stringify({ sidebar, sideOpen, panel, panelOpen }));
      } catch {
        /* private mode */
      }
    }, 300);
  },
}));
