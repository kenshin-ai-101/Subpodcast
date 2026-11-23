/**
 * [INPUT]: local_tts_* 命令、local-tts-download 事件、cancel_job
 * [OUTPUT]: 模型状态、安装、取消与删除
 * [POS]: 朗读设置；关闭对话框后仍能跟踪后台下载
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { useStore } from "../store";
import { api, errText, type LocalModelId, type LocalTtsStatus } from "./api";

interface Progress { id: LocalModelId; received: number; total: number | null }

let pending: { id: LocalModelId; started: boolean; cancelled: boolean } | undefined;

export const useLocalTts = create<{ status: LocalTtsStatus | null; downloading: Progress | null }>(() => ({
  status: null, downloading: null,
}));

export async function refreshLocalTts() {
  useLocalTts.setState({ status: await api.localTtsStatus() });
}

export function localInstalled(status: LocalTtsStatus | null, id: string): boolean {
  return status?.models.some((model) => model.id === id && model.installed) ?? false;
}

export async function installLocalTts(id: LocalModelId): Promise<boolean> {
  if (useLocalTts.getState().downloading) return false;
  const job = { id, started: false, cancelled: false };
  pending = job;
  useLocalTts.setState({ downloading: { id, received: 0, total: null } });
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await listen<Progress>("local-tts-download", ({ payload }) => {
      if (payload.id === id) useLocalTts.setState({ downloading: payload });
    });
    if (job.cancelled) return false;
    job.started = true;
    await api.localTtsInstall(id, true);
    await refreshLocalTts();
    return true;
  } catch (error) {
    const message = errText(error);
    if (message !== "已取消") useStore.getState().notify(message);
    return false;
  } finally {
    unlisten?.();
    pending = undefined;
    useLocalTts.setState({ downloading: null });
  }
}

export async function cancelLocalTts(id: LocalModelId) {
  if (pending?.id === id && !pending.started) {
    pending.cancelled = true;
    return;
  }
  await api.cancelJob(`local-tts:${id}`);
}

export async function deleteLocalTts(id: LocalModelId) {
  await api.localTtsDelete(id);
  await refreshLocalTts();
}
