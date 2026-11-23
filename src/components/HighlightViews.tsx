/**
 * [INPUT]: highlights store/API；VideoClipDialog.openVideoClipDialog；store.notify/settings
 * [OUTPUT]: HighlightsPanel、SeekHighlights、useClipWarm
 * [POS]: 字幕 Tab「高光」列表与分窗进度；试看/剪视频/文案/蒙太奇入口
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  Scissors,
  Sparkles,
  Square,
} from "lucide-react";
import { api, errText, type Episode, type Segment } from "../lib/api";
import { clock } from "../lib/format";
import { writeClipboardText } from "../lib/clipboard";
import {
  buildPlatformPost,
  clearHighlightsError,
  loadHighlights,
  montageClip,
  polishClipCopy,
  previewEpisodeRange,
  runHighlights,
  saveClipCopy,
  stopHighlights,
  useHighlights,
  type HighlightClip,
} from "../lib/highlights";
import { useStore } from "../store";
import { openVideoClipDialog } from "./VideoClipDialog";

const INTENT_SUGGESTIONS = ["犀利观点与金句", "实战方法与具体案例", "争议判断与行业趋势"];

/** 预热 YouTube 切片下载地址与 top2 时间窗。 */
export function useClipWarm(ep: Episode, segments: Segment[]) {
  const bundle = useHighlights((s) => s.bundles[ep.id]);
  const topRanges = useMemo(
    () =>
      [...(bundle?.clips ?? [])]
        .sort((a, b) => b.score - a.score)
        .slice(0, 2)
        .map(
          (c) =>
            [
              Math.max(0, (segments[c.startIdx]?.start ?? c.start) - 0.25),
              (segments[c.endIdx]?.end ?? c.end) + 0.4,
            ] as [number, number],
        ),
    [bundle, segments],
  );
  const key = topRanges.map((r) => r.join("-")).join("|");
  useEffect(() => {
    if (ep.videoId && bundle?.clips.length) {
      void api.videoClipWarm(ep.videoId, topRanges).catch(() => {});
    }
  }, [ep.videoId, key]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function HighlightsPanel({
  ep,
  segments,
  zh,
  onJumpToTranscript,
}: {
  ep: Episode;
  segments: Segment[];
  zh?: (string | null | undefined)[];
  onJumpToTranscript: (index: number, time: number) => void;
}) {
  const bundle = useHighlights((s) => s.bundles[ep.id]);
  const loading = useHighlights((s) => !!s.loading[ep.id]);
  const progress = useHighlights((s) => s.progress[ep.id]);
  const error = useHighlights((s) => s.error[ep.id]);
  const needsSetup = useHighlights((s) => !!s.needsSetup[ep.id]);
  const notify = useStore((s) => s.notify);
  const set = useStore((s) => s.set);

  const [intent, setIntent] = useState(bundle?.intent ?? "");
  const [sortBy, setSortBy] = useState<"score" | "time">("score");
  const [reasking, setReasking] = useState(false);
  const [copying, setCopying] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    void loadHighlights(ep.id);
  }, [ep.id]);
  useClipWarm(ep, segments);

  const clips = useMemo(() => {
    const list = bundle?.clips ?? [];
    if (sortBy === "time") return [...list].sort((a, b) => a.start - b.start);
    return [...list].sort((a, b) => b.score - a.score || a.start - b.start);
  }, [bundle, sortBy]);

  const startRun = (customIntent?: string) => {
    clearHighlightsError(ep.id);
    setReasking(false);
    void runHighlights(ep, segments, zh, customIntent ?? intent);
  };

  const copyShare = async (c: HighlightClip) => {
    if (copying) return;
    try {
      let share = c.articleCopy ? c.shareCopy : "";
      if (!share) {
        setCopying(c.id);
        const res = await polishClipCopy({
          ep,
          segments,
          zh,
          startIdx: c.startIdx,
          endIdx: c.endIdx,
        });
        share = res.shareCopy;
        void saveClipCopy(ep.id, c.id, { shareCopy: res.shareCopy, articleCopy: res.articleCopy });
      }
      // 首次会先 await 生成文案，WebView Clipboard API 会丢手势；走本机兜底。
      await writeClipboardText(
        buildPlatformPost("short", {
          ep,
          title: c.title,
          coverHook: c.coverHook,
          coverSub: c.coverSub,
          shareCopy: share,
          tags: c.tags,
          segments,
          zh,
          startIdx: c.startIdx,
          endIdx: c.endIdx,
          clipStart: c.start,
        }),
      );
      notify("传播文案已复制");
    } catch (e) {
      notify(errText(e));
    } finally {
      setCopying(null);
    }
  };

  const togglePick = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const openMontage = (ids: string[]) => {
    const chosen = (bundle?.clips ?? []).filter((c) => ids.includes(c.id));
    if (chosen.length < 2) return;
    setPicking(false);
    setPicked([]);
    openVideoClipDialog({ ep, segments, zh, clip: montageClip(chosen) });
  };

  const bestOf = () => {
    const ranked = [...(bundle?.clips ?? [])].sort((a, b) => b.score - a.score);
    const out: HighlightClip[] = [];
    let total = 0;
    for (const c of ranked) {
      if (out.length >= 5 || (out.length >= 2 && total + (c.end - c.start) > 200)) break;
      out.push(c);
      total += c.end - c.start;
    }
    openMontage(out.map((c) => c.id));
  };

  if (loading) {
    const done = progress?.done ?? 0;
    const total = Math.max(1, progress?.total ?? 1);
    const pct = Math.round((done / total) * 100);
    return (
      <div className="hl-empty">
        <div className="hl-card-intro">
          <Sparkles size={20} className="hl-spark" />
          <p className="es-title">正在从整期文稿挑选高光片段</p>
          <p className="muted small">
            {done >= total
              ? "正在整理结果…"
              : `分窗扫描 ${done}/${total}（约 1–3 分钟；慢思考模型会更久）`}
          </p>
          <div className="hl-progress">
            <div className="bar">
              <div style={{ width: `${pct}%` }} />
            </div>
            <span className="muted small">{pct}%</span>
          </div>
          <div className="hl-wait-row">
            <Loader2 size={14} className="spin" />
            <button type="button" className="btn ghost sm" onClick={() => stopHighlights(ep.id)}>
              <Square size={12} fill="currentColor" /> 停止
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!bundle?.clips.length) {
    return (
      <div className="hl-empty">
        <div className="hl-card-intro">
          <Sparkles size={20} className="hl-spark" />
          <p className="es-title">自动挑选高光金句片段</p>
          <p className="muted small">
            从整期中抽取 30–120 秒独立成篇的高传播段落，支持一键剪出带双语字幕的视频切片。
          </p>
          <div className="hl-intent-box">
            <input
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              placeholder="可选：想重点找哪类话题，例如「创业踩坑」"
              onKeyDown={(e) => {
                if (e.key === "Enter") startRun();
              }}
            />
            <div className="hl-chips">
              {INTENT_SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`hl-chip ${intent === s ? "on" : ""}`}
                  onClick={() => setIntent(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          {error && <p className="error-text">{error}</p>}
          <div className="row-actions center">
            {needsSetup && (
              <button
                type="button"
                className="btn"
                onClick={() => set({ settingsOpen: true, settingsSection: "ai" })}
              >
                去设置
              </button>
            )}
            <button
              type="button"
              className="btn primary"
              disabled={!segments.length}
              onClick={() => startRun()}
            >
              <Sparkles size={14} /> 提取高光片段
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="hl-panel">
      <div className="hl-toolbar">
        <span className="muted small">
          共 {clips.length} 段高光{bundle.intent ? ` · ${bundle.intent}` : ""}
        </span>
        <span className="spacer" />
        {ep.videoId && clips.length > 1 && !picking && (
          <>
            <button
              type="button"
              className="link-btn"
              onClick={bestOf}
              title="把评分最高的几段按时间顺序剪成一条"
            >
              <Sparkles size={12} /> 精华合集
            </button>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setPicking(true);
                setPicked([]);
              }}
            >
              <Layers size={12} /> 自选拼接
            </button>
          </>
        )}
        <button
          type="button"
          className="link-btn"
          onClick={() => setSortBy(sortBy === "score" ? "time" : "score")}
        >
          {sortBy === "score" ? "按时间顺序" : "按传播度"}
        </button>
        <button type="button" className="link-btn" onClick={() => setReasking(!reasking)}>
          <RefreshCw size={12} /> 换方向重选
        </button>
      </div>

      {reasking && (
        <div className="hl-reask">
          <input
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder="输入想找的话题方向（留空则全面挑选）"
            onKeyDown={(e) => {
              if (e.key === "Enter") startRun();
            }}
          />
          <button type="button" className="btn primary sm" onClick={() => startRun()}>
            重新提取
          </button>
        </div>
      )}

      {picking && (
        <div className="hl-pickbar">
          <span className="small">
            {picked.length
              ? `已选 ${picked.length} 段，会按时间顺序拼成一条`
              : "勾选要拼在一起的片段"}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              setPicking(false);
              setPicked([]);
            }}
          >
            取消
          </button>
          <button
            type="button"
            className="btn primary sm"
            disabled={picked.length < 2}
            onClick={() => openMontage(picked)}
          >
            <Scissors size={12} /> 拼成视频
          </button>
        </div>
      )}

      {error && <p className="error-text hl-err">{error}</p>}

      <div className="hl-list">
        {clips.map((c) => {
          const previewZh = zh?.[c.startIdx]?.trim();
          const previewOrig = segments[c.startIdx]?.text ?? "";
          const durSec = Math.max(1, Math.round(c.end - c.start));
          return (
            <article
              key={c.id}
              className={`hl-card${picking ? " picking" : ""}${picked.includes(c.id) ? " picked" : ""}`}
              onClick={picking ? () => togglePick(c.id) : undefined}
            >
              <div className="hl-card-top">
                {picking && (
                  <span className={`hl-check${picked.includes(c.id) ? " on" : ""}`}>
                    {picked.includes(c.id) && <Check size={12} strokeWidth={3} />}
                  </span>
                )}
                <span className="hl-score" title="传播潜力评分">
                  ✦ {c.score}
                </span>
                <span className="num small muted">
                  {clock(c.start)} – {clock(c.end)} · {durSec}s
                </span>
              </div>
              <h4 className="hl-title">
                <button
                  type="button"
                  className="hl-title-btn"
                  title="在字幕里找到这一段"
                  onClick={(e) => {
                    if (picking) return;
                    e.stopPropagation();
                    onJumpToTranscript(c.startIdx, c.start);
                  }}
                >
                  {c.title}
                </button>
              </h4>
              {c.reason && <p className="hl-reason">{c.reason}</p>}
              <div className="hl-quote">
                {previewZh && <p className="hl-qzh clamp2">{previewZh}</p>}
                {previewOrig && <p className="hl-qorig clamp2">{previewOrig}</p>}
              </div>
              {c.tags.length > 0 && (
                <div className="hl-tags">
                  {c.tags.map((tag) => (
                    <span key={tag} className="hl-tag">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              {!picking && (
                <div className="hl-actions">
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => previewEpisodeRange(ep, c.start, c.end)}
                  >
                    <Play size={12} fill="currentColor" /> 试看
                  </button>
                  {ep.videoId && (
                    <button
                      type="button"
                      className={`btn sm ${c.exportPath ? "ghost" : "primary"}`}
                      onClick={() => openVideoClipDialog({ ep, segments, zh, clip: c })}
                      title={c.exportPath ? "已导出：打开工作室可在文件夹中查看，或重新剪辑" : "剪成带字幕的短视频"}
                    >
                      <Scissors size={12} /> {c.exportPath ? "已导出" : "剪成视频"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={copying === c.id}
                    onClick={() => void copyShare(c)}
                    title="复制 AI 写的发布文案"
                  >
                    {copying === c.id ? <Loader2 size={12} className="spin" /> : <Copy size={12} />}{" "}
                    复制文案
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

/** 进度条上的高光区间标记。 */
export function SeekHighlights({
  episodeId,
  length,
  onSeek,
}: {
  episodeId?: string;
  length: number;
  onSeek: (seconds: number) => void;
}) {
  const clips = useHighlights((s) => (episodeId ? s.bundles[episodeId]?.clips : undefined));
  useEffect(() => {
    if (episodeId) void loadHighlights(episodeId);
  }, [episodeId]);

  if (!clips?.length || length <= 0) return null;
  return (
    <div className="seek-marks" aria-hidden>
      {clips.map((c) => {
        const left = Math.max(0, Math.min(100, (c.start / length) * 100));
        const width = Math.max(0.4, Math.min(100 - left, ((c.end - c.start) / length) * 100));
        return (
          <button
            key={c.id}
            type="button"
            className="seek-mark"
            style={{ left: `${left}%`, width: `${width}%` }}
            title={c.title}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onSeek(c.start);
            }}
          />
        );
      })}
    </div>
  );
}
