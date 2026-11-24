/**
 * [INPUT]: api.downloadEpisode / listDownloads / deleteDownload；event offline
 * [OUTPUT]: useOffline、loadDownloads、canonicalAudioUrl、audioSrc、remoteAudioSrc、isLocalAssetSrc、downloadEpisode、cancelDownload、removeDownload、clearDownloads、bytes
 * [POS]: 单集页下载按钮与 PlayerBar 音频源；设置 › 存储清理；小宇宙 dts-api 播前归一成 xyzcdn 直链；清单在 store.init 预拉；本地 asset 失败可回退远端
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api, errText, type Episode } from "./api";
import { tNow } from "./i18n";
import { useStore } from "../store";

export interface Saved {
  episodeId: string;
  path: string;
  bytes: number;
  savedAt: number;
}

interface OfflineState {
  saved: Record<string, Saved>;
  progress: Record<string, number | null>;
  ready: boolean;
}

export const useOffline = create<OfflineState>(() => ({
  saved: {},
  progress: {},
  ready: false,
}));

let listening = false;

async function ensureListen() {
  if (listening) return;
  listening = true;
  await listen<{ episodeId: string; progress: number | null }>("offline", ({ payload }) => {
    useOffline.setState((s) => ({
      progress: { ...s.progress, [payload.episodeId]: payload.progress },
    }));
  });
}

export async function loadDownloads() {
  await ensureListen();
  try {
    const list = await api.listDownloads();
    useOffline.setState({
      saved: Object.fromEntries(list.map((x) => [x.episodeId, x])),
      ready: true,
    });
  } catch {
    useOffline.setState({ ready: true });
  }
}

export const isSaved = (id: string) => !!useOffline.getState().saved[id];

/**
 * 与 Rust shared::canonical_audio_url 对齐：
 * dts-api.xiaoyuzhoufm.com/.../media.xyzcdn.net/... → https://media.xyzcdn.net/...
 * WebView 跟 302+Range 续播时偶发卡住；直链可秒开。
 */
export function canonicalAudioUrl(url: string): string {
  const bare = url.split(/[?#]/, 1)[0] ?? url;
  const i = bare.indexOf("media.xyzcdn.net/");
  if (i >= 0) return `https://${bare.slice(i)}`;
  return bare;
}

/** 播放优先用已下载文件，否则用归一后的远端 audioUrl。 */
export function audioSrc(ep: Episode): string | undefined {
  const saved = useOffline.getState().saved[ep.id];
  if (saved) return convertFileSrc(saved.path);
  return remoteAudioSrc(ep);
}

/** 仅远端音轨（本地 asset 失败时回退用）。 */
export function remoteAudioSrc(ep: Episode): string | undefined {
  if (!ep.audioUrl) return undefined;
  return canonicalAudioUrl(ep.audioUrl);
}

/** convertFileSrc 产出的 asset URL（含 asset.localhost）。 */
export function isLocalAssetSrc(src: string): boolean {
  return /^(asset:|https?:\/\/asset\.localhost)/i.test(src) || src.includes("asset.localhost");
}

export async function downloadEpisode(ep: Episode) {
  if (!ep.audioUrl && !ep.videoId) {
    useStore.getState().notify(tNow("这集没有可下载的音频"));
    return;
  }
  await ensureListen();
  useOffline.setState((s) => ({ progress: { ...s.progress, [ep.id]: null } }));
  try {
    const saved = await api.downloadEpisode(ep.id);
    useOffline.setState((s) => {
      const { [ep.id]: _, ...rest } = s.progress;
      return { saved: { ...s.saved, [ep.id]: saved }, progress: rest };
    });
    useStore.getState().notify(tNow("已下载，可离线收听"));
  } catch (e) {
    useOffline.setState((s) => {
      const { [ep.id]: _, ...rest } = s.progress;
      return { progress: rest };
    });
    useStore.getState().notify(errText(e));
  }
}

export function cancelDownload(episodeId: string) {
  void api.cancelJob(`dl:${episodeId}`);
  useOffline.setState((s) => {
    const { [episodeId]: _, ...rest } = s.progress;
    return { progress: rest };
  });
}

export async function removeDownload(episodeId: string) {
  await api.deleteDownload(episodeId);
  useOffline.setState((s) => {
    const { [episodeId]: _, ...rest } = s.saved;
    return { saved: rest };
  });
  useStore.getState().notify(tNow("已删除下载"));
}

/** 清空全部离线音频；字幕与收听进度保留。 */
export async function clearDownloads() {
  await api.clearDownloads();
  useOffline.setState({ saved: {}, progress: {} });
  useStore.getState().notify(tNow("已删除全部下载"));
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) {
    const mb = n / (1024 * 1024);
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
