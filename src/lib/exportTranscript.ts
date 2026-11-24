/**
 * [INPUT]: Episode / Segment、导出内容模式、可选译文；api.saveDownload；clock / date
 * [OUTPUT]: FORMATS / buildCues / renderTranscript / exportTranscriptFileName / runTranscriptExport
 * [POS]: 字幕导出（SRT / WebVTT / ASS / LRC / TXT / Markdown）；落盘走 Rust「下载」目录
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { api, type Episode, type Segment } from "./api";
import { clock, date } from "./format";
import { tNow } from "./i18n";

export type ExportMode = "bilingual" | "translation" | "original";
export type ExportFormat = "srt" | "vtt" | "ass" | "lrc" | "txt" | "md";

export const FORMATS: { id: ExportFormat; name: string; ext: string }[] = [
  { id: "srt", name: "SRT", ext: "srt" },
  { id: "vtt", name: "WebVTT", ext: "vtt" },
  { id: "ass", name: "ASS", ext: "ass" },
  { id: "lrc", name: "LRC", ext: "lrc" },
  { id: "txt", name: "TXT", ext: "txt" },
  { id: "md", name: "Markdown", ext: "md" },
];

export type Cue = {
  start: number;
  end: number;
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
  const ext = FORMATS.find((f) => f.id === format)?.ext ?? format;
  return `${safeStem(title)}.${ext}`;
}

/** 按内容模式组装逐句 cue；缺译文时退回原文。 */
export function buildCues(
  segments: Segment[],
  translations: (string | null | undefined)[] | undefined,
  mode: ExportMode,
  foreign: boolean,
): Cue[] {
  return segments.map((s, i) => {
    const zh = translations?.[i]?.trim() || undefined;
    const orig = s.text.trim();
    const end = Math.max(s.start + 0.2, s.end || s.start + 2);
    if (!foreign || mode === "original") {
      return { start: s.start, end, original: orig || undefined };
    }
    if (mode === "translation") {
      return { start: s.start, end, translation: zh || orig || undefined };
    }
    return { start: s.start, end, translation: zh, original: orig || undefined };
  });
}

function cueLines(c: Cue): string[] {
  return [c.translation, c.original].filter((x): x is string => !!x);
}

function stamp(t: number, sep: "," | ".", hours = true): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const f = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${hours ? `${p(h)}:` : ""}${p(m)}:${p(s)}${sep}${p(f, 3)}`;
}

function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor(cs / 6000) % 60;
  const s = Math.floor(cs / 100) % 60;
  const f = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(f).padStart(2, "0")}`;
}

function assText(s: string): string {
  return s.replace(/[{}]/g, "").replace(/\r?\n/g, "\\N");
}

function lrcStamp(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const m = Math.floor(cs / 6000);
  const s = Math.floor(cs / 100) % 60;
  const f = cs % 100;
  return `[${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(f).padStart(2, "0")}]`;
}

function youtubeStamp(videoId: string | null | undefined, start: number): string {
  const t = Math.max(0, Math.floor(start));
  if (!videoId) return clock(start);
  return `[${clock(start)}](https://www.youtube.com/watch?v=${videoId}&t=${t}s)`;
}

export function renderTranscript(input: {
  format: ExportFormat;
  episode: Episode;
  cues: Cue[];
  sourceLabel?: string;
}): string {
  const { format, episode: ep, cues, sourceLabel } = input;
  const meta = { title: ep.title, show: ep.showTitle };

  switch (format) {
    case "srt":
      return cues
        .filter((c) => cueLines(c).length)
        .map((c, i) => `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${cueLines(c).join("\n")}\n`)
        .join("\n");
    case "vtt":
      return `WEBVTT\n\n${cues
        .filter((c) => cueLines(c).length)
        .map(
          (c) =>
            `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${cueLines(c)
              .map((l) => l.replace(/-->/g, "→"))
              .join("\n")}\n`,
        )
        .join("\n")}`;
    case "ass": {
      const head = [
        "[Script Info]",
        `Title: ${assText(meta.title)}`,
        "ScriptType: v4.00+",
        "PlayResX: 1920",
        "PlayResY: 1080",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Default,PingFang SC,60,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,3,1,2,80,80,60,1",
        "Style: Original,Arial,42,&H00E6E6E6,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2.5,1,2,80,80,60,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      ];
      const events = cues
        .filter((c) => cueLines(c).length)
        .map((c) => {
          const text =
            c.translation && c.original
              ? `${assText(c.translation)}\\N{\\rOriginal}${assText(c.original)}`
              : assText(c.translation ?? c.original ?? "");
          const style = c.translation ? "Default" : "Original";
          return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},${style},,0,0,0,,${text}`;
        });
      return `${[...head, ...events].join("\n")}\n`;
    }
    case "lrc": {
      const head = [`[ti:${meta.title}]`, ...(meta.show ? [`[ar:${meta.show}]`] : []), "[by:Subpodcast]"];
      const body = cues.flatMap((c) => cueLines(c).map((l) => `${lrcStamp(c.start)}${l}`));
      return `${[...head, ...body].join("\n")}\n`;
    }
    case "txt":
      return `${cues
        .filter((c) => cueLines(c).length)
        .map((c) => `[${clock(c.start)}] ${cueLines(c).join("\n")}`)
        .join("\n\n")}\n`;
    case "md": {
      const out: string[] = [`# ${ep.title}`, ""];
      if (ep.showTitle) out.push(`${tNow("节目")}：${ep.showTitle}`);
      if (ep.published) out.push(`${tNow("日期")}：${date(ep.published)}`);
      if (sourceLabel) out.push(`${tNow("字幕")}：${sourceLabel}`);
      if (ep.showTitle || ep.published || sourceLabel) out.push("");
      out.push("---", "");
      for (const c of cues) {
        const lines = cueLines(c);
        if (!lines.length) continue;
        const stampMd = youtubeStamp(ep.videoId, c.start);
        if (lines.length === 2) {
          out.push(`**${stampMd}**  ${lines[0]}`, "", lines[1], "");
        } else {
          out.push(`**${stampMd}**  ${lines[0]}`, "");
        }
      }
      return `${out.join("\n").trimEnd()}\n`;
    }
  }
}

/** 导出到系统「下载」，返回完整路径。 */
export async function runTranscriptExport(input: {
  format: ExportFormat;
  episode: Episode;
  segments: Segment[];
  translations?: (string | null | undefined)[];
  mode: ExportMode;
  foreign: boolean;
  sourceLabel?: string;
}): Promise<string> {
  const cues = buildCues(input.segments, input.translations, input.mode, input.foreign);
  const body = renderTranscript({
    format: input.format,
    episode: input.episode,
    cues,
    sourceLabel: input.sourceLabel,
  });
  const name = exportTranscriptFileName(input.episode.title, input.format);
  return api.saveDownload(name, body, false);
}
