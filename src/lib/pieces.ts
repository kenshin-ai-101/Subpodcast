/**
 * [INPUT]: 字幕块原文（英文/中文）
 * [OUTPUT]: pieces / pieceAt / timedPieces — 把长字幕块切成可读短句，并按进度取当前句
 * [POS]: 叠字幕与音频台跟读时钟；与原站一致：假定语速在块内按字长均摊
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const CACHE_MAX = 300;
const cache = new Map<string, string[]>();

/** 把一块字幕切成阅读粒度的短句（带 LRU 缓存，叠层每帧会问同一块）。 */
export function pieces(text: string, cjk: boolean): string[] {
  const key = `${cjk ? 1 : 0}|${text}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const res = split(text, cjk);
  cache.set(key, res);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return res;
}

function split(text: string, cjk: boolean): string[] {
  const soft = cjk ? 14 : 38;
  const hard = cjk ? 30 : 80;
  const units = cjk
    ? text.split(/(?<=[，。！？；：、,!?;]|\.(?!\d))/)
    : text.split(/(?<=\s)/);
  const out: string[] = [];
  let cur = "";
  for (let n = 0; n < units.length; n++) {
    const u = units[n]!;
    const nextStart = (units[n + 1] ?? "").trimStart()[0] ?? "";
    // 小数点 / 缩写后的小写字母不算句末
    const continues = !cjk && /\.$/.test(u.trim()) && /[a-z0-9]/.test(nextStart);
    if (cur && (cur + u).trim().length > hard) {
      out.push(cur.trim());
      cur = "";
    }
    cur += u;
    const t = cur.trim();
    const last = u.trim();
    const abbrev =
      !cjk &&
      /^(?:[A-Z]\.)+(?:[A-Z]\.?)?$|^(?:Mr|Mrs|Ms|Dr|St|vs|etc|Inc|Co|Jr|Sr|No|Vol)\.$/.test(last);
    if (
      (!abbrev && !continues && /[。！？.!?]["”')）]*$/.test(t)) ||
      (t.length >= soft && /[，；：,;:]$/.test(t))
    ) {
      out.push(t);
      cur = "";
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.length ? out : [text];
}

/** 假定语速按字长均摊，取当前进度对应的那一句。 */
export function pieceAt(text: string, cjk: boolean, progress: number): string {
  const ps = pieces(text, cjk);
  const total = ps.reduce((n, p) => n + p.length, 0);
  let acc = 0;
  for (const p of ps) {
    acc += p.length;
    if (acc / total >= progress) return p;
  }
  return ps[ps.length - 1]!;
}

/** 短句在块内的起止时间（按字长均摊）；过短的并入下一句。 */
const MIN_CUE = 1;

export function timedPieces(
  text: string,
  cjk: boolean,
  start: number,
  end: number,
): { start: number; end: number; text: string }[] {
  const ps = pieces(text, cjk);
  const total = ps.reduce((n, p) => n + p.length, 0) || 1;
  const out: { start: number; end: number; text: string }[] = [];
  let acc = 0;
  for (const p of ps) {
    const s = start + (end - start) * (acc / total);
    acc += p.length;
    const e = start + (end - start) * (acc / total);
    const last = out[out.length - 1];
    if (last && last.end - last.start < MIN_CUE) {
      last.end = e;
      last.text += (cjk ? "" : " ") + p;
    } else {
      out.push({ start: s, end: e, text: p });
    }
  }
  const last = out[out.length - 1];
  if (out.length > 1 && last && last.end - last.start < MIN_CUE) {
    const prev = out[out.length - 2]!;
    prev.end = last.end;
    prev.text += (cjk ? "" : " ") + last.text;
    out.pop();
  }
  return out;
}

/** 当前短句在 pieces 里的下标。 */
export function pieceIndex(ps: string[], progress: number): number {
  const total = ps.reduce((n, p) => n + p.length, 0) || 1;
  let acc = 0;
  for (let k = 0; k < ps.length; k++) {
    acc += ps[k]!.length;
    if (acc / total >= progress) return k;
  }
  return ps.length - 1;
}
