/**
 * [INPUT]: Episode / Segment、可选译文、foreign；exportTranscript；LearnModal；Seg；store.notify
 * [OUTPUT]: SubtitleExport 弹窗（选格式 / 内容 / 预览 / 落盘）
 * [POS]: 右栏字幕导出入口（中文栏按钮 / 英文「…」菜单）共用的格式选择器
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useMemo, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { errText, type Episode, type Segment } from "../lib/api";
import {
  buildCues,
  FORMATS,
  renderTranscript,
  runTranscriptExport,
  type ExportFormat,
  type ExportMode,
} from "../lib/exportTranscript";
import { useStore } from "../store";
import { LearnModal } from "./LearnModal";
import { Seg } from "./ReadingSettings";

const LAST_KEY = "subpodcast.export";

function remembered(): { format: ExportFormat; content?: ExportMode } {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null") as {
      format?: ExportFormat;
      content?: ExportMode;
    } | null;
    if (v && FORMATS.some((f) => f.id === v.format)) return { format: v.format!, content: v.content };
  } catch {
    /* ignore */
  }
  return { format: "srt" };
}

export function SubtitleExport({
  episode,
  segments,
  translations,
  foreign,
  mode,
  sourceLabel,
  onClose,
}: {
  episode: Episode;
  segments: Segment[];
  translations?: (string | null | undefined)[];
  foreign: boolean;
  mode: ExportMode;
  sourceLabel?: string;
  onClose: () => void;
}) {
  const notify = useStore((s) => s.notify);
  const translated = translations ? segments.filter((_, i) => !!translations[i]?.trim()).length : 0;
  const last = useMemo(remembered, []);
  const [format, setFormat] = useState<ExportFormat>(last.format);
  const [content, setContent] = useState<ExportMode>(
    foreign && translated ? (last.content ?? mode) : "original",
  );
  const [busy, setBusy] = useState(false);

  const cues = useMemo(
    () => buildCues(segments, translations, content, foreign),
    [segments, translations, content, foreign],
  );

  const preview = useMemo(() => {
    const sample = cues.slice(0, 4);
    const full = renderTranscript({
      format,
      episode,
      cues: sample,
      sourceLabel,
    });
    const body = format === "ass" ? full.slice(Math.max(0, full.indexOf("[Events]"))) : full;
    const lines = body.split("\n");
    return `${lines.slice(0, 14).join("\n")}${lines.length > 14 ? "\n…" : ""}`;
  }, [format, cues, episode, sourceLabel]);

  const missing = foreign && content !== "original" ? segments.length - translated : 0;

  const save = async () => {
    setBusy(true);
    try {
      const path = await runTranscriptExport({
        format,
        episode,
        segments,
        translations,
        mode: content,
        foreign,
        sourceLabel,
      });
      try {
        localStorage.setItem(LAST_KEY, JSON.stringify({ format, content }));
      } catch {
        /* ignore */
      }
      notify(`已导出到「下载」：${path.split(/[\\/]/).pop() ?? ""}`);
      void revealItemInDir(path).catch(() => {});
      onClose();
    } catch (e) {
      notify(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <LearnModal
      title="导出字幕"
      onClose={onClose}
      foot={
        <>
          <button type="button" className="btn ghost sm" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn primary sm" disabled={busy || !segments.length} onClick={() => void save()}>
            {busy ? "导出中…" : "导出…"}
          </button>
        </>
      }
    >
      <div className="sub-export">
        <div className="reading-row">
          <span>格式</span>
          <Seg value={format} options={FORMATS.map((f) => [f.id, f.name])} onChange={setFormat} />
        </div>
        {foreign && (
          <div className="reading-row">
            <span>内容</span>
            <Seg
              value={content}
              options={
                translated
                  ? [
                      ["bilingual", "双语"],
                      ["translation", "中文"],
                      ["original", "原文"],
                    ]
                  : [["original", "原文"]]
              }
              onChange={setContent}
            />
          </div>
        )}
        {missing > 0 && (
          <p className="muted small">还有 {missing} 句没有翻译，这些句子只导出原文。</p>
        )}
        {(format === "txt" || format === "md") && (
          <p className="muted small">文字稿按段落导出，每段带开始时间。</p>
        )}
        <pre className="sub-export-preview" aria-label="预览">
          {preview}
        </pre>
      </div>
    </LearnModal>
  );
}
