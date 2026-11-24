/**
 * [INPUT]: api.alignAudio / saveTimeMap / getBlob；store.current / align / settings.asrModel
 * [OUTPUT]: toPlay / toContent / gaps / anchorAt / loadAlign / alignCurrent / setManualMap / nudgeFromHere / anchorHere / registerAudioAlignBridge
 * [POS]: 字幕时钟 ↔ 播放文件时钟；自动声纹/语音探针对齐 + 手动锚点对齐；变更后通过桥接同步音频源与 store.time
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { api, errText } from "./api";
import { tNow } from "./i18n";
import { usesYtEngine } from "./media";
import { useStore } from "../store";

export interface Piece {
  refStart: number;
  refEnd: number;
  playStart: number;
}

export interface TimeMap {
  playBytes: number;
  method: "same" | "fingerprint" | "probe" | "manual";
  pieces: Piece[];
}

export type AlignStatus = "same" | "aligned" | "unknown" | "failed";

export interface Aligned {
  status: AlignStatus;
  map: TimeMap | null;
  path: string | null;
  localBytes: number;
}

interface AudioAlignBridge {
  getRawTime(epId: string): number | null;
  onMapUpdated(epId: string, path: string | null, localBytes: number): void;
}

let audioBridge: AudioAlignBridge | null = null;

/** 由 audioHost 注册，避免 timemap ↔ audioHost 循环依赖。 */
export function registerAudioAlignBridge(bridge: AudioAlignBridge) {
  audioBridge = bridge;
}

/** 播放文件独有、短于此的空隙当作匹配松弛，不当广告。 */
const MIN_GAP = 3;

const playEnd = (p: Piece) => p.playStart + (p.refEnd - p.refStart);

/** 字幕时间 → 播放文件时钟。 */
export function toPlay(m: TimeMap | null | undefined, at: number): number {
  const ps = m?.pieces;
  if (!ps?.length) return at;
  if (at < ps[0]!.refStart) return Math.max(0, at + ps[0]!.playStart - ps[0]!.refStart);
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]!;
    if (at < p.refEnd) return p.playStart + Math.max(0, at - p.refStart);
    // 仅字幕文件有的旧广告：跳到下一段共有语音起点
    if (i + 1 < ps.length && at < ps[i + 1]!.refStart) return ps[i + 1]!.playStart;
  }
  const last = ps[ps.length - 1]!;
  return Math.max(0, at + last.playStart - last.refStart);
}

/** 播放时钟 → 字幕时间；落在广告空隙时字幕停在前一句，gapEnd 为正文恢复点。 */
export function toContent(
  m: TimeMap | null | undefined,
  at: number,
): { at: number; gapEnd?: number } {
  const ps = m?.pieces;
  if (!ps?.length) return { at };
  const first = ps[0]!;
  if (at < first.playStart) {
    const c = at - (first.playStart - first.refStart);
    return c >= 0
      ? { at: c }
      : first.playStart - at >= MIN_GAP
        ? { at: 0, gapEnd: first.playStart - first.refStart }
        : { at: 0 };
  }
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]!;
    if (at < playEnd(p)) return { at: p.refStart + (at - p.playStart) };
    const next = ps[i + 1];
    if (next && at < next.playStart) {
      return next.playStart - playEnd(p) >= MIN_GAP
        ? { at: p.refEnd, gapEnd: next.playStart }
        : { at: p.refEnd };
    }
  }
  const last = ps[ps.length - 1]!;
  return { at: Math.max(0, at - (last.playStart - last.refStart)) };
}

/** 播放文件独有空隙（多半是广告），用播放时钟。 */
export function gaps(m: TimeMap | null | undefined): { start: number; end: number }[] {
  const ps = m?.pieces ?? [];
  const out: { start: number; end: number }[] = [];
  if (ps.length && ps[0]!.playStart - ps[0]!.refStart >= MIN_GAP) {
    out.push({ start: 0, end: ps[0]!.playStart - ps[0]!.refStart });
  }
  for (let i = 0; i + 1 < ps.length; i++) {
    const end = playEnd(ps[i]!);
    if (ps[i + 1]!.playStart - end >= MIN_GAP) {
      out.push({ start: end, end: ps[i + 1]!.playStart });
    }
  }
  return out;
}

/** 「听到的就是这句」：从字幕时间 ref 起跟随播放时钟 play；后续片段相对位移，广告空隙相对正文保持。 */
export function anchorAt(
  m: TimeMap | null | undefined,
  ref: number,
  play: number,
  playBytes: number,
): TimeMap {
  const ps: Piece[] = m?.pieces.length
    ? m.pieces.map((p) => ({ ...p }))
    : [{ refStart: 0, refEnd: 1e7, playStart: 0 }];
  const delta = play - toPlay({ playBytes, method: "manual", pieces: ps }, ref);
  const out: Piece[] = [];
  for (const p of ps) {
    if (p.refEnd <= ref) {
      out.push(p);
      continue;
    }
    if (p.refStart < ref) {
      out.push({ ...p, refEnd: ref });
      out.push({
        refStart: ref,
        refEnd: p.refEnd,
        playStart: Math.max(0, p.playStart + (ref - p.refStart) + delta),
      });
    } else {
      out.push({ ...p, playStart: Math.max(0, p.playStart + delta) });
    }
  }
  // 后移可能让前一段在播放时钟上重叠：截短
  for (let i = 0; i + 1 < out.length; i++) {
    const over = playEnd(out[i]!) - out[i + 1]!.playStart;
    if (over > 0) out[i]!.refEnd = Math.max(out[i]!.refStart, out[i]!.refEnd - over);
  }
  return {
    playBytes,
    method: "manual",
    pieces: out.filter((p) => p.refEnd > p.refStart),
  };
}

/** 当前集的 TimeMap。YouTube 引擎播片时恒等（片源与字幕同源）；仅 HTMLAudio 走映射。 */
export function currentMap(id: string): TimeMap | null {
  const s = useStore.getState();
  const a = s.align;
  if (!a || a.id !== id || !a.map) return null;
  if (s.current?.id === id && usesYtEngine(s.current, s.audioOnly)) return null;
  return a.map;
}

/** 装入本集已存的 tmap；无则 unknown。音频引擎会同步校准 pendingSeek / time。 */
export async function loadAlign(episodeId: string, hasAudio: boolean) {
  if (!hasAudio) {
    const s = useStore.getState();
    if (s.align?.id === episodeId) s.set({ align: null, rawTime: undefined, gapEnd: null });
    return;
  }
  const s = useStore.getState();
  if (s.align?.id === episodeId && s.align.status === "working") return;
  try {
    const raw = await api.getBlob(episodeId, "tmap");
    if (useStore.getState().current?.id !== episodeId) return;
    if (!raw) {
      useStore.getState().set({
        align: { id: episodeId, status: "unknown", map: null, path: null, localBytes: 0 },
      });
      return;
    }
    const map = JSON.parse(raw) as TimeMap;
    const empty = !map.pieces?.length;
    useStore.getState().set({
      align: {
        id: episodeId,
        status: empty && map.method === "same" ? "same" : empty ? "unknown" : "aligned",
        map: empty ? null : map,
        path: null,
        localBytes: map.playBytes ?? 0,
      },
    });
    audioBridge?.onMapUpdated(episodeId, null, map.playBytes ?? 0);
  } catch {
    if (useStore.getState().current?.id === episodeId) {
      useStore.getState().set({
        align: { id: episodeId, status: "unknown", map: null, path: null, localBytes: 0 },
      });
    }
  }
}

/**
 * 自动对齐当前正在走 HTMLAudio 的单集。
 * - `force = false`：命中缓存/同字节瞬时返回；有参考声纹但音频不同时自动下载并做声纹对齐；无参考声纹返回 unknown。
 * - `force = true`：无声纹时改用本机 ASR 做语音探针对齐（YouTube 字幕播 RSS 音频 / 旧共享字幕 / Podscribe）。
 */
export async function alignCurrent(force = false) {
  const s = useStore.getState();
  const ep = s.current;
  if (!ep || !ep.audioUrl) return;
  if (usesYtEngine(ep, s.audioOnly)) return;
  if (s.align?.id === ep.id && s.align.status === "working") return;

  const prev = s.align?.id === ep.id ? s.align : null;
  s.set({
    align: {
      id: ep.id,
      status: "working",
      map: prev?.map ?? null,
      path: prev?.path ?? null,
      localBytes: prev?.localBytes ?? 0,
    },
  });

  try {
    const r = await api.alignAudio(ep.id, force, force ? s.settings.asrModel : undefined);
    if (useStore.getState().current?.id !== ep.id) return;
    const map = r.map && r.map.pieces.length ? r.map : null;
    useStore.getState().set({
      align: {
        id: ep.id,
        status: r.status,
        map,
        path: r.path,
        localBytes: r.localBytes,
      },
    });
    audioBridge?.onMapUpdated(ep.id, r.path, r.localBytes);
    if (force) {
      if (r.status === "aligned") {
        useStore.getState().notify(tNow("字幕已按你听到的音频重新对齐"));
      } else if (r.status === "same") {
        useStore.getState().notify(tNow("字幕和你听到的音频是同一个版本，不用对齐"));
      } else {
        useStore.getState().notify(tNow("没能自动对齐，可以手动点一下正在听到的那句"));
      }
    }
  } catch (e) {
    if (useStore.getState().current?.id === ep.id) {
      useStore.getState().set({
        align: {
          id: ep.id,
          status: "failed",
          map: prev?.map ?? null,
          path: prev?.path ?? null,
          localBytes: prev?.localBytes ?? 0,
        },
      });
    }
    if (force) {
      useStore.getState().notify(tNow("没能自动对齐：{error}", { error: errText(e) }));
    }
  }
}

/** 手调后立刻生效、同步 UI 时钟并落盘。 */
export async function setManualMap(map: TimeMap) {
  const s = useStore.getState();
  if (!s.current) return;
  const epId = s.current.id;
  const was = s.align?.id === epId ? s.align : null;
  const empty = !map.pieces.length;
  s.set({
    align: {
      id: epId,
      status: empty ? "same" : "aligned",
      map: empty ? null : map,
      path: was?.path ?? null,
      localBytes: was?.localBytes ?? map.playBytes,
    },
  });
  audioBridge?.onMapUpdated(epId, null, was?.localBytes ?? map.playBytes);
  await api.saveTimeMap(epId, map).catch(() => {});
}

/** 从当前句起整体平移 secs（负=字幕更早出现）。 */
export function nudgeFromHere(secs: number) {
  const s = useStore.getState();
  if (!s.current) return;
  const epId = s.current.id;
  const a = s.align?.id === epId ? s.align : null;
  const raw = audioBridge?.getRawTime(epId) ?? s.rawTime ?? toPlay(a?.map, s.time);
  const ref = toContent(a?.map, raw).at;
  void setManualMap(anchorAt(a?.map, ref, Math.max(0, raw + secs), a?.localBytes ?? 0));
}

/** 点字幕行：「听到的就是这句」。反应延迟约 0.8s（暂停态不扣反应延迟）。 */
const REACTION = 0.8;

export function anchorHere(at: number) {
  const s = useStore.getState();
  if (!s.current) return;
  const epId = s.current.id;
  const a = s.align?.id === epId ? s.align : null;
  const raw = audioBridge?.getRawTime(epId) ?? s.rawTime ?? toPlay(a?.map, s.time);
  const playAt = s.playing ? Math.max(0, raw - REACTION) : Math.max(0, raw);
  void setManualMap(anchorAt(a?.map, at, playAt, a?.localBytes ?? 0));
  s.notify(tNow("从这一句起，字幕已对上你听到的声音"));
}
