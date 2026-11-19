/**
 * [INPUT]: Episode、store.load / openEpisode；playback.playSoon；api.listEpisodes
 * [OUTPUT]: playAll / playNext / clearQueue — 会话级连播与「播完自动下一集」
 * [POS]: start = load + openEpisode + playSoon；浏览与起播拆开
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { create } from "zustand";
import { api, type Episode } from "./api";
import { useStore } from "../store";
import { playSoon } from "./playback";

interface QueueState {
  queue: Episode[];
}

export const useQueue = create<QueueState>(() => ({ queue: [] }));

/** 装载 → 打开单集页 → 挂起播意图。 */
function start(ep: Episode) {
  const s = useStore.getState();
  s.load(ep);
  s.openEpisode(ep);
  playSoon(ep.id);
}

/** 从列表头部开播，余下入队；过滤条件由调用方决定。 */
export function playAll(eps: Episode[]) {
  if (!eps.length) return;
  useQueue.setState({ queue: eps.slice(1) });
  start(eps[0]!);
}

/** 当前集结束：先推进会话队列；否则若开启 autoNext，接着播同节目下一集。 */
export async function playNext() {
  const { queue } = useQueue.getState();
  if (queue.length) {
    const [next, ...rest] = queue;
    useQueue.setState({ queue: rest });
    if (!next) return;
    useStore.getState().notify(`接着播放：${next.title.slice(0, 40)}`);
    start(next);
    return;
  }
  const { settings, current } = useStore.getState();
  if (!settings.autoNext || !current?.showId) return;
  try {
    const eps = await api.listEpisodes(current.showId, 300);
    const playable = eps.filter((e) => e.audioUrl || e.videoId);
    const i = playable.findIndex((e) => e.id === current.id);
    const next = i >= 0 ? playable[i + 1] : undefined;
    if (!next) return;
    useStore.getState().notify(`接着播放：${next.title.slice(0, 40)}`);
    start(next);
  } catch {
    /* 安静失败 */
  }
}

export function clearQueue() {
  useQueue.setState({ queue: [] });
}
