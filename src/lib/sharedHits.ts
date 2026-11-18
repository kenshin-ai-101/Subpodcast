/**
 * [INPUT]: api.sharedExists；Episode 的 hasTranscript / transcriptUrl / deep / videoId
 * [OUTPUT]: useSharedHits、checkShared、hasOwnSubs、hasSubs
 * [POS]: 列表「有字幕」角标的共享库命中缓存；与 jobs 瀑布解耦、会话内去重
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { create } from "zustand";
import { api, type Episode } from "./api";

export const useSharedHits = create<{ ids: Record<string, true> }>(() => ({ ids: {} }));

/** 本机已有或官方源可拉的字幕（不必查共享库）。 */
export function hasOwnSubs(e: Episode): boolean {
  return !!(e.hasTranscript || e.transcriptUrl || e.deep || e.videoId);
}

export function hasSubs(e: Episode, shared: Record<string, true>): boolean {
  return hasOwnSubs(e) || !!shared[e.id];
}

const asked = new Set<string>();

/** 批量问共享库；同会话同一集只问一次。 */
export function checkShared(eps: Episode[]) {
  const ids = eps
    .filter((e) => !hasOwnSubs(e) && !asked.has(e.id))
    .map((e) => e.id)
    .slice(0, 100);
  if (!ids.length) return;
  ids.forEach((id) => asked.add(id));
  void api
    .sharedExists(ids)
    .then((hit) => {
      if (!hit.length) return;
      useSharedHits.setState((s) => ({
        ids: { ...s.ids, ...Object.fromEntries(hit.map((id) => [id, true as const])) },
      }));
    })
    .catch(() => {});
}
