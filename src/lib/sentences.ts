/**
 * [INPUT]: 精读 HTML / 纯文本；可选合成音频时长
 * [OUTPUT]: splitSentences / markSentences / estimateMarks / spokenChars
 * [POS]: 精读跟读（ReadAlong）句切分、句级标记与字级高亮估计
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

/** 中英文句末标点，以及紧随其后的收尾引号/括号。 */
const END = /[。！？!?；;…]+["'”’」』）)】》]*|[.](?=\s)["'”’）)]*/gu;
/** 短于此的片段并入上一句（如孤零的「家。」）。 */
const MIN_CHARS = 6;
/** 长于此则在逗号处切开，便于更快出首段音频与跳句。 */
const MAX_CHARS = 160;

/** 返回 `text` 中各句的 [start, end)（已去首尾空白）。 */
export function splitSentences(text: string): [number, number][] {
  const raw: [number, number][] = [];
  let from = 0;
  for (const m of text.matchAll(END)) {
    const to = m.index! + m[0].length;
    raw.push([from, to]);
    from = to;
  }
  if (from < text.length) raw.push([from, text.length]);

  const out: [number, number][] = [];
  for (const [a0, b0] of raw) {
    let a = a0;
    let b = b0;
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (a >= b) continue;
    while (b - a > MAX_CHARS) {
      const slice = text.slice(a, a + MAX_CHARS);
      const cut = Math.max(slice.lastIndexOf("，"), slice.lastIndexOf(","), slice.lastIndexOf("、"));
      if (cut < MAX_CHARS / 3) break;
      out.push([a, a + cut + 1]);
      a += cut + 1;
      while (a < b && /\s/.test(text[a])) a++;
    }
    const last = out[out.length - 1];
    if (last && b - a < MIN_CHARS) last[1] = b;
    else out.push([a, b]);
  }
  return out;
}

/** 可读块；若块内还有同类块，交给子块处理。 */
const BLOCKS = "p, h2, h3, h4, li, blockquote, figcaption";

/**
 * 给文章可读块中的每个句子包上 `<span class="ra-s" data-s="N">`。
 * 跨越链接/加粗的句子会拆成多个同 N 的 span；跳过 [data-t] / code / pre。
 */
export function markSentences(html: string): { html: string; sentences: string[] } {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return { html: "", sentences: [] };
  const sentences: string[] = [];
  const blocks = Array.from(root.querySelectorAll(BLOCKS)).filter((b) => !b.querySelector(BLOCKS));
  for (const block of blocks) {
    const nodes: Text[] = [];
    const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement?.closest("[data-t], code, pre") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
    const text = nodes.map((n) => n.data).join("");
    const ranges = splitSentences(text);
    if (!ranges.length) continue;
    const base = sentences.length;
    for (const [a, b] of ranges) sentences.push(text.slice(a, b));
    let offset = 0;
    for (const node of nodes) {
      const start = offset;
      const end = offset + node.data.length;
      offset = end;
      const parts: Node[] = [];
      let cursor = start;
      ranges.forEach(([a, b], i) => {
        const s = Math.max(a, start);
        const e = Math.min(b, end);
        if (s >= e) return;
        if (s > cursor) parts.push(doc.createTextNode(text.slice(cursor, s)));
        const span = doc.createElement("span");
        span.className = "ra-s";
        span.dataset.s = String(base + i);
        span.textContent = text.slice(s, e);
        parts.push(span);
        cursor = e;
      });
      if (!parts.length) continue;
      if (cursor < end) parts.push(doc.createTextNode(text.slice(cursor, end)));
      node.replaceWith(...parts);
    }
  }
  return { html: root.innerHTML, sentences };
}

const PAUSE = /[，、；;,:：]/u;
const STOP = /[。！？.!?…\n]/u;
const CLOSE = /["'”’）)」』】》]/u;

/** 词/字在文本 [s,e)、在音频 [from,to) 秒内说出。 */
export interface Mark {
  s: number;
  e: number;
  from: number;
  to: number;
}

function tokens(text: string) {
  const out: { s: number; e: number; weight: number }[] = [];
  const re = /[㐀-鿿ぁ-んァ-ン가-힯]|[\p{L}\p{N}'’_-]+|[^\s]/gu;
  for (const m of text.matchAll(re)) {
    const value = m[0];
    const s = m.index!;
    const e = s + value.length;
    const last = out[out.length - 1];
    if (/^[\p{P}\p{S}]$/u.test(value) && last) {
      last.e = e;
      last.weight += STOP.test(value) ? 2.2 : PAUSE.test(value) ? 1.2 : CLOSE.test(value) ? 0 : 0.4;
      continue;
    }
    const cjk = /^[㐀-鿿ぁ-んァ-ン가-힯]$/u.test(value);
    out.push({ s, e, weight: cjk ? 1 : 1.3 + 0.18 * value.length });
  }
  return out;
}

/** 按权重把 `duration` 秒摊到 `text` 的词/字上（无时间戳引擎时估计进度）。 */
export function estimateMarks(text: string, duration: number): Mark[] {
  if (!(duration > 0)) return [];
  const list = tokens(text);
  const total = list.reduce((n, x) => n + x.weight, 0);
  if (!total) return [];
  let at = 0;
  return list.map((x) => {
    const from = at;
    at += (duration * x.weight) / total;
    return { s: x.s, e: x.e, from, to: at };
  });
}

/** `time` 秒时已读到的字符数（当前词结尾）。 */
export function spokenChars(marks: Mark[], time: number): number {
  let lo = 0;
  let hi = marks.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid].from <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found < 0 ? 0 : marks[found].e;
}
