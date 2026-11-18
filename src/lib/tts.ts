/**
 * [INPUT]: api.ttsSpeak；store.settings.ttsVoice/ttsResource；store.player/playing/speaking
 * [OUTPUT]: chunks / speak / stopSpeaking
 * [POS]: 导读与精读朗读；按句切块预取下一段 WAV
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { api } from "./api";
import { useStore } from "../store";

let session = 0;
let audio: HTMLAudioElement | null = null;

/** 按句切块，单段不超过 max 字。 */
export function chunks(text: string, max = 900): string[] {
  const parts = text.replace(/\s+\n/g, "\n").split(/(?<=[。！？!?；;\n])/);
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    if ((cur + p).length > max && cur) {
      out.push(cur.trim());
      cur = "";
    }
    cur += p.length > max ? p.slice(0, max) : p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

export function stopSpeaking() {
  session++;
  audio?.pause();
  audio = null;
  useStore.getState().set({ speaking: false });
}

export async function speak(text: string, onError?: (m: string) => void) {
  stopSpeaking();
  const id = ++session;
  const { settings, player, playing } = useStore.getState();
  if (playing) player?.toggle();
  useStore.getState().set({ speaking: true });
  const parts = chunks(text);
  const fetchPart = (i: number) =>
    i < parts.length
      ? api.ttsSpeak(parts[i], settings.ttsVoice, settings.ttsResource)
      : Promise.resolve(null);
  let next = fetchPart(0);
  try {
    for (let i = 0; i < parts.length; i++) {
      const b64 = await next;
      if (id !== session || !b64) return;
      next = fetchPart(i + 1);
      const el = new Audio(`data:audio/wav;base64,${b64}`);
      audio = el;
      await new Promise<void>((resolve, reject) => {
        el.onended = () => resolve();
        el.onerror = () => reject(new Error("音频播放失败"));
        void el.play().catch(reject);
      });
      if (id !== session) return;
    }
  } catch (e) {
    if (id === session) onError?.(String((e as Error)?.message ?? e));
  } finally {
    if (id === session) useStore.getState().set({ speaking: false });
  }
}
