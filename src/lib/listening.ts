/**
 * [INPUT]: api.logListen、store.settings.subtitleMode
 * [OUTPUT]: noteListening、flushListening
 * [POS]: 播放时累计真实收听秒数（拖动不计；每 tick ≤2s）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { api, type Episode } from "./api";
import { useStore } from "../store";

let heard = { id: "", show: "", secs: 0, at: 0, translated: false };

export function flushListening() {
  if (heard.secs >= 1) {
    void api.logListen(heard.id, heard.show, heard.secs, heard.translated).catch(() => {});
  }
  heard.secs = 0;
}

export function noteListening(ep: Episode, playing: boolean) {
  const now = performance.now();
  if (heard.id !== ep.id) {
    flushListening();
    heard = { id: ep.id, show: ep.showId, secs: 0, at: now, translated: false };
  }
  if (playing && heard.at) heard.secs += Math.min(2, (now - heard.at) / 1000);
  heard.at = playing ? now : 0;
  heard.translated ||= useStore.getState().settings.subtitleMode !== "original";
  if (heard.secs >= 20 || (!playing && heard.secs > 0)) flushListening();
}