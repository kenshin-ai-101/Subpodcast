/**
 * [INPUT]: i18n（tNow）、assets/logo.png、Segment、按需动态加载 qrcode-generator 与开源字体样式表
 * [OUTPUT]: QUOTE_POSTER_THEMES / QUOTE_POSTER_FONTS / loadQuotePosterFont / extractSelectionQuote / renderQuotePoster
 * [POS]: 摘句「分享海报」画布引擎；对齐 1080×≥1350（4:5）5 套主题版式、5 款字体与扫码回跳二维码，品牌为「声译 · Subpodcast」
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/CLAUDE.md
 */
import type { Segment } from "./api";
import { tNow } from "./i18n";

export type QuotePosterLayout = "classic" | "magazine" | "cinema" | "bookmark" | "timecode";
export type QuotePosterThemeId = "paper" | "warm" | "night" | "bamboo" | "sand";
export type QuotePosterFontId = "sys" | "serif" | "kai" | "song" | "sans";

export interface QuotePosterTheme {
  id: QuotePosterThemeId;
  layout: QuotePosterLayout;
  name: string;
  style: string;
  bg: string;
  bgEnd?: string;
  ink: string;
  soft: string;
  muted: string;
  accent: string;
  rule: string;
}

export interface QuotePosterFont {
  id: QuotePosterFontId;
  name: string;
  family: string;
  stylesheet?: string;
  weight: number;
  sans?: boolean;
}

export interface QuotePosterInput {
  zh: string;
  en: string;
  title: string;
  show: string;
  meta: string;
  url?: string;
  ts?: string;
}

export interface ExtractedQuote {
  primary: string;
  original: string;
  needsTranslation: boolean;
}

const SYS_SERIF = '"Songti SC", "STSong", "Noto Serif SC", "Source Han Serif SC", serif';
const SYS_SANS = '-apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const LATIN_SERIF = 'Georgia, "Times New Roman", serif';
const CJK_RE = /[\u4e00-\u9fff]/;
const TIME_PREFIX_RE = /^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\s*/;
const NO_LINE_START = /^[，。、：；！？）」』》”’,.!?;:)\]…—]/;

export const QUOTE_POSTER_THEMES: readonly QuotePosterTheme[] = [
  {
    id: "paper",
    layout: "classic",
    name: "纸白",
    style: "经典",
    bg: "#faf8f3",
    ink: "#17181b",
    soft: "#4f525a",
    muted: "#8b8e96",
    accent: "#e8582a",
    rule: "#dedbd3",
  },
  {
    id: "warm",
    layout: "magazine",
    name: "暖橙",
    style: "杂志",
    bg: "#fdf1e8",
    bgEnd: "#f9dcc8",
    ink: "#2a1a12",
    soft: "#6b4a3a",
    muted: "#a07e6c",
    accent: "#d9481a",
    rule: "#efcfb9",
  },
  {
    id: "night",
    layout: "cinema",
    name: "墨夜",
    style: "电影",
    bg: "#151515",
    bgEnd: "#232120",
    ink: "#efebe4",
    soft: "#b9b4ab",
    muted: "#7f7b74",
    accent: "#ff7a45",
    rule: "#34312d",
  },
  {
    id: "bamboo",
    layout: "bookmark",
    name: "竹青",
    style: "书签",
    bg: "#eef1ea",
    ink: "#1d3328",
    soft: "#45604f",
    muted: "#7f9184",
    accent: "#2f7a55",
    rule: "#d3dccf",
  },
  {
    id: "sand",
    layout: "timecode",
    name: "砂岩",
    style: "时间码",
    bg: "#ebe4d8",
    ink: "#2b2622",
    soft: "#5d544b",
    muted: "#8f857a",
    accent: "#9c4a2f",
    rule: "#d4cab9",
  },
];

export const QUOTE_POSTER_FONTS: readonly QuotePosterFont[] = [
  { id: "sys", name: "系统宋体", family: SYS_SERIF, weight: 500 },
  {
    id: "serif",
    name: "思源宋体",
    family: '"Noto Serif SC"',
    stylesheet: "https://fonts.googleapis.cn/css2?family=Noto+Serif+SC:wght@500;700&display=swap",
    weight: 500,
  },
  {
    id: "kai",
    name: "霞鹜文楷",
    family: '"LXGW WenKai Screen"',
    stylesheet: "https://cdn.jsdelivr.net/npm/lxgw-wenkai-screen-webfont@1.7.0/lxgwwenkaiscreen.css",
    weight: 400,
  },
  {
    id: "song",
    name: "京华老宋体",
    family: '"KingHwa_OldSong"',
    stylesheet:
      "https://cdn.jsdelivr.net/npm/@chinese-fonts/jhlst@3.0.0/dist/%E4%BA%AC%E8%8F%AF%E8%80%81%E5%AE%8B%E4%BD%93v2_002/result.css",
    weight: 400,
  },
  {
    id: "sans",
    name: "思源黑体",
    family: '"Noto Sans SC"',
    stylesheet: "https://fonts.googleapis.cn/css2?family=Noto+Sans+SC:wght@500;700&display=swap",
    weight: 500,
    sans: true,
  },
];

const sheetPromises = new Map<string, Promise<void>>();

function ensureStylesheet(href: string): Promise<void> {
  const existing = sheetPromises.get(href);
  if (existing) return existing;
  const task = new Promise<void>((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => {
      sheetPromises.delete(href);
      reject(new Error("stylesheet load failed"));
    };
    document.head.appendChild(link);
  });
  sheetPromises.set(href, task);
  return task;
}

/** 按海报实际出现的字符切片按需加载开源字体，超时或断网返回 false 以回退系统字体。 */
export async function loadQuotePosterFont(font: QuotePosterFont, sampleText: string): Promise<boolean> {
  if (!font.stylesheet) return true;
  const glyphSample = sampleText.replace(/\s+/g, "") || "字";
  const job = (async () => {
    await ensureStylesheet(font.stylesheet!);
    await Promise.all([
      document.fonts.load(`${font.weight} 50px ${font.family}`, glyphSample),
      document.fonts.load(`700 30px ${font.family}`, glyphSample),
    ]);
    return document.fonts.check(`${font.weight} 50px ${font.family}`, glyphSample.slice(0, 20) || "字");
  })().catch(() => false);
  const timeout = new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 12_000));
  return Promise.race([job, timeout]);
}

function compact(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

function stripTimestamps(raw: string): string {
  return raw
    .split(/\r?\n+/)
    .map((line) => line.replace(TIME_PREFIX_RE, "").trim())
    .filter(Boolean)
    .join("\n");
}

function isMainlyChinese(text: string): boolean {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return cjk > 0 && cjk * 2 >= latin;
}

/**
 * 从选区文本与可选字幕行范围提取「主摘句」与「原文」：
 * - 跨行或覆盖整句时直接取干净的字幕译文/原文，彻底排除时间戳噪声；
 * - 单行局部框选时保留用户精确框选的字词。
 */
export function extractSelectionQuote(opts: {
  selectedText: string;
  segments?: Segment[];
  zh?: (string | null | undefined)[];
  startIdx?: number;
  endIdx?: number;
}): ExtractedQuote {
  const cleaned = stripTimestamps(opts.selectedText);
  const { segments, zh, startIdx, endIdx } = opts;

  if (segments?.length && startIdx != null) {
    const from = Math.max(0, Math.min(segments.length - 1, startIdx));
    const to = Math.max(from, Math.min(segments.length - 1, endIdx ?? from));
    const origSlice = segments
      .slice(from, to + 1)
      .map((s) => s.text.trim())
      .filter(Boolean)
      .join(" ");
    const zhSlice = Array.from({ length: to - from + 1 }, (_, k) => zh?.[from + k]?.trim() ?? "")
      .filter(Boolean)
      .join("");

    const selNorm = compact(cleaned);
    const origNorm = compact(origSlice);
    const zhNorm = compact(zhSlice);
    const multiLine = to > from;
    const coversWholeZh = Boolean(
      zhNorm && selNorm.length >= zhNorm.length * 0.72 && (zhNorm.includes(selNorm) || selNorm.includes(zhNorm)),
    );
    const coversWholeOrig = Boolean(
      origNorm &&
        selNorm.length >= origNorm.length * 0.72 &&
        (origNorm.includes(selNorm) || selNorm.includes(origNorm)),
    );

    if (multiLine || coversWholeZh || coversWholeOrig) {
      if (zhSlice && origSlice && zhSlice !== origSlice && !isMainlyChinese(origSlice)) {
        return { primary: zhSlice, original: origSlice, needsTranslation: false };
      }
      if (zhSlice) {
        return { primary: zhSlice, original: "", needsTranslation: false };
      }
      if (origSlice) {
        const cn = isMainlyChinese(origSlice);
        return { primary: origSlice, original: cn ? "" : origSlice, needsTranslation: !cn };
      }
    }

    if (isMainlyChinese(cleaned)) {
      const pairOrig = origSlice && !isMainlyChinese(origSlice) ? origSlice : "";
      return { primary: cleaned, original: pairOrig, needsTranslation: false };
    }
    return { primary: cleaned, original: cleaned, needsTranslation: true };
  }

  const lines = cleaned.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const zhLines: string[] = [];
  const otherLines: string[] = [];
  for (const line of lines) {
    const split = line.match(/^(.*[\u4e00-\u9fff][^A-Za-z]*?)\s+([A-Z"'“‘(][A-Za-z].{8,})$/);
    if (split && !CJK_RE.test(split[2])) {
      zhLines.push(split[1].trim());
      otherLines.push(split[2].trim());
    } else if (isMainlyChinese(line)) {
      zhLines.push(line);
    } else {
      otherLines.push(line);
    }
  }
  const zhText = zhLines.join("");
  const otherText = otherLines.join(" ");
  if (zhText) {
    return { primary: zhText, original: otherText, needsTranslation: false };
  }
  const fallback = cleaned.replace(/\n+/g, " ").trim();
  const cn = isMainlyChinese(fallback);
  return { primary: fallback, original: cn ? "" : fallback, needsTranslation: !cn && fallback.length > 0 };
}

function wrapLines(g: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const tokens = clean.match(/[A-Za-z0-9'’\-.,;:!?%$]+\s*|\s+|./gu) ?? [];
  const lines: string[] = [];
  let cur = "";

  for (const tok of tokens) {
    if (!cur && /^\s+$/.test(tok)) continue;
    const candidate = cur + tok;
    if (g.measureText(candidate.trimEnd()).width > maxW && cur) {
      if (NO_LINE_START.test(tok) && cur.length > 1) {
        lines.push(cur.slice(0, -1).trimEnd());
        cur = cur.slice(-1) + tok;
      } else {
        lines.push(cur.trimEnd());
        cur = /^\s+$/.test(tok) ? "" : tok;
      }
      if (lines.length === maxLines) {
        cur = "";
        break;
      }
    } else {
      cur = candidate;
    }
  }
  if (cur.trim() && lines.length < maxLines) lines.push(cur.trimEnd());

  const shownChars = lines.join("").replace(/\s/g, "").length;
  const totalChars = clean.replace(/\s/g, "").length;
  if (shownChars < totalChars - 1 && lines.length) {
    let tail = lines[lines.length - 1];
    while (tail.length > 1 && g.measureText(`${tail}……`).width > maxW) {
      tail = tail.slice(0, -1);
    }
    lines[lines.length - 1] = `${tail}……`;
  }
  return lines;
}

function clampSingleLine(g: CanvasRenderingContext2D, text: string, maxW: number): string {
  let out = text.trim();
  while (out.length > 2 && g.measureText(out).width > maxW) {
    out = `${out.slice(0, -2)}…`;
  }
  return out;
}

function drawCenteredYText(g: CanvasRenderingContext2D, text: string, x: number, cy: number): number {
  const m = g.measureText(text);
  const dy = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  g.fillText(text, x, cy + dy);
  return m.width;
}

function drawRoundedRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}

/** 渲染 1080 × ≥1350（4:5 起步）分享海报画布。 */
export async function renderQuotePoster(
  input: QuotePosterInput,
  logo?: HTMLImageElement | null,
  theme: QuotePosterTheme = QUOTE_POSTER_THEMES[0],
  font: QuotePosterFont = QUOTE_POSTER_FONTS[0],
): Promise<HTMLCanvasElement> {
  const layout = theme.layout;
  const W = 1080;
  const padX = layout === "bookmark" ? 130 : 100;
  const contentW = W - padX * 2;
  const centered = layout === "cinema" || layout === "bookmark";
  const fontStack = `${font.family}, ${font.sans ? SYS_SANS : SYS_SERIF}`;

  const zh = input.zh.trim();
  const en = input.en.trim() && input.en.trim() !== zh ? input.en.trim() : "";

  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d")!;

  const bodyChars = (zh || en).length;
  const baseZhSize = bodyChars > 160 ? 40 : bodyChars > 100 ? 46 : bodyChars > 50 ? 54 : 62;
  const zhSize = baseZhSize + (layout === "magazine" && bodyChars <= 50 ? 6 : 0);
  const zhFont = `${font.weight} ${zhSize}px ${fontStack}`;
  const zhLH = Math.round(zhSize * 1.68);
  g.font = zhFont;
  const zhLines = zh ? wrapLines(g, zh, contentW, 14) : [];

  const enSize = zh ? 28 : Math.max(30, zhSize - 6);
  const enFont = `italic ${enSize}px ${LATIN_SERIF}`;
  const enLH = Math.round(enSize * 1.55);
  g.font = enFont;
  const enLines = en ? wrapLines(g, en, contentW, zh ? 6 : 14) : [];

  const titleFont = `400 30px ${fontStack}`;
  g.font = titleFont;
  const titleLines = input.title ? wrapLines(g, input.title, contentW, 2) : [];

  const markGap =
    layout === "classic" ? 150 : layout === "timecode" ? 60 : layout === "cinema" ? 110 : 80;
  const quoteBlockH =
    markGap +
    zhLines.length * zhLH +
    (zhLines.length && enLines.length ? 40 : 0) +
    enLines.length * enLH;
  const sourceBlockH = 96 + 46 + titleLines.length * 46 + (input.meta ? 44 : 0);
  const bodyTotalH = quoteBlockH + sourceBlockH;

  const headH = layout === "magazine" ? 330 : layout === "bookmark" ? 240 : 200;
  const qrSize = 210;
  const footH = 120 + qrSize + 50 + padX;
  const H = Math.max(1350, headH + bodyTotalH + footH);

  canvas.width = W;
  canvas.height = H;
  g.textBaseline = "alphabetic";

  const alignX = (width: number) => (centered ? (W - width) / 2 : padX);
  const quoteStartY = headH + Math.max(0, (H - headH - footH - bodyTotalH) / 2) + markGap;

  // 1. 背景底色
  if (theme.bgEnd) {
    const grad = g.createLinearGradient(0, 0, W * 0.4, H);
    grad.addColorStop(0, theme.bg);
    grad.addColorStop(1, theme.bgEnd);
    g.fillStyle = grad;
  } else {
    g.fillStyle = theme.bg;
  }
  g.fillRect(0, 0, W, H);

  // 2. 各主题页眉与版式装饰（无竖向侧条）
  const showLabel = input.show.trim() || tNow("播客摘句");
  if (layout === "magazine") {
    g.fillStyle = theme.accent;
    g.fillRect(0, 0, W, 250);
    g.fillStyle = "#ffffff";
    g.font = `700 22px ${SYS_SANS}`;
    g.globalAlpha = 0.86;
    g.fillText(`SUBPODCAST  ·  ${tNow("播客摘句")}`, padX, 78);
    g.globalAlpha = 1;
    g.font = `700 64px ${LATIN_SERIF}`;
    g.fillText(clampSingleLine(g, showLabel, contentW), padX, 180);
  } else if (layout === "cinema") {
    g.fillStyle = "#000000";
    g.fillRect(0, 0, W, 64);
    g.fillRect(0, H - 64, W, 64);
    g.font = `600 24px ${SYS_SANS}`;
    g.fillStyle = theme.muted;
    const head = `${tNow("声译")} · Subpodcast  ·  ${clampSingleLine(g, showLabel, 540)}`;
    g.fillText(head, (W - g.measureText(head).width) / 2, 140);
  } else if (layout === "bookmark") {
    const m = 56;
    g.strokeStyle = theme.accent;
    g.lineWidth = 2;
    g.strokeRect(m, m, W - m * 2, H - m * 2);
    g.lineWidth = 6;
    const corner = 34;
    const corners: readonly [number, number, number, number][] = [
      [m, m, 1, 1],
      [W - m, m, -1, 1],
      [m, H - m, 1, -1],
      [W - m, H - m, -1, -1],
    ];
    for (const [cx, cy, dx, dy] of corners) {
      g.beginPath();
      g.moveTo(cx + dx * corner, cy);
      g.lineTo(cx, cy);
      g.lineTo(cx, cy + dy * corner);
      g.stroke();
    }
    g.font = `500 26px ${fontStack}`;
    g.fillStyle = theme.soft;
    const head = clampSingleLine(g, showLabel, contentW);
    g.fillText(head, (W - g.measureText(head).width) / 2, 170);
    g.fillStyle = theme.accent;
    g.fillRect(W / 2 - 20, 196, 40, 3);
  } else {
    if (layout === "timecode" && input.ts) {
      g.save();
      g.globalAlpha = 0.09;
      g.fillStyle = theme.accent;
      g.font = `700 300px ${SYS_SANS}`;
      const tw = g.measureText(input.ts).width;
      g.fillText(input.ts, W - padX - tw + 20, quoteStartY + 120);
      g.restore();
    }
    if (logo?.complete && logo.naturalWidth) {
      g.save();
      drawRoundedRect(g, padX, 84, 46, 46, 10);
      g.clip();
      g.drawImage(logo, padX, 84, 46, 46);
      g.restore();
    }
    g.fillStyle = theme.ink;
    g.font = `700 30px ${SYS_SANS}`;
    g.fillText(tNow("声译"), padX + (logo?.naturalWidth ? 60 : 0), 118);
    g.font = `500 24px ${fontStack}`;
    g.fillStyle = theme.soft;
    const rightShow = clampSingleLine(g, showLabel, contentW - 260);
    g.fillText(rightShow, W - padX - g.measureText(rightShow).width, 116);
    g.fillStyle = theme.rule;
    g.fillRect(padX, 158, contentW, 2);
  }

  // 3. 摘句引言标记
  if (layout === "classic") {
    g.fillStyle = theme.accent;
    g.font = `700 180px ${LATIN_SERIF}`;
    g.fillText("“", padX - 10, quoteStartY - 10);
  } else if (layout === "magazine") {
    g.fillStyle = theme.accent;
    g.fillRect(padX, quoteStartY - 44, 80, 8);
  } else if (layout === "cinema" && input.ts) {
    g.font = `600 30px ${SYS_SANS}`;
    g.fillStyle = theme.accent;
    const tw = g.measureText(input.ts).width;
    g.fillText(input.ts, (W - tw) / 2, quoteStartY - 40);
  } else if (layout === "bookmark") {
    g.fillStyle = theme.accent;
    g.font = `700 90px ${LATIN_SERIF}`;
    const qw = g.measureText("“").width;
    g.fillText("“", (W - qw) / 2, quoteStartY - 4);
  } else if (layout === "timecode") {
    g.fillStyle = theme.accent;
    g.font = `700 26px ${SYS_SANS}`;
    g.fillText(input.ts ? `▶ ${input.ts}` : "▶", padX, quoteStartY - 24);
  }

  // 4. 摘句正文（中文在上，英文斜体衬线在下）
  let y = quoteStartY;
  g.fillStyle = theme.ink;
  g.font = zhFont;
  for (const ln of zhLines) {
    y += zhLH;
    g.fillText(ln, alignX(g.measureText(ln).width), y - zhLH * 0.28);
  }
  if (zhLines.length && enLines.length) y += 40;
  g.fillStyle = zh ? theme.muted : theme.ink;
  g.font = enFont;
  for (const ln of enLines) {
    y += enLH;
    g.fillText(ln, alignX(g.measureText(ln).width), y - enLH * 0.25);
  }

  // 5. 节目出处（水平短横饰 + 节目名 + 中文单集标题 + 日期与时间点）
  y += 96;
  const sourceShow = input.show.trim() || tNow("播客");
  g.font = `700 32px ${fontStack}`;
  const showW = g.measureText(sourceShow).width;
  const dashW = centered ? 0 : 40;
  const dashGap = centered ? 0 : 20;
  const sx = centered ? (W - showW) / 2 : padX;
  if (!centered) {
    g.fillStyle = theme.accent;
    g.fillRect(sx, y - 2, dashW, 4);
  }
  g.fillStyle = theme.ink;
  drawCenteredYText(g, sourceShow, sx + dashW + dashGap, y);

  y += 58;
  g.fillStyle = theme.soft;
  g.font = titleFont;
  for (const ln of titleLines) {
    g.fillText(ln, alignX(g.measureText(ln).width), y);
    y += 46;
  }
  if (input.meta) {
    g.font = `400 24px ${SYS_SANS}`;
    g.fillStyle = theme.muted;
    g.fillText(input.meta, alignX(g.measureText(input.meta).width), y + 4);
  }

  // 6. 底栏：左品牌与 Slogan，右扫码收听二维码
  const footY = H - padX - qrSize - (layout === "cinema" ? 30 : 0);
  if (layout !== "bookmark") {
    g.fillStyle = theme.rule;
    g.fillRect(padX, footY - 44, contentW, 2);
  }
  g.fillStyle = theme.ink;
  g.font = `700 36px ${SYS_SANS}`;
  g.fillText(`${tNow("声译")} · Subpodcast`, padX, footY + 52);
  g.font = `400 25px ${SYS_SANS}`;
  g.fillStyle = theme.soft;
  g.fillText(tNow("海外好播客 · 中文字幕 · 精读与 AI 问答"), padX, footY + 100);

  if (input.url) {
    g.fillStyle = theme.accent;
    g.font = `600 25px ${SYS_SANS}`;
    g.fillText(tNow("扫码收听原节目这一段 →"), padX, footY + 158);
    try {
      const { default: qrcode } = await import("qrcode-generator");
      const qr = qrcode(0, "M");
      qr.addData(input.url);
      qr.make();
      const count = qr.getModuleCount();
      const inset = 12;
      const cell = (qrSize - inset * 2) / count;
      const qx = W - padX - qrSize;
      const qy = footY;
      g.fillStyle = "#ffffff";
      drawRoundedRect(g, qx, qy, qrSize, qrSize, 16);
      g.fill();
      g.fillStyle = "#16171a";
      for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
          if (qr.isDark(r, c)) {
            g.fillRect(qx + inset + c * cell, qy + inset + r * cell, Math.ceil(cell), Math.ceil(cell));
          }
        }
      }
    } catch {
      /* 忽略二维码异常，保留文字底栏 */
    }
  }

  return canvas;
}
