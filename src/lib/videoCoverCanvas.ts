/**
 * [INPUT]: format.clock、webfonts、画布尺寸
 * [OUTPUT]: renderCoverCanvas / subjectCenterX / parseHighlightTokens
 * [POS]: 剪视频封面工作室（无海报产品，仅切片封面）
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/CLAUDE.md
 */
import { clock } from "./format";
import { ensureFont, familyOf, type CoverFontId } from "./webfonts";

export type CoverTemplateId =
  | "impact"
  | "marker"
  | "split"
  | "bold"
  | "quote"
  | "magazine"
  | "cinema"
  | "minimal";
export type CoverAspect = "9:16" | "16:9" | "3:4" | "1:1";

export interface CoverConfig {
  template: CoverTemplateId;
  aspect: CoverAspect;
  hookTitle: string;
  subTitle: string;
  kicker: string;
  showName: string;
  durationSec: number;
  backdropUrl?: string | null;
  brand?: string;
  cropBottom?: number;
  accent?: string;
  font?: CoverFontId;
  titleScale?: number;
  tracking?: number;
}

const inkOn = (hex: string) => {
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#141416" : "#ffffff";
};

const SANS =
  '-apple-system, "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", sans-serif';
const SERIF = '"Songti SC", "STSong", "Noto Serif SC", Georgia, serif';

export function coverDimensions(aspect: CoverAspect): { width: number; height: number } {
  if (aspect === "16:9") return { width: 1920, height: 1080 };
  if (aspect === "3:4") return { width: 1080, height: 1440 };
  if (aspect === "1:1") return { width: 1080, height: 1080 };
  return { width: 1080, height: 1920 };
}

interface RichToken {
  text: string;
  hi: boolean;
}

export function parseHighlightTokens(input: string): RichToken[] {
  const clean = input.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const tokens: RichToken[] = [];
  const re = /【([^】]+)】/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushUnits = (str: string, hi: boolean) => {
    const units = str.match(/[A-Za-z0-9'’\-.,;:!?%$]+\s*|\s+|./gu) || [];
    for (const u of units) tokens.push({ text: u, hi });
  };
  while ((m = re.exec(clean)) !== null) {
    if (m.index > last) pushUnits(clean.slice(last, m.index), false);
    pushUnits(m[1], true);
    last = re.lastIndex;
  }
  if (last < clean.length) pushUnits(clean.slice(last), false);
  return tokens;
}

function wrapRichLines(
  g: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  maxLines: number,
): RichToken[][] {
  const toks = parseHighlightTokens(text);
  if (!toks.length) return [];
  const lines: RichToken[][] = [];
  let cur: RichToken[] = [];
  let curW = 0;
  for (const tok of toks) {
    if (!cur.length && /^\s+$/.test(tok.text)) continue;
    const w = g.measureText(tok.text).width;
    if (curW + w > maxW && cur.length) {
      lines.push(cur);
      cur = /^\s+$/.test(tok.text) ? [] : [tok];
      curW = cur.length ? w : 0;
      if (lines.length === maxLines) {
        cur = [];
        break;
      }
    } else {
      cur.push(tok);
      curW += w;
    }
  }
  if (cur.length && lines.length < maxLines) lines.push(cur);
  return lines.map((ln) => {
    const out = [...ln];
    while (out.length && /^\s+$/.test(out[out.length - 1].text)) out.pop();
    return out;
  });
}

function wrapPlain(g: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  return wrapRichLines(g, text.replace(/[【】]/g, ""), maxW, maxLines).map((ln) =>
    ln.map((t) => t.text).join(""),
  );
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}

function drawCoverImage(
  g: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  focusY = 0.42,
  cropBottom = 0,
  focusX = 0.5,
) {
  const sw = img.naturalWidth || 1280;
  const sh = (img.naturalHeight || 720) * (1 - cropBottom);
  const scale = Math.max(dw / sw, dh / sh);
  const rw = sw * scale;
  const rh = sh * scale;
  const ox =
    rw > dw ? Math.min(dx, Math.max(dx + dw - rw, dx + dw / 2 - rw * focusX)) : dx + (dw - rw) / 2;
  const oy = dy + (dh - rh) * focusY;
  g.save();
  g.beginPath();
  g.rect(dx, dy, dw, dh);
  g.clip();
  g.drawImage(img, 0, 0, sw, sh, ox, oy, rw, rh);
  g.restore();
}

function drawRichLine(
  g: CanvasRenderingContext2D,
  tokens: RichToken[],
  x: number,
  y: number,
  fontSize: number,
  baseColor: string,
  hiColor: string,
  markerBg?: string,
  markerText?: string,
) {
  let cx = x;
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].hi && markerBg) {
      let j = i;
      let run = "";
      while (j < tokens.length && tokens[j].hi) {
        run += tokens[j].text;
        j++;
      }
      const rw = g.measureText(run).width;
      const padX = Math.round(fontSize * 0.16);
      const padY = Math.round(fontSize * 0.1);
      g.save();
      g.shadowColor = "transparent";
      g.shadowBlur = 0;
      g.fillStyle = markerBg;
      roundRect(g, cx + 2, y - fontSize * 0.88 - padY * 0.3, rw + padX * 2 - 4, fontSize * 1.14 + padY, 14);
      g.fill();
      g.fillStyle = markerText ?? "#141416";
      g.fillText(run, cx + padX, y);
      g.restore();
      cx += rw + padX * 2;
      i = j;
    } else {
      const tok = tokens[i];
      g.fillStyle = tok.hi ? hiColor : baseColor;
      g.fillText(tok.text, cx, y);
      cx += g.measureText(tok.text).width;
      i++;
    }
  }
}

function measureRichLine(
  g: CanvasRenderingContext2D,
  tokens: RichToken[],
  fontSize: number,
  hasMarkerBg: boolean,
): number {
  let w = 0;
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].hi && hasMarkerBg) {
      let run = "";
      while (i < tokens.length && tokens[i].hi) {
        run += tokens[i].text;
        i++;
      }
      w += g.measureText(run).width + Math.round(fontSize * 0.16) * 2;
    } else {
      w += g.measureText(tokens[i].text).width;
      i++;
    }
  }
  return w;
}

async function loadImageSafe(url?: string | null): Promise<HTMLImageElement | null> {
  if (!url) return null;
  return new Promise((resolve) => {
    const img = new Image();
    if (!url.startsWith("data:") && !url.startsWith("blob:")) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function drawFallbackBackdrop(g: CanvasRenderingContext2D, W: number, H: number) {
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#1c1b20");
  grad.addColorStop(0.55, "#131317");
  grad.addColorStop(1, "#0b0b0e");
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(W * 0.25, H * 0.25, 20, W * 0.25, H * 0.25, W * 0.7);
  glow.addColorStop(0, "rgba(232, 88, 42, 0.16)");
  glow.addColorStop(1, "rgba(232, 88, 42, 0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);
}

function heavyStroke(g: CanvasRenderingContext2D, size: number) {
  g.lineJoin = "round";
  g.lineWidth = Math.max(1, size * 0.045);
}

function drawHeavyLine(
  g: CanvasRenderingContext2D,
  tokens: RichToken[],
  x: number,
  y: number,
  size: number,
  ink: string,
  hot: string,
  opts: { outline?: string; outlineW?: number; marker?: string; markerInk?: string } = {},
) {
  let cx = x;
  let i = 0;
  while (i < tokens.length) {
    let j = i;
    let run = "";
    const hi = tokens[i].hi;
    while (j < tokens.length && tokens[j].hi === hi) {
      run += tokens[j].text;
      j++;
    }
    const w = g.measureText(run).width;
    if (hi && opts.marker) {
      const px = Math.round(size * 0.16);
      g.fillStyle = opts.marker;
      roundRect(g, cx, y - size * 0.92, w + px * 2, size * 1.16, size * 0.14);
      g.fill();
      g.fillStyle = opts.markerInk ?? "#141416";
      heavyStroke(g, size);
      g.strokeText(run, cx + px, y);
      g.fillText(run, cx + px, y);
      cx += w + px * 2;
    } else {
      const color = hi ? hot : ink;
      if (opts.outline) {
        g.lineJoin = "round";
        g.lineWidth = opts.outlineW ?? size * 0.16;
        g.strokeStyle = opts.outline;
        g.strokeText(run, cx, y);
      }
      g.fillStyle = color;
      g.strokeStyle = color;
      heavyStroke(g, size);
      g.strokeText(run, cx, y);
      g.fillText(run, cx, y);
      cx += w;
    }
    i = j;
  }
}

function fitTitle(
  g: CanvasRenderingContext2D,
  text: string,
  font: (s: number) => string,
  maxW: number,
  lines: number,
  max: number,
  min: number,
): { size: number; rows: RichToken[][] } {
  const phrases: string[] = [];
  let cur = "";
  let depth = 0;
  for (const ch of text) {
    cur += ch;
    if (ch === "【") depth++;
    if (ch === "】") depth = Math.max(0, depth - 1);
    if (!depth && /[，、：；！？,:;!?]/.test(ch)) {
      phrases.push(cur);
      cur = "";
    }
  }
  if (cur.trim()) phrases.push(cur);
  const ok = (rows: RichToken[][]) =>
    rows.length <= lines &&
    rows.every((r) => r.map((t) => t.text).join("").replace(/[\s，。、：；！？,.:;!?]/g, "").length >= 3);
  const byPhrase = (size: number) => {
    g.font = font(size);
    return phrases.flatMap((p) => wrapRichLines(g, p.trim(), maxW, lines + 1));
  };
  if (phrases.length > 1) {
    for (let size = max; size >= Math.max(min, max * 0.7); size -= 2) {
      const rows = byPhrase(size);
      if (ok(rows)) return { size, rows };
    }
  }
  for (let size = max; size >= min; size -= 2) {
    g.font = font(size);
    const rows = wrapRichLines(g, text, maxW, lines + 1);
    if (ok(rows)) return { size, rows };
  }
  g.font = font(min);
  return { size: min, rows: wrapRichLines(g, text, maxW, lines) };
}

function pill(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  bg: string,
  ink: string,
  align: "left" | "right" = "left",
  family = SANS,
) {
  g.font = `600 ${size}px ${family}`;
  const w = g.measureText(text).width + size * 1.2;
  const h = size * 1.9;
  const px = align === "right" ? x - w : x;
  g.fillStyle = bg;
  roundRect(g, px, y, w, h, h / 2);
  g.fill();
  g.fillStyle = ink;
  g.fillText(text, px + size * 0.6, y + h * 0.66);
}

function shade(g: CanvasRenderingContext2D, W: number, y0: number, y1: number, from: string, to: string) {
  const gr = g.createLinearGradient(0, y0, 0, y1);
  gr.addColorStop(0, from);
  gr.addColorStop(1, to);
  g.fillStyle = gr;
  g.fillRect(0, y0, W, y1 - y0);
}

const subjectCache = new Map<string, number>();

export function subjectCenterX(img: HTMLImageElement, cropBottom = 0): number {
  const key = `${img.src.slice(-64)}|${cropBottom}`;
  const hit = subjectCache.get(key);
  if (hit != null) return hit;
  const w = 96;
  const h = 54;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight * (1 - cropBottom), 0, 0, w, h);
  let data: Uint8ClampedArray;
  try {
    data = g.getImageData(0, 0, w, h).data;
  } catch {
    return 0.5;
  }
  const cols = new Float64Array(w);
  let total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const gr = data[i + 1];
      const b = data[i + 2];
      const cb = 128 - 0.168736 * r - 0.331264 * gr + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * gr - 0.081312 * b;
      const yy = 0.299 * r + 0.587 * gr + 0.114 * b;
      if (yy > 50 && cb >= 77 && cb <= 127 && cr >= 135 && cr <= 173) {
        cols[x] += 1;
        total++;
      }
    }
  }
  let res = 0.5;
  if (total > w * h * 0.004) {
    const win = Math.round(w * 0.22);
    let best = -1;
    let at = 0;
    let run = 0;
    for (let x = 0; x < w; x++) {
      run += cols[x] - (x >= win ? cols[x - win] : 0);
      if (x >= win - 1 && run > best) {
        best = run;
        at = x - win / 2 + 0.5;
      }
    }
    res = Math.min(0.95, Math.max(0.05, at / w));
  }
  subjectCache.set(key, res);
  return res;
}

export async function renderCoverCanvas(config: CoverConfig): Promise<HTMLCanvasElement> {
  const { width: W, height: H } = coverDimensions(config.aspect);
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.textBaseline = "alphabetic";
  const img = await loadImageSafe(config.backdropUrl);
  const face = config.font ?? "";
  const faceReady = await ensureFont(
    face,
    [config.hookTitle, config.subTitle, config.kicker, config.showName, config.brand ?? ""].join(""),
  );
  const TF = (fallback: string) => {
    if (face === "serif") return SERIF;
    if (face === "sans") return SANS;
    if (face && faceReady) return familyOf(face, fallback);
    return fallback;
  };
  const subjectX = img ? subjectCenterX(img, config.cropBottom ?? 0) : 0.5;
  const u = Math.min(W, H) / 1080;
  const land = W > H * 1.2;
  const tall = H > W * 1.5;
  const dur = config.durationSec > 0 ? `▶ ${clock(config.durationSec)}` : "";
  const kicker = (config.kicker || config.showName || "").trim();
  const title = (config.hookTitle || "").trim() || " ";
  const sub = config.subTitle.trim();
  const brand = (config.brand ?? "").trim();
  const padX = Math.round((land ? 110 : 76) * u);
  const maxW = W - padX * 2;
  const titleLines = land ? 2 : tall ? 4 : 3;
  const HOT = (fb: string) => config.accent || fb;
  const ts = Math.min(1.25, Math.max(0.8, config.titleScale ?? 1));
  const fit = (
    text: string,
    font: (s: number) => string,
    width: number,
    lines: number,
    max: number,
    min: number,
  ) =>
    fitTitle(
      g,
      text,
      font,
      width,
      lines,
      Math.round(max * ts * (land ? 1.3 : 1)),
      Math.round(min * ts * (land ? 1.2 : 1)),
    );
  const photo = (x: number, y: number, w: number, h: number, focus = 0.4) => {
    if (img) drawCoverImage(g, img, x, y, w, h, focus, config.cropBottom ?? 0, subjectX);
    else {
      g.save();
      g.translate(x, y);
      drawFallbackBackdrop(g, w, h);
      g.restore();
    }
  };
  const footer = (color: string, y: number, align: "center" | "left" = "center") => {
    const text = [brand, !brand ? config.showName : ""].filter(Boolean).join(" · ");
    if (!text) return;
    g.font = `600 ${Math.round(28 * u)}px ${TF(SANS)}`;
    g.fillStyle = color;
    g.save();
    if (color.startsWith("rgba(255")) {
      g.shadowColor = "rgba(0,0,0,0.6)";
      g.shadowBlur = 8 * u;
    }
    const tw = g.measureText(text).width;
    g.fillText(text, align === "center" ? (W - tw) / 2 : padX, y);
    g.restore();
  };
  const subLines = (font: string, width: number) => {
    g.font = font;
    return sub ? wrapPlain(g, sub, width, 2) : [];
  };

  if (config.tracking) {
    (g as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${Math.round(config.tracking * 64 * u)}px`;
  }

  const tpl = config.template;
  const marker = tpl === "marker";

  if (tpl === "split") {
    const ph = Math.round(H * (land ? 1 : tall ? 0.5 : 0.52));
    const bx = land ? Math.round(W * 0.5) : 0;
    if (land) photo(0, 0, bx, H, 0.4);
    else photo(0, 0, W, ph, 0.38);
    g.fillStyle = "#121214";
    if (land) g.fillRect(bx, 0, W - bx, H);
    else g.fillRect(0, ph, W, H - ph);
    const left = (land ? bx : 0) + padX;
    const width = (land ? W - bx : W) - padX * 2;
    const { size, rows } = fit(
      title,
      (s) => `700 ${s}px ${TF(SANS)}`,
      width,
      land ? 3 : 4,
      Math.round((tall ? 112 : 96) * u),
      Math.round(56 * u),
    );
    const slPre = subLines(`600 ${Math.round(40 * u)}px ${TF(SANS)}`, width);
    const blockH =
      (kicker ? Math.round(84 * u) : 0) +
      rows.length * Math.round(size * 1.22) +
      (slPre.length ? Math.round(28 * u) + slPre.length * Math.round(56 * u) : 0);
    const areaTop = land ? 0 : ph;
    const areaH = (land ? H : H - ph) - Math.round(90 * u);
    let y = areaTop + Math.max(Math.round(50 * u), Math.round((areaH - blockH) / 2));
    if (kicker) {
      pill(g, kicker, left, y, Math.round(28 * u), HOT("#ffd23f"), inkOn(HOT("#ffd23f")), "left", TF(SANS));
      y += Math.round(84 * u);
    }
    g.font = `700 ${size}px ${TF(SANS)}`;
    rows.forEach((r) => {
      y += Math.round(size * 1.22);
      drawHeavyLine(g, r, left, y, size, "#ffffff", HOT("#ffd23f"));
    });
    const sl = subLines(`600 ${Math.round(40 * u)}px ${TF(SANS)}`, width);
    y += Math.round(28 * u);
    g.fillStyle = "rgba(255,255,255,0.86)";
    sl.forEach((l) => {
      y += Math.round(56 * u);
      g.fillText(l, left, y);
    });
    if (dur) {
      pill(g, dur, W - padX, Math.round(40 * u), Math.round(26 * u), "rgba(0,0,0,0.62)", "#fff", "right", TF(SANS));
    }
    footer("rgba(255,255,255,0.62)", H - Math.round(48 * u), land ? "left" : "center");
    return c;
  }

  if (tpl === "bold") {
    photo(0, 0, W, H, 0.38);
    shade(g, W, 0, H, "rgba(0,0,0,0.12)", "rgba(0,0,0,0.32)");
    const { size, rows } = fit(
      title,
      (s) => `700 ${s}px ${TF(SANS)}`,
      maxW,
      titleLines,
      Math.round((land ? 120 : 118) * u),
      Math.round(64 * u),
    );
    g.font = `700 ${size}px ${TF(SANS)}`;
    const lh = Math.round(size * 1.18);
    let y = Math.round(H * (land ? 0.52 : tall ? 0.64 : 0.6) - (rows.length * lh) / 2);
    rows.forEach((r) => {
      y += lh;
      const w = measureRichLine(g, r, size, false);
      drawHeavyLine(g, r, (W - w) / 2, y, size, "#ffffff", HOT("#ffe14d"), {
        outline: "#111",
        outlineW: size * 0.2,
      });
    });
    const sl = subLines(`600 ${Math.round(44 * u)}px ${TF(SANS)}`, maxW);
    if (sl.length) {
      y += Math.round(30 * u);
      sl.forEach((l) => {
        g.font = `600 ${Math.round(44 * u)}px ${TF(SANS)}`;
        const w = g.measureText(l).width + 40 * u;
        y += Math.round(72 * u);
        g.fillStyle = "rgba(0,0,0,0.8)";
        roundRect(g, (W - w) / 2, y - 52 * u, w, 68 * u, 10 * u);
        g.fill();
        g.fillStyle = "#fff";
        g.fillText(l, (W - w) / 2 + 20 * u, y);
      });
    }
    if (kicker) {
      pill(g, kicker, padX, Math.round(56 * u), Math.round(28 * u), "rgba(0,0,0,0.66)", HOT("#ffe14d"), "left", TF(SANS));
    }
    footer("rgba(255,255,255,0.8)", H - Math.round(60 * u));
    return c;
  }

  if (tpl === "quote") {
    g.fillStyle = "#f4efe6";
    g.fillRect(0, 0, W, H);
    const r = Math.round((land ? 170 : tall ? 120 : 96) * u);
    const left = padX;
    const width = land ? W - padX * 3 - r * 2 : maxW;
    const { size, rows } = fit(
      title,
      (s) => `700 ${s}px ${TF(SERIF)}`,
      width,
      titleLines,
      Math.round((tall ? 96 : 80) * u),
      Math.round(48 * u),
    );
    const lh = Math.round(size * 1.38);
    const sl = subLines(`500 ${Math.round(38 * u)}px ${TF(SANS)}`, width);
    const markH = Math.round(110 * u);
    const blockH =
      (land ? 0 : r * 2 + Math.round(60 * u)) +
      markH +
      rows.length * lh +
      (sl.length ? Math.round(30 * u) + sl.length * Math.round(54 * u) : 0);
    let y = Math.max(Math.round(60 * u), Math.round((H - Math.round(140 * u) - blockH) / 2));
    const cx = land ? W - padX - r : W / 2;
    const cy = land ? H / 2 : y + r;
    if (img) {
      g.save();
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.clip();
      drawCoverImage(g, img, cx - r, cy - r, r * 2, r * 2, 0.25, config.cropBottom ?? 0, subjectX);
      g.restore();
    }
    if (!land) y += r * 2 + Math.round(60 * u);
    g.font = `700 ${Math.round(160 * u)}px ${TF(SERIF)}`;
    g.fillStyle = HOT("#d9480f");
    g.fillText("“", left - 8 * u, y + Math.round(120 * u));
    y += markH;
    g.font = `700 ${size}px ${TF(SERIF)}`;
    rows.forEach((row) => {
      y += lh;
      drawRichLine(g, row, left, y - lh * 0.2, size, "#18181b", HOT("#d9480f"));
    });
    y += Math.round(30 * u);
    g.font = `500 ${Math.round(38 * u)}px ${TF(SANS)}`;
    g.fillStyle = "#44403c";
    sl.forEach((l) => {
      y += Math.round(54 * u);
      g.fillText(l, left, y);
    });
    g.fillStyle = "rgba(24,24,27,0.16)";
    g.fillRect(left, H - Math.round(118 * u), Math.round(80 * u), Math.max(2, 3 * u));
    g.font = `600 ${Math.round(30 * u)}px ${TF(SANS)}`;
    g.fillStyle = "#3f3f46";
    g.fillText(kicker, left, H - Math.round(70 * u));
    if (brand) {
      g.font = `600 ${Math.round(28 * u)}px ${TF(SANS)}`;
      g.fillStyle = "#57534e";
      const bw = g.measureText(brand).width;
      g.fillText(brand, W - padX - bw, H - Math.round(70 * u));
    }
    return c;
  }

  if (tpl === "magazine") {
    const ph = Math.round(H * (land ? 0.6 : 0.52));
    g.fillStyle = "#faf7f2";
    g.fillRect(0, 0, W, H);
    photo(0, 0, W, ph, 0.36);
    shade(g, W, ph - 90 * u, ph, "rgba(250,247,242,0)", "#faf7f2");
    if (dur) {
      pill(g, dur, W - padX, Math.round(44 * u), Math.round(26 * u), "rgba(18,18,22,0.72)", "#fff", "right", TF(SANS));
    }
    let y = ph + Math.round((land ? 40 : 64) * u);
    g.font = `700 ${Math.round(30 * u)}px ${TF(SANS)}`;
    g.fillStyle = HOT("#d9481a");
    if (kicker) {
      g.fillText(kicker, padX, y);
      y += Math.round(20 * u);
    }
    const { size, rows } = fit(
      title,
      (s) => `700 ${s}px ${TF(SANS)}`,
      maxW,
      land ? 2 : 3,
      Math.round(82 * u),
      Math.round(52 * u),
    );
    g.font = `700 ${size}px ${TF(SANS)}`;
    rows.forEach((r) => {
      y += Math.round(size * 1.24);
      drawHeavyLine(g, r, padX, y, size, "#18181b", HOT("#d9481a"));
    });
    const sl = subLines(`500 ${Math.round(38 * u)}px ${TF(SANS)}`, maxW);
    y += Math.round(20 * u);
    g.fillStyle = "#44403c";
    sl.forEach((l) => {
      y += Math.round(54 * u);
      g.fillText(l, padX, y);
    });
    g.fillStyle = "#e6e0d6";
    g.fillRect(padX, H - Math.round(100 * u), maxW, Math.max(2, 2 * u));
    footer("#57534e", H - Math.round(54 * u), "left");
    return c;
  }

  if (tpl === "cinema") {
    g.fillStyle = "#121113";
    g.fillRect(0, 0, W, H);
    const fw = W - padX * 2;
    const fh = Math.round(land ? H * 0.52 : (fw * 9) / 16);
    const top = Math.round(land ? 96 * u : H * (tall ? 0.16 : 0.12));
    g.font = `600 ${Math.round(28 * u)}px ${TF(SANS)}`;
    g.fillStyle = "rgba(255,255,255,0.82)";
    if (kicker) g.fillText(kicker, padX, top - 26 * u);
    if (dur) {
      const dw = g.measureText(dur).width;
      g.fillStyle = "#f5a623";
      g.fillText(dur, W - padX - dw, top - 26 * u);
    }
    photo(padX, top, fw, fh, 0.42);
    const { size, rows } = fit(
      title,
      (s) => `700 ${s}px ${TF(SERIF)}`,
      fw,
      titleLines,
      Math.round((tall ? 92 : 80) * u),
      Math.round(48 * u),
    );
    const slPre = subLines(`500 ${Math.round(38 * u)}px ${TF(SANS)}`, fw);
    const blockH =
      rows.length * Math.round(size * 1.32) +
      (slPre.length ? Math.round(18 * u) + slPre.length * Math.round(54 * u) : 0);
    const below = H - (top + fh) - Math.round(100 * u);
    let y = top + fh + Math.max(Math.round((land ? 20 : 50) * u), Math.round((below - blockH) / 2));
    g.font = `700 ${size}px ${TF(SERIF)}`;
    rows.forEach((r) => {
      y += Math.round(size * 1.32);
      const w = measureRichLine(g, r, size, false);
      drawRichLine(g, r, (W - w) / 2, y, size, "#f5f2eb", HOT("#fbbf24"));
    });
    const sl = subLines(`500 ${Math.round(38 * u)}px ${TF(SANS)}`, fw);
    y += Math.round(18 * u);
    g.fillStyle = "rgba(245,242,235,0.88)";
    sl.forEach((l) => {
      y += Math.round(54 * u);
      g.fillText(l, (W - g.measureText(l).width) / 2, y);
    });
    footer("rgba(255,255,255,0.6)", H - Math.round(54 * u));
    return c;
  }

  if (tpl === "minimal") {
    photo(0, 0, W, H, 0.4);
    shade(g, W, H * 0.4, H, "rgba(0,0,0,0)", "rgba(0,0,0,0.88)");
    const { size, rows } = fit(
      title,
      (s) => `600 ${s}px ${TF(SERIF)}`,
      maxW,
      land ? 2 : 3,
      Math.round(84 * u),
      Math.round(48 * u),
    );
    g.font = `600 ${size}px ${TF(SERIF)}`;
    const sl = subLines(`500 ${Math.round(36 * u)}px ${TF(SANS)}`, maxW);
    const lh = Math.round(size * 1.34);
    let y =
      H -
      Math.round((brand || config.showName ? 130 : 90) * u) -
      rows.length * lh -
      sl.length * Math.round(52 * u);
    g.shadowColor = "rgba(0,0,0,0.5)";
    g.shadowBlur = 12 * u;
    rows.forEach((r) => {
      y += lh;
      drawRichLine(g, r, padX, y, size, "#ffffff", HOT("#ffd27a"));
    });
    g.font = `500 ${Math.round(36 * u)}px ${TF(SANS)}`;
    g.fillStyle = "rgba(255,255,255,0.9)";
    y += Math.round(10 * u);
    sl.forEach((l) => {
      y += Math.round(52 * u);
      g.fillText(l, padX, y);
    });
    g.shadowColor = "transparent";
    g.shadowBlur = 0;
    if (kicker) {
      g.font = `600 ${Math.round(28 * u)}px ${TF(SANS)}`;
      g.fillStyle = "rgba(255,255,255,0.88)";
      g.fillText(kicker.toUpperCase(), padX, Math.round(80 * u));
    }
    footer("rgba(255,255,255,0.78)", H - Math.round(56 * u), "left");
    return c;
  }

  // impact / marker default
  photo(0, 0, W, H, 0.38);
  shade(g, W, 0, H * 0.3, "rgba(8,8,12,0.55)", "rgba(8,8,12,0)");
  shade(g, W, H * 0.38, H, "rgba(8,8,12,0)", "rgba(8,8,12,0.92)");
  const top = Math.round(56 * u);
  if (kicker) {
    pill(g, kicker, padX, top, Math.round(28 * u), "rgba(18,18,22,0.74)", HOT("#ffd23f"), "left", TF(SANS));
  }
  if (dur) {
    pill(g, dur, W - padX, top, Math.round(28 * u), "rgba(18,18,22,0.74)", "#fff", "right", TF(SANS));
  }
  const { size, rows } = fit(
    title,
    (s) => `700 ${s}px ${TF(SANS)}`,
    maxW,
    titleLines,
    Math.round((land ? 96 : 100) * u),
    Math.round(56 * u),
  );
  const sl = subLines(`600 ${Math.round(44 * u)}px ${TF(SANS)}`, maxW);
  const lh = Math.round(size * 1.26);
  const subH = sl.length ? sl.length * Math.round(60 * u) + Math.round(26 * u) : 0;
  let y = H - Math.round((land ? 100 : tall ? 220 : 130) * u) - rows.length * lh - subH;
  g.font = `700 ${size}px ${TF(SANS)}`;
  g.shadowColor = "rgba(0,0,0,0.6)";
  g.shadowBlur = 20 * u;
  g.shadowOffsetY = 3 * u;
  rows.forEach((r) => {
    y += lh;
    const w = measureRichLine(g, r, size, marker);
    drawHeavyLine(
      g,
      r,
      (W - w) / 2,
      y,
      size,
      "#ffffff",
      HOT("#ffd23f"),
      marker ? { marker: HOT("#ffd23f"), markerInk: inkOn(HOT("#ffd23f")) } : {},
    );
  });
  g.font = `600 ${Math.round(44 * u)}px ${TF(SANS)}`;
  g.fillStyle = "rgba(255,255,255,0.94)";
  g.shadowBlur = 12 * u;
  g.shadowOffsetY = 2 * u;
  y += Math.round(26 * u);
  sl.forEach((l) => {
    y += Math.round(60 * u);
    g.fillText(l, (W - g.measureText(l).width) / 2, y);
  });
  g.shadowColor = "transparent";
  g.shadowBlur = 0;
  g.shadowOffsetY = 0;
  footer("rgba(255,255,255,0.75)", H - Math.round((land ? 40 : 70) * u));
  return c;
}