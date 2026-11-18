/**
 * [INPUT]: api.asrModels / downloadAsrModel / deleteAsrModel；event model-download
 * [OUTPUT]: useAsrModels — 本机模型列表与下载进度
 * [POS]: 设置 › 字幕与 GenCard 共用；与 jobs 解耦
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api, errText } from "./api";

export interface AsrModel {
  id: string;
  name: string;
  engine: string;
  sizeMb: number;
  note: string;
  installed: boolean;
  /** 软链来源，如 SubCast */
  from?: string | null;
}

interface State {
  models: AsrModel[];
  loading: boolean;
  /** model id → 0–1 */
  downloading: Record<string, number>;
  error?: string;
  refresh: () => Promise<void>;
  rescan: () => Promise<void>;
  download: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  cancelDownload: (id: string) => Promise<void>;
}

let listening = false;

async function ensureListen() {
  if (listening) return;
  listening = true;
  await listen<{ id: string; received: number; total?: number | null }>("model-download", (e) => {
    const { id, received, total } = e.payload;
    const p = total && total > 0 ? Math.min(1, received / total) : 0;
    useAsrModels.setState((s) => ({
      downloading: { ...s.downloading, [id]: p },
    }));
  });
}

export const useAsrModels = create<State>((set, get) => ({
  models: [],
  loading: false,
  downloading: {},
  async refresh() {
    set({ loading: true, error: undefined });
    try {
      await ensureListen();
      const models = await api.asrModels();
      set({ models, loading: false });
    } catch (e) {
      set({ loading: false, error: errText(e) });
    }
  },
  async rescan() {
    set({ loading: true, error: undefined });
    try {
      await ensureListen();
      const models = await api.rescanAsrModels();
      set({ models, loading: false });
    } catch (e) {
      set({ loading: false, error: errText(e) });
    }
  },
  async download(id) {
    await ensureListen();
    set((s) => ({ downloading: { ...s.downloading, [id]: 0.01 }, error: undefined }));
    try {
      await api.downloadAsrModel(id, true);
      const { [id]: _, ...rest } = get().downloading;
      set({ downloading: rest });
      await get().refresh();
    } catch (e) {
      const { [id]: _, ...rest } = get().downloading;
      set({ downloading: rest, error: errText(e) });
      throw e;
    }
  },
  async remove(id) {
    await api.deleteAsrModel(id);
    await get().refresh();
  },
  async cancelDownload(id) {
    await api.cancelJob(`model:${id}`);
  },
}));
