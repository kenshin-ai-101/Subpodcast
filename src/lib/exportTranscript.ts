/**
 * [INPUT]: Episode / Segment、当前字幕显示模式、可选译文；api.saveDownload；clock / date
 * [OUTPUT]: transcriptMarkdown / transcriptPdf / exportTranscriptFileName / runTranscriptExport
 * [POS]: 字幕导出（MD / PDF）；落盘走 Rust「下载」目录，与 OPML 同范式
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { api, type Episode, type Segment } from "./api";
import { clock, date } from "./format";

export type ExportMode = "bilingual" | "translation" | "original";
export type ExportFormat = "md" | "pdf";

type Line = {
  start: number;
  original?: string;
  translation?: string;
};

function safeStem(title: string): string {
  const t = title
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return t || "字幕";
}

export function exportTranscriptFileName(title: string, format: ExportFormat): string {
  return `${safeStem(title)}.${format}`;
}

function buildLines(
  segments: Segment[],
  translations: (string | null)[] | undefined,
  mode: ExportMode,
  foreign: boolean,
): Line[] {
  return segments.map((s, i) => {
    const zh = translations?.[i]?.trim() || undefined;
    const orig = s.text.trim();
    if (!foreign || mode === "original") {
      return { start: s.start, original: orig || undefined };
    }
    if (mode === "translation") {
      return { start: s.start, translation: zh || orig || undefined };
    }
    return { start: s.start, translation: zh, original: orig || undefined };
  });
}

function youtubeStamp(videoId: string | null | undefined, start: number): string {
  const t = Math.max(0, Math.floor(start));
  if (!videoId) return clock(start);
  return `[${clock(start)}](https://www.youtube.com/watch?v=${videoId}&t=${t}s)`;
}

/** 按当前显示模式组装 Markdown；有 videoId 时时间戳链到 YouTube。 */
export function transcriptMarkdown(input: {
  episode: Episode;
  segments: Segment[];
  translations?: (string | null)[];
  mode: ExportMode;
  foreign: boolean;
  sourceLabel?: string;
}): string {
  const { episode: ep, segments, translations, mode, foreign, sourceLabel } = input;
  const lines = buildLines(segments, translations, mode, foreign);
  const out: string[] = [`# ${ep.title}`, ""];
  if (ep.showTitle) out.push(`节目：${ep.showTitle}`);
  if (ep.published) out.push(`日期：${date(ep.published)}`);
  if (sourceLabel) out.push(`字幕：${sourceLabel}`);
  if (ep.showTitle || ep.published || sourceLabel) out.push("");
  out.push("---", "");

  for (const line of lines) {
    const stamp = youtubeStamp(ep.videoId, line.start);
    if (line.translation && line.original && line.translation !== line.original) {
      out.push(`**${stamp}**  ${line.translation}`, "", line.original, "");
    } else {
      const text = line.translation || line.original || "";
      if (!text) continue;
      out.push(`**${stamp}**  ${text}`, "");
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (!text) return [];
  const out: string[] = [];
  let row = "";
  for (const ch of text) {
    const next = row + ch;
    if (ctx.measureText(next).width > maxWidth && row) {
      out.push(row);
      row = ch;
    } else {
      row = next;
    }
  }
  if (row) out.push(row);
  return out;
}

async function canvasToJpeg(canvas: HTMLCanvasElement, quality = 0.86): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("无法生成 PDF 页面"))), "image/jpeg", quality);
  });
  return new Uint8Array(await blob.arrayBuffer());
}

/** 把 JPEG 页拼成简易 PDF（每页一张图）。 */
function buildJpegPdf(
  pages: Uint8Array[],
  pageW: number,
  pageH: number,
  imgW: number,
  imgH: number,
): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsetOf: number[] = [0];
  let size = 0;

  const append = (data: Uint8Array | string) => {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    chunks.push(bytes);
    size += bytes.length;
  };
  const beginObj = (id: number) => {
    offsetOf[id] = size;
    append(`${id} 0 obj\n`);
  };
  const endObj = () => append("\nendobj\n");

  append("%PDF-1.4\n");

  const pageIds: number[] = [];
  let id = 3;
  for (const jpeg of pages) {
    const imgId = id++;
    const contentId = id++;
    const pageId = id++;
    pageIds.push(pageId);

    beginObj(imgId);
    append(
      `<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    );
    append(jpeg);
    append("\nendstream");
    endObj();

    const content = `q ${pageW.toFixed(2)} 0 0 ${pageH.toFixed(2)} 0 0 cm /Im0 Do Q`;
    beginObj(contentId);
    append(`<< /Length ${enc.encode(content).length} >>\nstream\n${content}\nendstream`);
    endObj();

    beginObj(pageId);
    append(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)}] /Contents ${contentId} 0 R /Resources << /XObject << /Im0 ${imgId} 0 R >> >> >>`,
    );
    endObj();
  }

  beginObj(2);
  append(`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((n) => `${n} 0 R`).join(" ")}] >>`);
  endObj();

  beginObj(1);
  append("<< /Type /Catalog /Pages 2 0 R >>");
  endObj();

  const xrefAt = size;
  const maxId = id - 1;
  append(`xref\n0 ${maxId + 1}\n`);
  append("0000000000 65535 f \n");
  for (let i = 1; i <= maxId; i++) {
    append(`${String(offsetOf[i] ?? 0).padStart(10, "0")} 00000 n \n`);
  }
  append(`trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`);

  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function lineRows(
  ctx: CanvasRenderingContext2D,
  line: Line,
  mode: ExportMode,
  maxText: number,
): { top: string[]; bottom: string[] } {
  if (line.translation && line.original && line.translation !== line.original && mode === "bilingual") {
    return {
      top: wrapText(ctx, line.translation, maxText),
      bottom: wrapText(ctx, line.original, maxText),
    };
  }
  const text = (mode === "original" ? line.original : line.translation || line.original) || "";
  return { top: wrapText(ctx, text, maxText), bottom: [] };
}

/** 用系统字体画布分页，避免嵌入 CJK 字库。 */
export async function transcriptPdf(input: {
  episode: Episode;
  segments: Segment[];
  translations?: (string | null)[];
  mode: ExportMode;
  foreign: boolean;
  sourceLabel?: string;
}): Promise<Uint8Array> {
  const { episode: ep, segments, translations, mode, foreign, sourceLabel } = input;
  const lines = buildLines(segments, translations, mode, foreign);

  const scale = 2;
  const pageW = 595.28;
  const pageH = 841.89;
  const cssW = pageW * scale;
  const cssH = pageH * scale;
  const margin = 48 * scale;
  const maxText = cssW - margin * 2 - 64 * scale;
  const timeX = margin;
  const textX = margin + 64 * scale;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(cssW);
  canvas.height = Math.round(cssH);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法绘制 PDF");

  const fontBody = `${15 * scale}px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif`;
  const fontTime = `${12 * scale}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const fontTitle = `600 ${20 * scale}px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif`;
  const fontMeta = `${12 * scale}px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif`;
  const lineGap = 6 * scale;
  const blockGap = 14 * scale;
  const rowZh = 22 * scale;
  const rowOrig = 20 * scale;

  const pages: Uint8Array[] = [];
  let y = 0;

  const fillPage = () => {
    ctx.fillStyle = "#f7f3eb";
    ctx.fillRect(0, 0, cssW, cssH);
  };

  const flush = async () => {
    pages.push(await canvasToJpeg(canvas));
    fillPage();
    y = margin;
  };

  fillPage();
  y = margin;

  ctx.fillStyle = "#1c1917";
  ctx.font = fontTitle;
  for (const row of wrapText(ctx, ep.title, cssW - margin * 2)) {
    ctx.fillText(row, margin, y + 20 * scale);
    y += 26 * scale;
  }
  y += 8 * scale;
  ctx.fillStyle = "#78716c";
  ctx.font = fontMeta;
  for (const m of [
    ep.showTitle ? `节目：${ep.showTitle}` : "",
    ep.published ? `日期：${date(ep.published)}` : "",
    sourceLabel ? `字幕：${sourceLabel}` : "",
  ].filter(Boolean)) {
    ctx.fillText(m, margin, y + 12 * scale);
    y += 18 * scale;
  }
  y += 16 * scale;
  ctx.strokeStyle = "#e7e0d5";
  ctx.beginPath();
  ctx.moveTo(margin, y);
  ctx.lineTo(cssW - margin, y);
  ctx.stroke();
  y += 24 * scale;

  ctx.font = fontBody;
  for (const line of lines) {
    const { top, bottom } = lineRows(ctx, line, mode, maxText);
    if (!top.length && !bottom.length) continue;
    const blockH =
      Math.max(1, top.length) * rowZh + bottom.length * rowOrig + (bottom.length ? lineGap : 0) + blockGap;
    if (y + blockH > cssH - margin) await flush();

    ctx.fillStyle = "#a8a29e";
    ctx.font = fontTime;
    ctx.fillText(clock(line.start), timeX, y + 14 * scale);

    ctx.font = fontBody;
    ctx.fillStyle = "#1c1917";
    let ty = y;
    for (const row of top) {
      ctx.fillText(row, textX, ty + 14 * scale);
      ty += rowZh;
    }
    if (bottom.length) {
      ty += lineGap;
      ctx.fillStyle = "#57534e";
      for (const row of bottom) {
        ctx.fillText(row, textX, ty + 13 * scale);
        ty += rowOrig;
      }
    }
    y = ty + blockGap;
  }

  await flush();
  return buildJpegPdf(pages, pageW, pageH, canvas.width, canvas.height);
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 导出到系统「下载」，返回完整路径。 */
export async function runTranscriptExport(input: {
  format: ExportFormat;
  episode: Episode;
  segments: Segment[];
  translations?: (string | null)[];
  mode: ExportMode;
  foreign: boolean;
  sourceLabel?: string;
}): Promise<string> {
  const name = exportTranscriptFileName(input.episode.title, input.format);
  if (input.format === "md") {
    return api.saveDownload(name, transcriptMarkdown(input), false);
  }
  const pdf = await transcriptPdf(input);
  return api.saveDownload(name, bytesToBase64(pdf), true);
}
