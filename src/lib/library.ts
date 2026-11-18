/**
 * [INPUT]: api.getBlob/setBlob、store.notify
 * [OUTPUT]: useLibrary、favorites 读写、toggleFavorite、loadFavorites
 * [POS]: 收藏持久化；连播仍在 queue.ts
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { create } from "zustand";
import { api, type Episode } from "./api";
import { useStore } from "../store";

interface Fav {
  id: string;
  at: number;
}

interface LibraryState {
  favorites: Fav[];
}

export const useLibrary = create<LibraryState>(() => ({ favorites: [] }));

const BLOB_EP = "_app";
const BLOB_KIND = "favorites";

export async function loadFavorites() {
  try {
    const raw = await api.getBlob(BLOB_EP, BLOB_KIND);
    if (raw) useLibrary.setState({ favorites: JSON.parse(raw) as Fav[] });
  } catch {
    /* 尚无收藏 */
  }
}

export const isFavorite = (id: string) => useLibrary.getState().favorites.some((f) => f.id === id);

export function toggleFavorite(ep: Episode) {
  const { favorites } = useLibrary.getState();
  const on = favorites.some((f) => f.id === ep.id);
  const next = on ? favorites.filter((f) => f.id !== ep.id) : [{ id: ep.id, at: Date.now() }, ...favorites];
  useLibrary.setState({ favorites: next });
  void api.setBlob(BLOB_EP, BLOB_KIND, JSON.stringify(next));
  useStore.getState().notify(on ? "已取消收藏" : "已收藏，在「接下来听」里能找到");
}