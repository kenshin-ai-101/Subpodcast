/**
 * [INPUT]: highlights.HighlightClip；api.videoClip*；canvas 叠层；settings.clipExportDir
 * [OUTPUT]: openVideoClipDialog / VideoClipDialogHost — 剪视频工作室（正片 / 封面 / 文案；导出 Toast 可打开文件夹）
 * [POS]: 高光「剪成视频」宽屏双栏工作室；开窗合并 store 的 exportPath；prepare 共用 promise（导出不重跑第一步）；进度只升不降
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Check,
  Copy,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Scissors,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { create } from "zustand";
import {
  api,
  errText,
  type Episode,
  type RenderVideoClipResult,
  type Segment,
  type VideoClipProgress,
} from "../lib/api";
import { aiLineBreaks, textsToBreak } from "../lib/clipLines";
import { clock } from "../lib/format";
import {
  buildPlatformPost,
  polishClipCopy,
  saveClipCopy,
  saveClipExport,
  useHighlights,
  type HighlightClip,
  type PostPlatform,
} from "../lib/highlights";
import { showName } from "../lib/picks";
import {
  buildClipCues,
  canvasToPngBase64,
  clipGeometry,
  fromOldLayout,
  renderCueBand,
  renderStaticOverlay,
  type CardBg,
  type CardCrop,
  type ClipAspect,
  type ClipCue,
  type ClipFit,
  type ClipLayout,
  type ClipVisualConfig,
  type SubContent,
  type SubStyleId,
} from "../lib/videoClipCanvas";
import {
  renderCoverCanvas,
  subjectCenterX,
  type CoverAspect,
  type CoverTemplateId,
} from "../lib/videoCoverCanvas";
import { type CoverFontId } from "../lib/webfonts";
import { pauseAudioHost } from "../lib/audioHost";
import { pauseYoutubeHost } from "../lib/ytHost";
import { useStore } from "../store";
import { Seg } from "./ReadingSettings";

export interface ClipModalTarget {
  ep: Episode;
  segments: Segment[];
  zh?: (string | null | undefined)[];
  clip: HighlightClip;
}

interface ClipModalState {
  target: ClipModalTarget | null;
}

const useClipModal = create<ClipModalState>(() => ({ target: null }));

export function openVideoClipDialog(target: ClipModalTarget) {
  // 列表里的 clip 可能是旧快照；从 store 合并 exportPath，避免「已导出还重剪」。
  const fresh = useHighlights.getState().bundles[target.ep.id]?.clips.find((c) => c.id === target.clip.id);
  useClipModal.setState({
    target: fresh ? { ...target, clip: { ...target.clip, ...fresh } } : target,
  });
}

export function closeVideoClipDialog() {
  useClipModal.setState({ target: null });
}

export function VideoClipDialogHost() {
  const target = useClipModal((s) => s.target);
  if (!target) return null;
  const key = `${target.ep.id}:${target.clip.id}:${target.clip.startIdx}:${target.clip.endIdx}`;
  return <VideoClipDialogBody key={key} target={target} onClose={closeVideoClipDialog} />;
}

const PREF_KEY = "subpodcast.vclip";
type CoverMode = "flash" | "hold" | "none";
type SideTab = "clip" | "cover" | "copy";

interface ClipPrefs {
  layout?: ClipLayout;
  aspect?: ClipAspect;
  fit?: ClipFit;
  cardCrop?: CardCrop;
  speed?: number;
  subScale?: number;
  coverAccent?: string;
  coverFont?: CoverFontId;
  coverScale?: number;
  coverTracking?: number;
  brandText?: string;
  watermark?: boolean;
  cardBg?: CardBg;
  subStyle?: SubStyleId;
  subLang?: SubContent;
  showTitle?: boolean;
  showSource?: boolean;
  coverTpl?: CoverTemplateId;
  coverMode?: CoverMode;
  embedThumbnail?: boolean;
  saveCoverSidecar?: boolean;
  extraLandscapeCover?: boolean;
}

function readPrefs(): ClipPrefs {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function savePrefs(p: ClipPrefs) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {
    /* private mode */
  }
}

const SUB_STYLES: { id: SubStyleId; name: string; swatchBg: string; swatchFg: string }[] = [
  { id: "cinema", name: "电影描边", swatchBg: "#1b1c20", swatchFg: "#ffffff" },
  { id: "amber", name: "暖金高亮", swatchBg: "#1b1c20", swatchFg: "#ffd866" },
  { id: "pill", name: "暗底胶囊", swatchBg: "#2c2e35", swatchFg: "#f5f5f5" },
];

const COVER_TEMPLATES: { id: CoverTemplateId; name: string }[] = [
  { id: "impact", name: "暗幕金句" },
  { id: "marker", name: "荧光重点" },
  { id: "split", name: "上图下字" },
  { id: "bold", name: "大字报" },
  { id: "quote", name: "金句卡" },
  { id: "magazine", name: "杂志大字" },
  { id: "cinema", name: "电影画报" },
  { id: "minimal", name: "极简" },
];

const ACCENTS = ["", "#ffd23f", "#ff5a36", "#22c55e", "#3b82f6", "#ec4899"];
const COVER_FONTS: [CoverFontId, string][] = [
  ["", "字体：跟随样式"],
  ["noto-sans", "思源黑体"],
  ["noto-serif", "思源宋体"],
  ["wenkai", "霞鹜文楷"],
  ["sans", "苹方 / 系统黑体"],
  ["serif", "系统宋体"],
];
const SPEEDS = [1, 1.25, 1.5, 2];
const DOWNLOADS_DIR = /^.*\/(Downloads|下载)\//;

function shortExportPath(path: string): string {
  return path.replace(DOWNLOADS_DIR, "下载/");
}

interface PreparedState {
  key: string;
  path: string;
  lead: number;
  duration: number;
  hasBurnedSubtitles: boolean;
  width: number;
  height: number;
  frames: string[];
  bestFrame: number;
}

function VideoClipDialogBody({
  target,
  onClose,
}: {
  target: ClipModalTarget;
  onClose: () => void;
}) {
  const { ep, segments, zh, clip } = target;
  const notify = useStore((s) => s.notify);
  const set = useStore((s) => s.set);
  const exportDir = useStore((s) => s.settings.clipExportDir ?? "");
  const hasZh = !!zh?.some((x) => !!x?.trim());
  const prefs = readPrefs();
  const showDisplay = ep.showTitle ? showName(ep.showTitle) : "";

  const [sideTab, setSideTab] = useState<SideTab>("clip");
  const [pvView, setPvView] = useState<"video" | "cover">("video");

  const [startIdx, setStartIdx] = useState(() =>
    Math.max(0, Math.min(segments.length - 1, clip.startIdx)),
  );
  const [endIdx, setEndIdx] = useState(() =>
    Math.max(startIdx, Math.min(segments.length - 1, clip.endIdx)),
  );
  const [padBefore, setPadBefore] = useState(0.25);
  const [padAfter, setPadAfter] = useState(0.4);

  const [aspect, setAspect] = useState<ClipAspect>(() => prefs.aspect ?? fromOldLayout(prefs.layout).aspect);
  const [fit, setFit] = useState<ClipFit>(() => prefs.fit ?? fromOldLayout(prefs.layout).fit);
  const [brandText, setBrandText] = useState(() => prefs.brandText ?? "");
  const [watermark, setWatermark] = useState(() => prefs.watermark ?? true);
  const [cardBg, setCardBg] = useState<CardBg>(() => prefs.cardBg ?? "blur");
  const [cardCrop, setCardCrop] = useState<CardCrop>(() => prefs.cardCrop ?? "4:3");
  const [speed, setSpeed] = useState(() => prefs.speed ?? 1);
  const [subScale, setSubScale] = useState(() => prefs.subScale ?? 1);
  const [coverAccent, setCoverAccent] = useState(() => prefs.coverAccent ?? "");
  const [coverFont, setCoverFont] = useState<CoverFontId>(() => prefs.coverFont ?? "");
  const [coverScale, setCoverScale] = useState(() => prefs.coverScale ?? 1);
  const [coverTracking, setCoverTracking] = useState(() => prefs.coverTracking ?? 0);
  const [coverAdvanced, setCoverAdvanced] = useState(false);
  const coverStyle = {
    accent: coverAccent || undefined,
    font: coverFont || undefined,
    titleScale: coverScale,
    tracking: coverTracking,
  };

  const [cropX, setCropXRaw] = useState(0.5);
  const cropTouched = useRef(false);
  const setCropX = (v: number) => {
    cropTouched.current = true;
    setCropXRaw(v);
  };

  const [subStyle, setSubStyle] = useState<SubStyleId>(() => prefs.subStyle ?? "cinema");
  const [subLang, setSubLang] = useState<SubContent>(() => (hasZh ? (prefs.subLang ?? "bilingual") : "original"));
  const [showTitle, setShowTitle] = useState(() => prefs.showTitle ?? true);
  const [showSource, setShowSource] = useState(() => prefs.showSource ?? true);
  const [title, setTitle] = useState(() => clip.title);
  const [liftBurned, setLiftBurned] = useState(false);
  const [addSubsPick, setAddSubsPick] = useState<boolean | null>(null);

  const [coverTpl, setCoverTpl] = useState<CoverTemplateId>(() => prefs.coverTpl ?? "impact");
  const [coverAspectPv, setCoverAspectPv] = useState<"auto" | CoverAspect>("auto");
  const [coverMode, setCoverMode] = useState<CoverMode>(() => prefs.coverMode ?? "flash");
  const [embedThumbnail, setEmbedThumbnail] = useState(() => prefs.embedThumbnail ?? true);
  const [saveCoverSidecar, setSaveCoverSidecar] = useState(() => prefs.saveCoverSidecar ?? true);
  const [extraLandscapeCover, setExtraLandscapeCover] = useState(() => prefs.extraLandscapeCover ?? true);

  const [coverHook, setCoverHook] = useState(() => clip.coverHook || clip.title);
  const [coverSub, setCoverSub] = useState(
    () => clip.coverSub || (clip.reason && clip.reason !== "手动选取片段" ? clip.reason : ""),
  );
  const [coverKicker, setCoverKicker] = useState(() => showDisplay || "播客高光");
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null);
  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string | null>(null);
  const [tplThumbs, setTplThumbs] = useState<Partial<Record<CoverTemplateId, string>>>({});

  const [shareCopy, setShareCopy] = useState(() => clip.shareCopy);
  const [articleCopy, setArticleCopy] = useState(() => clip.articleCopy || "");
  const [postPlatform, setPostPlatform] = useState<PostPlatform>("short");
  const [postEdits, setPostEdits] = useState<Partial<Record<PostPlatform, string>>>({});
  const [polishing, setPolishing] = useState(false);

  const [zhEdits, setZhEdits] = useState<Record<number, string>>({});
  const [origEdits, setOrigEdits] = useState<Record<number, string>>({});
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [activePreviewIdx, setActivePreviewIdx] = useState(startIdx);

  const [prepared, setPrepared] = useState<PreparedState | null>(null);
  const [busyJob, setBusyJob] = useState<{
    id: string;
    stage: string;
    progress: number;
    message: string;
  } | null>(null);
  const [exported, setExported] = useState<RenderVideoClipResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [lineBreaks, setLineBreaks] = useState<Record<number, string[]>>({});

  const [staticOverlayUrl, setStaticOverlayUrl] = useState<string | null>(null);
  const [cueBandPreview, setCueBandPreview] = useState<{ url: string; topPct: number } | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const ytRef = useRef<HTMLIFrameElement>(null);
  const activeJobId = useRef<string | null>(null);
  /** 仅用户关窗时取消任务；Strict Mode 重挂载不得 cancel，否则 prepare 会死在 6%。 */
  const closeRequested = useRef(false);
  /** 进度只升不降，避免阶段切换时 UI 乱跳。 */
  const progressPeak = useRef(0);
  const [pvPlaying, setPvPlaying] = useState(false);
  const [pvMuted, setPvMuted] = useState(false);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [pvTime, setPvTime] = useState(0);
  /** 有历史导出时先校验文件，避免一打开又自动 prepare。 */
  const [exportGate, setExportGate] = useState<"idle" | "checking" | "ready" | "missing">(
    clip.exportPath ? "checking" : "ready",
  );

  const pausePreview = () => {
    const v = videoRef.current;
    if (v) {
      try {
        v.pause();
      } catch {
        /* ignore */
      }
    }
  };

  /** 关窗时彻底掐掉预览：清 src，避免卸载后仍出声。 */
  const killPreview = () => {
    pausePreview();
    const v = videoRef.current;
    if (v) {
      try {
        v.removeAttribute("src");
        v.load();
      } catch {
        /* ignore */
      }
    }
    const yt = ytRef.current;
    if (yt) yt.src = "about:blank";
  };

  const requestClose = () => {
    closeRequested.current = true;
    const id = activeJobId.current;
    if (id) void api.cancelJob(id);
    killPreview();
    // 与原站一致：忙碌中也可立刻关窗（先 cancel 再卸弹层）。
    onClose();
  };

  const cancelBusyJob = () => {
    const id = activeJobId.current ?? busyJob?.id;
    if (!id) return;
    void api.cancelJob(id);
    setBusyJob((cur) =>
      cur && cur.id === id ? { ...cur, message: "正在取消…", progress: cur.progress } : cur,
    );
  };

  useEffect(() => {
    const st = useStore.getState();
    // 原片必须停：toggle 之外再掐双引擎，避免状态不同步仍在出声。
    if (st.playing) st.player?.toggle();
    pauseYoutubeHost();
    pauseAudioHost();
    const at = Math.max(0, clip.start);
    if (st.player && st.current?.id === ep.id) {
      try {
        st.player.seek(at);
      } catch {
        /* ignore */
      }
    }
    st.set({ playing: false, playWhenReady: null, seekWhenReady: { id: ep.id, at } });
    return () => killPreview();
    // 只在打开时停一次；clip.start / ep.id 随 target 固定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const path = clip.exportPath;
    if (!path) {
      setExportGate("ready");
      return;
    }
    let alive = true;
    setExportGate("checking");
    void api
      .fileExists(path)
      .then((ok) => {
        if (!alive) return;
        if (ok) {
          setExported({
            videoPath: path,
            coverPath: clip.exportCoverPath ?? null,
            landscapeCoverPath: null,
          });
          setExportGate("idle");
        } else {
          setExportGate("ready");
        }
      })
      .catch(() => {
        if (alive) setExportGate("ready");
      });
    return () => {
      alive = false;
    };
  }, [clip.exportPath, clip.exportCoverPath]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed]);

  useEffect(() => {
    savePrefs({
      aspect,
      fit,
      cardCrop,
      speed,
      subScale,
      coverAccent,
      coverFont,
      coverScale,
      coverTracking,
      brandText,
      watermark,
      cardBg,
      subStyle,
      subLang,
      showTitle,
      showSource,
      coverTpl,
      coverMode,
      embedThumbnail,
      saveCoverSidecar,
      extraLandscapeCover,
    });
  }, [
    aspect,
    fit,
    cardCrop,
    speed,
    subScale,
    coverAccent,
    coverFont,
    coverScale,
    coverTracking,
    brandText,
    watermark,
    cardBg,
    subStyle,
    subLang,
    showTitle,
    showSource,
    coverTpl,
    coverMode,
    embedThumbnail,
    saveCoverSidecar,
    extraLandscapeCover,
  ]);

  const montage = (clip.parts?.length ?? 0) > 1;
  const parts = montage
    ? (() => {
        let offset = 0;
        return clip.parts!.map((p) => {
          const a = Math.max(0, (segments[p.startIdx]?.start ?? 0) - padBefore);
          const b = Math.max(a + 1, (segments[p.endIdx]?.end ?? a + 5) + padAfter);
          const part = { startIdx: p.startIdx, endIdx: p.endIdx, a, b, offset };
          offset += b - a;
          return part;
        });
      })()
    : (() => {
        const a = Math.max(0, (segments[startIdx]?.start ?? 0) - padBefore);
        const b = Math.max(a + 1, (segments[endIdx]?.end ?? a + 5) + padAfter);
        return [{ startIdx, endIdx, a, b, offset: 0 }];
      })();

  const clipStart = parts[0].a;
  const clipEnd = parts[parts.length - 1].b;
  const clipDur = parts.reduce((n, p) => n + (p.b - p.a), 0);
  const rangesKey = parts.map((p) => `${p.a.toFixed(2)}-${p.b.toFixed(2)}`).join("_");
  const preparedValid = !!prepared && prepared.key === rangesKey;

  const toClipTime = (segIdx: number, at: number) => {
    const p = parts.find((x) => segIdx >= x.startIdx && segIdx <= x.endIdx) ?? parts[0];
    return Math.max(0, p.offset + at - p.a);
  };

  const clipLineIdx = parts.flatMap((p) =>
    Array.from({ length: p.endIdx - p.startIdx + 1 }, (_, k) => p.startIdx + k),
  );

  const effectiveSegments = segments.map((s, i) =>
    origEdits[i] !== undefined ? { ...s, text: origEdits[i] } : s,
  );
  const effectiveZh = segments.map((_, i) => (zhEdits[i] !== undefined ? zhEdits[i] : zh?.[i] ?? null));

  const addSubs = addSubsPick ?? !(prepared?.hasBurnedSubtitles && fit === "card");
  const geo = clipGeometry(
    aspect,
    fit,
    prepared?.width || 1920,
    prepared?.height || 1080,
    cardCrop,
    addSubs,
  );
  const maxCjk = geo.W > geo.H ? 18 : 14;

  const buildAllCues = (): ClipCue[] =>
    parts.flatMap((p) =>
      buildClipCues(
        effectiveSegments,
        effectiveZh,
        p.startIdx,
        p.endIdx,
        p.a,
        p.b,
        subLang,
        lineBreaks,
        maxCjk,
      ).map((c) => ({ ...c, start: c.start + p.offset, end: c.end + p.offset })),
    );

  const cues = addSubs ? buildAllCues() : [];

  const visualConfig: ClipVisualConfig = {
    geo,
    cardBg,
    subStyle,
    subLang,
    showTitle,
    title,
    showSource,
    showName: showDisplay,
    episodeTitle: ep.title,
    brandText,
    watermark,
    liftForBurnedSub: liftBurned,
    subScale,
  };

  useEffect(() => {
    const c = renderStaticOverlay(visualConfig);
    setStaticOverlayUrl(c ? c.toDataURL("image/png") : null);
  }, [
    geo.W,
    geo.H,
    geo.video.x,
    geo.video.y,
    geo.video.w,
    geo.video.h,
    cardBg,
    subStyle,
    showTitle,
    title,
    showSource,
    showDisplay,
    ep.title,
    brandText,
    watermark,
    subScale,
  ]);

  useEffect(() => {
    if (!cues.length) {
      setCueBandPreview(null);
      return;
    }
    let current: ClipCue | null = null;
    if (preparedValid && prepared) {
      current = cues.find((c) => pvTime >= c.start && pvTime <= c.end) ?? cues[0];
    } else {
      const seg = effectiveSegments[activePreviewIdx];
      const relMid = seg ? toClipTime(activePreviewIdx, (seg.start + seg.end) / 2) : 0;
      current = cues.find((c) => relMid >= c.start && relMid <= c.end) ?? cues[0];
    }
    if (!current) {
      setCueBandPreview(null);
      return;
    }
    const band = renderCueBand(current, visualConfig);
    setCueBandPreview({
      url: band.canvas.toDataURL("image/png"),
      topPct: (band.y / geo.H) * 100,
    });
  }, [cues, pvTime, activePreviewIdx, preparedValid, visualConfig, geo.H]);

  useEffect(() => {
    const src = prepared?.frames[prepared.bestFrame];
    if (!src || cropTouched.current) return;
    const img = new Image();
    img.onload = () => {
      if (!cropTouched.current)
        setCropXRaw(subjectCenterX(img, prepared?.hasBurnedSubtitles ? 0.2 : 0));
    };
    img.src = src;
  }, [prepared?.frames, prepared?.bestFrame, prepared?.hasBurnedSubtitles]);

  useEffect(() => {
    setLineBreaks({});
  }, [maxCjk, subLang]);

  useEffect(() => {
    if (!addSubs) return;
    const texts = parts
      .flatMap((p) => textsToBreak(effectiveSegments, effectiveZh, p.startIdx, p.endIdx, subLang))
      .filter((x) => !lineBreaks[x.i]);
    if (!texts.length) return;
    const ctl = new AbortController();
    const timer = window.setTimeout(() => {
      void aiLineBreaks(texts, maxCjk, ctl.signal)
        .then((r) => {
          if (!ctl.signal.aborted && Object.keys(r).length) setLineBreaks((p) => ({ ...p, ...r }));
        })
        .catch(() => {});
    }, 400);
    return () => {
      window.clearTimeout(timer);
      ctl.abort();
    };
  }, [addSubs, rangesKey, subLang, maxCjk, effectiveSegments, effectiveZh]);

  const posterBackdrop =
    ep.cover || (ep.videoId ? `https://i.ytimg.com/vi/${ep.videoId}/hqdefault.jpg` : undefined);
  const activeFrameIdx =
    selectedFrame != null && prepared?.frames[selectedFrame] != null
      ? selectedFrame
      : (prepared?.bestFrame ?? 0);
  const activeCoverBackdrop = prepared?.frames[activeFrameIdx] || posterBackdrop || null;
  const videoCoverAspect: CoverAspect =
    geo.W > geo.H
      ? "16:9"
      : aspect === "9:16" || (aspect === "source" && geo.H / geo.W > 1.5)
        ? "9:16"
        : aspect === "1:1"
          ? "1:1"
          : "3:4";
  const effectiveCoverAspect: CoverAspect =
    coverAspectPv === "auto" ? videoCoverAspect : coverAspectPv;

  useEffect(() => {
    let live = true;
    void renderCoverCanvas({
      template: coverTpl,
      aspect: effectiveCoverAspect,
      hookTitle: coverHook,
      subTitle: coverSub,
      kicker: coverKicker,
      showName: showDisplay,
      durationSec: clipDur / speed,
      backdropUrl: activeCoverBackdrop,
      brand: brandText,
      ...coverStyle,
      cropBottom: prepared?.hasBurnedSubtitles ? 0.2 : 0,
    })
      .then((c) => {
        if (live) setCoverPreviewUrl(c.toDataURL("image/png"));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [
    coverTpl,
    effectiveCoverAspect,
    coverHook,
    coverSub,
    coverKicker,
    showDisplay,
    clipDur,
    speed,
    activeCoverBackdrop,
    brandText,
    coverAccent,
    coverFont,
    coverScale,
    coverTracking,
    prepared?.hasBurnedSubtitles,
  ]);

  useEffect(() => {
    if (sideTab !== "cover") return;
    let live = true;
    const timer = window.setTimeout(async () => {
      for (const tpl of COVER_TEMPLATES) {
        const c = await renderCoverCanvas({
          template: tpl.id,
          aspect: "3:4",
          hookTitle: coverHook,
          subTitle: "",
          kicker: coverKicker,
          showName: showDisplay,
          durationSec: 0,
          backdropUrl: activeCoverBackdrop,
          brand: brandText,
          ...coverStyle,
          cropBottom: prepared?.hasBurnedSubtitles ? 0.2 : 0,
        });
        if (!live) return;
        const small = document.createElement("canvas");
        small.width = 180;
        small.height = 240;
        small.getContext("2d")!.drawImage(c, 0, 0, 180, 240);
        setTplThumbs((p) => ({ ...p, [tpl.id]: small.toDataURL("image/jpeg", 0.82) }));
      }
    }, 350);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [
    sideTab,
    coverHook,
    coverKicker,
    showDisplay,
    activeCoverBackdrop,
    brandText,
    coverAccent,
    coverFont,
    coverScale,
    coverTracking,
    prepared?.hasBurnedSubtitles,
  ]);

  const generatedPost = buildPlatformPost(postPlatform, {
    ep,
    title,
    coverHook,
    coverSub,
    shareCopy,
    articleCopy,
    tags: clip.tags,
    segments: effectiveSegments,
    zh: effectiveZh,
    startIdx,
    endIdx,
    clipStart,
  });
  const currentPostText = postEdits[postPlatform] ?? generatedPost;

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    // 挂载即听进度；activeJobId 只在 ensurePrepared/runExport 里写入，避免渲染时被 busyJob 空值抹掉。
    void listen<VideoClipProgress>("video-clip-progress", (e) => {
      if (!alive || e.payload.jobId !== activeJobId.current) return;
      const raw = Number(e.payload.progress);
      if (!Number.isFinite(raw)) return;
      const next = Math.max(progressPeak.current, Math.min(1, raw));
      progressPeak.current = next;
      setBusyJob({
        id: e.payload.jobId,
        stage: e.payload.stage,
        progress: next,
        message: e.payload.message,
      });
    }).then((fn) => {
      if (!alive) fn();
      else unlisten = fn;
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  useEffect(
    () => () => {
      if (closeRequested.current && activeJobId.current) {
        void api.cancelJob(activeJobId.current);
      }
    },
    [],
  );

  // 预热交给 HighlightViews.useClipWarm；这里再 warm 会与 prepare 抢同一段锁。

  const autoPrepared = useRef("");
  /** 与 state 同步，供 await 之后的导出仍能读到刚准备好的片段（避免闭包里 prepared 仍是 null）。 */
  const preparedRef = useRef<PreparedState | null>(null);
  /** 同一 rangesKey 共用一个 promise：导出点太快时 await 同一趟，绝不 return null 再重开第一遍。 */
  const prepShared = useRef<{ key: string; promise: Promise<PreparedState | null> } | null>(null);

  useEffect(() => {
    preparedRef.current = prepared;
  }, [prepared]);

  const ensurePrepared = async (force = false): Promise<PreparedState | null> => {
    const cached = preparedRef.current;
    if (!force && cached && cached.key === rangesKey) return cached;
    if (!ep.videoId) {
      setError("当前单集没有可用视频源");
      return null;
    }
    if (!force && prepShared.current?.key === rangesKey) {
      return prepShared.current.promise;
    }

    // 与原站一致：开战前盖章，失败/取消都不再自动空转重跑。
    autoPrepared.current = rangesKey;
    const jobKey = rangesKey;
    const jobId = `vclip-prep-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const start = clipStart;
    const end = clipEnd;
    const dur = clipDur;
    const ranges = montage ? parts.map((p) => [p.a, p.b] as [number, number]) : undefined;

    const promise = (async (): Promise<PreparedState | null> => {
      activeJobId.current = jobId;
      progressPeak.current = 0.02;
      setError(null);
      setNeedsSetup(false);
      setBusyJob({ id: jobId, stage: "download", progress: 0.02, message: "正在获取这一段原视频…" });
      try {
        const res = await api.videoClipPrepare(jobId, ep.videoId!, start, end, ranges);
        if (closeRequested.current) return null;
        const next: PreparedState = {
          key: jobKey,
          path: res.path,
          lead: res.lead ?? 0,
          duration: res.duration || dur,
          hasBurnedSubtitles: res.hasBurnedSubtitles,
          width: res.width,
          height: res.height,
          frames: res.frames ?? [],
          bestFrame: res.bestFrame ?? 0,
        };
        preparedRef.current = next;
        setPrepared(next);
        if (selectedFrame == null) setSelectedFrame(next.bestFrame);
        if (res.hasBurnedSubtitles) setLiftBurned(true);
        progressPeak.current = 1;
        // 事件可能晚于 invoke resolve；先把条拉满停一拍再卸，避免「55% 直接消失」。
        setBusyJob({
          id: jobId,
          stage: "done",
          progress: 1,
          message: res.cached ? "已复用缓存片段" : "片段已就绪",
        });
        await new Promise((r) => window.setTimeout(r, 180));
        return next;
      } catch (e) {
        const msg = errText(e);
        if (!/取消|cancel/i.test(msg)) setError(msg);
        return null;
      } finally {
        if (prepShared.current?.key === jobKey) prepShared.current = null;
        if (activeJobId.current === jobId) activeJobId.current = null;
        setBusyJob(null);
      }
    })();

    prepShared.current = { key: jobKey, promise };
    return promise;
  };

  useEffect(() => {
    // 已有导出文件：不自动重下原片；用户点「重新剪辑」后再 prepare。
    if (exportGate === "checking" || exportGate === "idle") return;
    if (!ep.videoId || preparedValid || busyJob || autoPrepared.current === rangesKey) return;
    const timer = window.setTimeout(() => {
      void ensurePrepared();
    }, prepared ? 900 : 150);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangesKey, preparedValid, !!busyJob, ep.videoId, exportGate]);

  const runAiPolish = async (fill = false, again = false) => {
    if (polishing) return;
    setPolishing(true);
    setError(null);
    setNeedsSetup(false);
    try {
      const res = await polishClipCopy({
        ep,
        segments: effectiveSegments,
        zh: effectiveZh,
        startIdx,
        endIdx,
        ranges: montage ? parts : undefined,
        previous: again ? currentPostText : undefined,
      });
      if (again) setTitle(res.title);
      else if (!fill || !clip.coverHook) {
        setTitle(res.title);
        setCoverHook(res.coverHook);
        setCoverSub(res.coverSub);
      }
      setShareCopy(res.shareCopy);
      setArticleCopy(res.articleCopy);
      setPostEdits({});
      if (fill) void saveClipCopy(ep.id, clip.id, { shareCopy: res.shareCopy, articleCopy: res.articleCopy });
      if (!fill) notify("AI 已生成封面金句与多平台文案");
    } catch (e) {
      const msg = errText(e);
      setNeedsSetup(Boolean((e as { setup?: boolean })?.setup) || /设置|API|模型/.test(msg));
      setError(msg);
    } finally {
      setPolishing(false);
    }
  };

  const autoFilled = useRef(false);
  useEffect(() => {
    if (autoFilled.current || clip.articleCopy) return;
    autoFilled.current = true;
    void runAiPolish(true);
  }, []);

  const copyCoverImage = async (aspectOverride?: CoverAspect) => {
    try {
      const c = await renderCoverCanvas({
        template: coverTpl,
        aspect: aspectOverride ?? effectiveCoverAspect,
        hookTitle: coverHook,
        subTitle: coverSub,
        kicker: coverKicker,
        showName: showDisplay,
        durationSec: clipDur / speed,
        backdropUrl: activeCoverBackdrop,
        brand: brandText,
        ...coverStyle,
        cropBottom: prepared?.hasBurnedSubtitles ? 0.2 : 0,
      });
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
      if (!blob) throw new Error("blob");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      notify("封面图已复制到剪贴板");
    } catch {
      notify("复制失败，请用「保存封面」");
    }
  };

  const saveCoverImage = async (aspectOverride?: CoverAspect) => {
    try {
      const targetAspect = aspectOverride ?? effectiveCoverAspect;
      const c = await renderCoverCanvas({
        template: coverTpl,
        aspect: targetAspect,
        hookTitle: coverHook,
        subTitle: coverSub,
        kicker: coverKicker,
        showName: showDisplay,
        durationSec: clipDur / speed,
        backdropUrl: activeCoverBackdrop,
        brand: brandText,
        ...coverStyle,
        cropBottom: prepared?.hasBurnedSubtitles ? 0.2 : 0,
      });
      const safeTitle = (title.trim() || ep.title).replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 50);
      const name = `${safeTitle || "声译切片"}-封面-${targetAspect.replace(":", "x")}`;
      const path = await api.saveDownload(name, c.toDataURL("image/png"), true);
      notify(`封面已保存到 ${shortExportPath(path)}`);
    } catch (e) {
      notify(errText(e));
    }
  };

  const runExport = async (askPath: boolean) => {
    if (busyJob) return;
    setExported(null);
    setError(null);
    setNeedsSetup(false);

    let customPath: string | null = null;
    const safeTitle = (title.trim() || ep.title).replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60);
    const defaultName = `${safeTitle || "声译切片"} (${clock(clipStart).replace(/:/g, "-")})`;
    if (askPath) {
      customPath = await saveDialog({
        defaultPath: `${defaultName}.mp4`,
        filters: [{ name: "MP4", extensions: ["mp4"] }],
      }).catch(() => null);
      if (!customPath) return;
    }

    const prep = await ensurePrepared();
    if (!prep) return;

    const jobId = `vclip-render-${Date.now()}`;
    activeJobId.current = jobId;
    progressPeak.current = 0.05;
    setBusyJob({ id: jobId, stage: "render", progress: 0.05, message: "正在生成封面和画面图层…" });
    try {
      const subsOn = addSubsPick ?? !(prep.hasBurnedSubtitles && fit === "card");
      const exportGeo = clipGeometry(aspect, fit, prep.width, prep.height, cardCrop, subsOn);
      const exportConfig: ClipVisualConfig = { ...visualConfig, geo: exportGeo };
      const staticCanvas = renderStaticOverlay(exportConfig);
      const staticOverlayPng = staticCanvas ? canvasToPngBase64(staticCanvas) : null;
      const exportCues = subsOn ? (cues.length ? cues : buildAllCues()) : [];
      const renderedCues = exportCues.map((cue) => {
        const band = renderCueBand(cue, exportConfig);
        return {
          start: cue.start / speed,
          end: cue.end / speed,
          y: band.y,
          pngBase64: canvasToPngBase64(band.canvas),
        };
      });

      const bestIdx =
        selectedFrame != null && prep.frames[selectedFrame] ? selectedFrame : prep.bestFrame;
      const backdropForExport = prep.frames[bestIdx] || posterBackdrop || null;
      const mainAspect = videoCoverAspect;
      const needMainCover = coverMode !== "none" || embedThumbnail || saveCoverSidecar;

      let coverPng: string | null = null;
      if (needMainCover) {
        const coverCanvas = await renderCoverCanvas({
          template: coverTpl,
          aspect: mainAspect,
          hookTitle: coverHook,
          subTitle: coverSub,
          kicker: coverKicker,
          showName: showDisplay,
          durationSec: prep.duration / speed,
          backdropUrl: backdropForExport,
          brand: brandText,
          ...coverStyle,
          cropBottom: prep.hasBurnedSubtitles ? 0.2 : 0,
        });
        coverPng = canvasToPngBase64(coverCanvas);
      }

      let landscapeCoverPng: string | null = null;
      if (mainAspect !== "16:9" && saveCoverSidecar && extraLandscapeCover) {
        const landCanvas = await renderCoverCanvas({
          template: coverTpl,
          aspect: "16:9",
          hookTitle: coverHook,
          subTitle: coverSub,
          kicker: coverKicker,
          showName: showDisplay,
          durationSec: prep.duration / speed,
          backdropUrl: backdropForExport,
          brand: brandText,
          ...coverStyle,
          cropBottom: prep.hasBurnedSubtitles ? 0.2 : 0,
        });
        landscapeCoverPng = canvasToPngBase64(landCanvas);
      }

      const eg = exportGeo;
      const result = await api.videoClipRender(jobId, {
        rawPath: prep.path,
        outputPath: customPath,
        outputDir: exportDir || null,
        defaultName,
        layout: "frame",
        frame: {
          w: eg.W,
          h: eg.H,
          fit: eg.fit,
          vx: eg.video.x,
          vy: eg.video.y,
          vw: eg.video.w,
          vh: eg.video.h,
          cropBox: eg.cropBox,
        },
        cardBg,
        cropX,
        duration: prep.duration,
        lead: prep.lead,
        speed,
        staticOverlayPng,
        cues: renderedCues,
        coverPng,
        coverMode,
        embedThumbnail,
        saveCoverSidecar,
        landscapeCoverPng,
      });
      setExported(result);
      setExportGate("idle");
      void saveClipExport(ep.id, clip.id, {
        exportPath: result.videoPath,
        exportCoverPath: result.coverPath ?? undefined,
      });
      // 导出完成先停声；关窗时再清 src。
      pausePreview();
      setPvPlaying(false);
      notify(`视频切片已导出到 ${shortExportPath(result.videoPath)}`, {
        label: "打开文件夹",
        run: () => void api.revealFile(result.videoPath).catch(() => {}),
      });
    } catch (e) {
      const msg = errText(e);
      if (!/取消|cancel/i.test(msg)) setError(msg);
    } finally {
      if (activeJobId.current === jobId) activeJobId.current = null;
      setBusyJob(null);
    }
  };

  const restartClip = () => {
    setExported(null);
    setExportGate("ready");
    autoPrepared.current = "";
    prepShared.current = null;
    preparedRef.current = null;
    setPrepared(null);
    setError(null);
  };

  const copyCurrentPost = async () => {
    try {
      const { writeClipboardText } = await import("../lib/clipboard");
      await writeClipboardText(currentPostText);
      notify("发布文案已复制");
    } catch {
      notify("复制失败");
    }
  };

  const togglePreviewPlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };

  const switchSideTab = (tab: SideTab) => {
    setSideTab(tab);
    if (tab === "cover") setPvView("cover");
    else if (tab === "clip") setPvView("video");
  };

  const card = geo.fit === "card";
  const stageBgClass = card
    ? cardBg === "paper"
      ? "bg-paper"
      : cardBg === "night"
        ? "bg-night"
        : "bg-blur"
    : "bg-night";
  // 左栏 grid 上限 340px；用 440 会让 16:9 等横版溢出盖住右侧配置。
  // width 封顶 + aspect-ratio + height:auto：窄窗时随列宽收缩，不挤布局。
  const pvScale = Math.min(340 / geo.W, 520 / geo.H);
  const stageStyle: React.CSSProperties = {
    width: Math.round(geo.W * pvScale),
    maxWidth: "100%",
    aspectRatio: `${geo.W} / ${geo.H}`,
    height: "auto",
    flex: "none",
  };
  const boxStyle: React.CSSProperties = {
    left: `${(geo.video.x / geo.W) * 100}%`,
    top: `${(geo.video.y / geo.H) * 100}%`,
    width: `${(geo.video.w / geo.W) * 100}%`,
    height: `${(geo.video.h / geo.H) * 100}%`,
  };
  const mediaStyle: React.CSSProperties | undefined =
    card && !geo.cropBox
      ? { objectFit: "contain" }
      : { objectFit: "cover", objectPosition: `${cropX * 100}% center` };
  const srcRatio = (prepared?.width || 1920) / (prepared?.height || 1080);
  const boxRatio = geo.video.w / geo.video.h;
  const coverIt = !(card && !geo.cropBox);
  const ytFrameBase: React.CSSProperties =
    coverIt && srcRatio > boxRatio
      ? {
          width: `${(srcRatio / boxRatio) * 100}%`,
          height: "100%",
          left: `${(1 - srcRatio / boxRatio) * cropX * 100}%`,
          top: 0,
        }
      : coverIt
        ? {
            width: "100%",
            height: `${(boxRatio / srcRatio) * 100}%`,
            top: `${((1 - boxRatio / srcRatio) / 2) * 100}%`,
            left: 0,
          }
        : {
            height: "100%",
            width: `${(srcRatio / boxRatio) * 100}%`,
            left: `${((1 - srcRatio / boxRatio) / 2) * 100}%`,
            top: 0,
          };
  const ytFrameStyle: React.CSSProperties = {
    ...ytFrameBase,
    transform: "scale(1.35)",
    transformOrigin: "center",
  };
  const preparing = !!busyJob && ["download", "ffmpeg", "trim", "inspect"].includes(busyJob.stage);

  return (
    <div
      className="modal-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        className="modal wide has-foot"
        role="dialog"
        aria-modal="true"
        aria-label="剪成视频"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3>
            <Scissors size={16} /> 剪成视频
          </h3>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={requestClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="vclip-layout">
            <div className="vclip-preview-col">
              <div className="vclip-pv-switch">
                <Seg
                  value={pvView}
                  options={[
                    ["video", "正片预览"],
                    ["cover", "封面预览"],
                  ]}
                  onChange={setPvView}
                />
                {pvView === "cover" && (
                  <Seg
                    value={coverAspectPv}
                    options={[
                      ["auto", "随视频"],
                      ["9:16", "9:16"],
                      ["3:4", "3:4"],
                      ["1:1", "1:1"],
                      ["16:9", "16:9"],
                    ]}
                    onChange={setCoverAspectPv}
                  />
                )}
              </div>

              {pvView === "cover" ? (
                <div className={`vclip-cover-stage aspect-${effectiveCoverAspect.replace(":", "-")}`}>
                  {coverPreviewUrl ? (
                    <img src={coverPreviewUrl} alt="封面预览" className="vclip-cover-img" />
                  ) : (
                    <p className="muted small">
                      <Loader2 size={16} className="spin" /> 正在生成封面…
                    </p>
                  )}
                </div>
              ) : (
                <div
                  className={`vclip-stage ${geo.W > geo.H ? "is-land" : "is-port"} ${stageBgClass}`}
                  style={stageStyle}
                >
                  {card && cardBg === "blur" && posterBackdrop && (
                    <img src={posterBackdrop} alt="" className="vclip-blur-bg" />
                  )}
                  <div className="vclip-video-box" style={boxStyle}>
                    {preparedValid && prepared ? (
                      <video
                        ref={videoRef}
                        src={convertFileSrc(prepared.path)}
                        autoPlay={!exported}
                        playsInline
                        muted={pvMuted}
                        style={mediaStyle}
                        onLoadedMetadata={(e) => {
                          const v = e.currentTarget;
                          v.currentTime = prepared.lead;
                          v.playbackRate = speed;
                          v.muted = pvMuted;
                          v.volume = 1;
                          if (exported) {
                            v.pause();
                            return;
                          }
                          void v.play().catch(() => {
                            v.muted = true;
                            setPvMuted(true);
                            setSoundBlocked(true);
                            void v.play().catch(() => {});
                          });
                        }}
                        onTimeUpdate={(e) => {
                          const v = e.currentTarget;
                          const at = v.currentTime - prepared.lead;
                          if (!exported && (at >= prepared.duration - 0.05 || v.ended)) {
                            v.currentTime = prepared.lead;
                            void v.play().catch(() => {});
                          }
                          setPvTime(Math.max(0, at));
                        }}
                        onEnded={(e) => {
                          if (exported) return;
                          e.currentTarget.currentTime = prepared.lead;
                          void e.currentTarget.play().catch(() => {});
                        }}
                        onPlay={() => {
                          setPvPlaying(true);
                          const s = useStore.getState();
                          if (s.playing) s.player?.toggle();
                        }}
                        onPause={() => setPvPlaying(false)}
                        onClick={togglePreviewPlay}
                      />
                    ) : (
                      <div className="vclip-placeholder">
                        {ep.videoId && !montage && exportGate !== "idle" ? (
                          <iframe
                            ref={ytRef}
                            className="vclip-yt"
                            title="预览"
                            style={ytFrameStyle}
                            allow="autoplay; encrypted-media"
                            src={`https://www.youtube.com/embed/${ep.videoId}?start=${Math.floor(clipStart)}&end=${Math.ceil(clipEnd)}&autoplay=1&mute=0&controls=0&playsinline=1&rel=0&modestbranding=1&loop=1&playlist=${ep.videoId}&disablekb=1&iv_load_policy=3&cc_load_policy=0&origin=${encodeURIComponent(location.origin)}`}
                          />
                        ) : posterBackdrop ? (
                          <img src={posterBackdrop} alt="" style={mediaStyle} />
                        ) : null}
                      </div>
                    )}
                  </div>
                  {staticOverlayUrl && (
                    <img src={staticOverlayUrl} alt="" className="vclip-overlay-img" />
                  )}
                  {busyJob && busyJob.stage !== "render" && (
                    <div className="vclip-pv-progress" role="status">
                      <span>{preparing ? "正在准备高清画面" : busyJob.message}</span>
                      <span className="num">{Math.round(busyJob.progress * 100)}%</span>
                      <i style={{ width: `${Math.max(3, busyJob.progress * 100)}%` }} />
                    </div>
                  )}
                  {cueBandPreview && (
                    <img
                      src={cueBandPreview.url}
                      alt=""
                      className="vclip-cue-img"
                      style={{ top: `${cueBandPreview.topPct}%` }}
                    />
                  )}
                </div>
              )}

              <div className="vclip-pv-bar">
                {pvView === "cover" ? (
                  <>
                    <div className="vclip-cover-tools" role="toolbar" aria-label="封面文字">
                      <select
                        className="vclip-font-select"
                        value={coverFont}
                        onChange={(e) => setCoverFont(e.target.value as CoverFontId)}
                        aria-label="字体"
                      >
                        {COVER_FONTS.map(([v, label]) => (
                          <option key={v || "auto"} value={v}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <div className="vclip-swatches" role="radiogroup" aria-label="高亮色">
                        {ACCENTS.map((c) => (
                          <button
                            key={c || "auto"}
                            type="button"
                            role="radio"
                            aria-checked={coverAccent === c}
                            className={`sw${coverAccent === c ? " on" : ""}${c ? "" : " auto"}`}
                            style={c ? { background: c } : undefined}
                            title={c || "跟随样式"}
                            onClick={() => setCoverAccent(c)}
                          />
                        ))}
                      </div>
                      <button
                        type="button"
                        className={`link-btn small${coverAdvanced ? " on" : ""}`}
                        aria-expanded={coverAdvanced}
                        onClick={() => setCoverAdvanced(!coverAdvanced)}
                      >
                        高级
                      </button>
                    </div>
                    {coverAdvanced && (
                      <div className="vclip-cover-adv">
                        <label>
                          <span>字号</span>
                          <input
                            type="range"
                            min={0.8}
                            max={1.25}
                            step={0.05}
                            value={coverScale}
                            onChange={(e) => setCoverScale(Number(e.target.value))}
                          />
                          <span className="num">{Math.round(coverScale * 100)}%</span>
                        </label>
                        <label>
                          <span>字间距</span>
                          <input
                            type="range"
                            min={-0.05}
                            max={0.2}
                            step={0.01}
                            value={coverTracking}
                            onChange={(e) => setCoverTracking(Number(e.target.value))}
                          />
                          <span className="num">{Math.round(coverTracking * 100)}</span>
                        </label>
                        {(coverScale !== 1 || coverTracking !== 0) && (
                          <button
                            type="button"
                            className="link-btn small"
                            onClick={() => {
                              setCoverScale(1);
                              setCoverTracking(0);
                            }}
                          >
                            还原
                          </button>
                        )}
                      </div>
                    )}
                  </>
                ) : preparedValid ? (
                  <>
                    <button type="button" className="icon-btn sm" onClick={togglePreviewPlay} title={pvPlaying ? "暂停" : "播放"}>
                      {pvPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
                    </button>
                    <button
                      type="button"
                      className={`icon-btn sm${soundBlocked && pvMuted ? " vclip-unmute" : ""}`}
                      onClick={() => {
                        setSoundBlocked(false);
                        setPvMuted(!pvMuted);
                        if (videoRef.current) {
                          videoRef.current.muted = !pvMuted;
                          void videoRef.current.play().catch(() => {});
                        }
                      }}
                    >
                      {pvMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                      {soundBlocked && pvMuted && <span>点这里开声音</span>}
                    </button>
                    <span className="num small muted nowrap">
                      {clock(pvTime / speed)} / {clock(clipDur / speed)}
                    </span>
                    <div className="vclip-speed" role="group" aria-label="成片倍速">
                      {SPEEDS.map((r) => (
                        <button
                          key={r}
                          type="button"
                          className={r === speed ? "on" : ""}
                          onClick={() => setSpeed(r)}
                        >
                          {r}×
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <span className="small muted">
                    {montage ? `${parts.length} 段拼接` : `${clock(clipStart)} – ${clock(clipEnd)}`} ·{" "}
                    {Math.round(clipDur)}s
                  </span>
                )}
                <span className="spacer" />
              </div>
            </div>

            <div className="vclip-side">
              <div className="vclip-tabs">
                <Seg
                  value={sideTab}
                  options={[
                    ["clip", "正片"],
                    ["cover", "封面"],
                    ["copy", "文案"],
                  ]}
                  onChange={switchSideTab}
                />
              </div>

              {sideTab === "clip" && (
                <>
                  <section className="vclip-sec">
                    <div className="reading-row">
                      <span>画面比例</span>
                      <Seg
                        value={aspect}
                        options={[
                          ["source", "原视频"],
                          ["9:16", "9:16"],
                          ["3:4", "3:4"],
                          ["1:1", "1:1"],
                          ["16:9", "16:9"],
                        ]}
                        onChange={setAspect}
                      />
                    </div>
                    {aspect !== "source" && (
                      <div className="reading-row">
                        <span>画面放法</span>
                        <Seg
                          value={fit}
                          options={[
                            ["card", "完整画面"],
                            ["fill", "铺满裁切"],
                          ]}
                          onChange={setFit}
                        />
                      </div>
                    )}
                    {aspect !== "source" && fit === "card" && (
                      <div className="reading-row">
                        <span>画面裁成</span>
                        <Seg
                          value={cardCrop}
                          options={[
                            ["none", "完整"],
                            ["4:3", "4:3"],
                            ["1:1", "1:1"],
                          ]}
                          onChange={setCardCrop}
                        />
                      </div>
                    )}
                    {aspect !== "source" && fit === "card" && (
                      <div className="reading-row">
                        <span>卡片底色</span>
                        <Seg
                          value={cardBg}
                          options={[
                            ["blur", "画面模糊"],
                            ["night", "墨夜"],
                            ["paper", "纸白"],
                          ]}
                          onChange={setCardBg}
                        />
                      </div>
                    )}
                    {((!card && aspect !== "source") || geo.cropBox) && (
                      <div className="reading-row">
                        <span>水平取景</span>
                        <div className="vclip-crop-row">
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.02}
                            value={cropX}
                            onChange={(e) => setCropX(Number(e.target.value))}
                          />
                          <span className="num small muted">{Math.round(cropX * 100)}%</span>
                        </div>
                      </div>
                    )}
                    <label className="vclip-sub-toggle">
                      <input
                        type="checkbox"
                        checked={addSubs}
                        onChange={(e) => setAddSubsPick(e.target.checked)}
                      />
                      加字幕
                      {prepared?.hasBurnedSubtitles && (
                        <span className="muted small">原视频已有字幕，默认不加</span>
                      )}
                    </label>
                    {addSubs && (
                      <div className="reading-row">
                        <span>字幕语言</span>
                        <Seg
                          value={subLang}
                          options={
                            hasZh
                              ? [
                                  ["bilingual", "双语"],
                                  ["translation", "中文"],
                                  ["original", "原文"],
                                ]
                              : [["original", "原文"]]
                          }
                          onChange={setSubLang}
                        />
                      </div>
                    )}
                    {addSubs && (
                      <div className="vclip-styles">
                        {SUB_STYLES.map((st) => (
                          <button
                            key={st.id}
                            type="button"
                            className={`vclip-style-btn ${subStyle === st.id ? "on" : ""}`}
                            onClick={() => setSubStyle(st.id)}
                          >
                            <span className="vclip-swatch" style={{ background: st.swatchBg, color: st.swatchFg }}>
                              Aa
                            </span>
                            <span>{st.name}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {addSubs && (
                      <div className="reading-row">
                        <span>字幕大小</span>
                        <div className="vclip-crop-row">
                          <input
                            type="range"
                            min={0.7}
                            max={1.5}
                            step={0.05}
                            value={subScale}
                            onChange={(e) => setSubScale(Number(e.target.value))}
                          />
                          <span className="num small muted">{Math.round(subScale * 100)}%</span>
                        </div>
                      </div>
                    )}
                    <div className="vclip-toggles">
                      <label>
                        <input
                          type="checkbox"
                          checked={showTitle}
                          onChange={(e) => setShowTitle(e.target.checked)}
                        />{" "}
                        顶部金句标题
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={showSource}
                          onChange={(e) => setShowSource(e.target.checked)}
                        />{" "}
                        节目出处
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={watermark}
                          onChange={(e) => setWatermark(e.target.checked)}
                        />{" "}
                        声译水印
                      </label>
                      {!card && addSubs && prepared?.hasBurnedSubtitles && (
                        <label>
                          <input
                            type="checkbox"
                            checked={liftBurned}
                            onChange={(e) => setLiftBurned(e.target.checked)}
                          />{" "}
                          避让原字幕
                        </label>
                      )}
                    </div>
                    {showTitle && (
                      <input
                        className="vclip-title-input"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="切片顶部金句标题"
                      />
                    )}
                    <input
                      className="vclip-title-input"
                      value={brandText}
                      onChange={(e) => setBrandText(e.target.value)}
                      placeholder="底部署名（可选）"
                    />
                  </section>

                  <details className="vclip-sec vclip-adv">
                    <summary className="vclip-sec-head">
                      <span className="vclip-label">微调起止与字幕文字</span>
                      <span className="num small muted">
                        {montage
                          ? `${parts.length} 段拼接`
                          : `${clock(clipStart)} – ${clock(clipEnd)}`}{" "}
                        · {Math.round(clipDur)}s
                      </span>
                    </summary>
                    {!montage && (
                      <div className="vclip-bound-btns">
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={startIdx <= 0}
                          onClick={() => setStartIdx((i) => Math.max(0, i - 1))}
                        >
                          <Plus size={12} /> 前一句
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={startIdx >= endIdx}
                          onClick={() => setStartIdx((i) => Math.min(endIdx, i + 1))}
                        >
                          <Minus size={12} /> 缩首句
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={endIdx <= startIdx}
                          onClick={() => setEndIdx((i) => Math.max(startIdx, i - 1))}
                        >
                          <Minus size={12} /> 缩尾句
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={endIdx >= segments.length - 1}
                          onClick={() => setEndIdx((i) => Math.min(segments.length - 1, i + 1))}
                        >
                          <Plus size={12} /> 后一句
                        </button>
                      </div>
                    )}
                    <div className="vclip-pads">
                      <label className="small muted">
                        开头留白{" "}
                        <input
                          type="range"
                          min={-0.3}
                          max={1.0}
                          step={0.05}
                          value={padBefore}
                          onChange={(e) => setPadBefore(Number(e.target.value))}
                        />
                        <span className="num">{padBefore.toFixed(2)}s</span>
                      </label>
                      <label className="small muted">
                        结尾留白{" "}
                        <input
                          type="range"
                          min={-0.3}
                          max={1.2}
                          step={0.05}
                          value={padAfter}
                          onChange={(e) => setPadAfter(Number(e.target.value))}
                        />
                        <span className="num">{padAfter.toFixed(2)}s</span>
                      </label>
                    </div>
                    <div className="vclip-lines">
                      {clipLineIdx.map((idx, k) => {
                        const seg = segments[idx];
                        const partBreak = montage && k > 0 && clipLineIdx[k - 1] !== idx - 1;
                        const zhText = effectiveZh[idx] ?? "";
                        const origText = effectiveSegments[idx]?.text ?? seg.text;
                        const isEditing = editingIdx === idx;
                        const isActive = activePreviewIdx === idx;
                        return (
                          <div
                            key={idx}
                            className={`vclip-line ${isActive ? "on" : ""}${partBreak ? " part-start" : ""}`}
                            onClick={() => {
                              setActivePreviewIdx(idx);
                              if (preparedValid && videoRef.current && prepared) {
                                videoRef.current.currentTime =
                                  prepared.lead + toClipTime(idx, seg.start) + 0.05;
                              }
                            }}
                          >
                            <span className="num vclip-lt">{clock(seg.start)}</span>
                            <div className="vclip-lbody">
                              {isEditing ? (
                                <div className="vclip-edit-box" onClick={(e) => e.stopPropagation()}>
                                  {hasZh && (
                                    <input
                                      value={zhText}
                                      placeholder="中文译文"
                                      onChange={(e) => setZhEdits((m) => ({ ...m, [idx]: e.target.value }))}
                                    />
                                  )}
                                  <input
                                    value={origText}
                                    placeholder="原文"
                                    onChange={(e) => setOrigEdits((m) => ({ ...m, [idx]: e.target.value }))}
                                  />
                                  <div className="vclip-edit-actions">
                                    <button
                                      type="button"
                                      className="btn ghost sm"
                                      onClick={() => {
                                        setZhEdits((m) => {
                                          const n = { ...m };
                                          delete n[idx];
                                          return n;
                                        });
                                        setOrigEdits((m) => {
                                          const n = { ...m };
                                          delete n[idx];
                                          return n;
                                        });
                                      }}
                                    >
                                      <RotateCcw size={11} /> 还原
                                    </button>
                                    <button
                                      type="button"
                                      className="btn primary sm"
                                      onClick={() => setEditingIdx(null)}
                                    >
                                      <Check size={11} /> 完成
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  {zhText && <p className="vclip-lzh">{zhText}</p>}
                                  <p className="vclip-lorig">{origText}</p>
                                </>
                              )}
                            </div>
                            {!isEditing && (
                              <button
                                type="button"
                                className="link-btn vclip-edit-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditingIdx(idx);
                                }}
                              >
                                改字
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </details>
                </>
              )}

              {sideTab === "cover" && (
                <>
                  <section className="vclip-sec">
                    <div className="vclip-sec-head">
                      <span className="vclip-label">封面视觉模板</span>
                      <span className="small muted">用【】包住关键词自动高亮</span>
                    </div>
                    <div className="vclip-tpl-grid">
                      {COVER_TEMPLATES.map((tpl) => (
                        <button
                          key={tpl.id}
                          type="button"
                          className={`vclip-tpl-btn ${coverTpl === tpl.id ? "on" : ""}`}
                          onClick={() => setCoverTpl(tpl.id)}
                        >
                          <span className="vclip-tpl-swatch">
                            {tplThumbs[tpl.id] ? (
                              <img src={tplThumbs[tpl.id]} alt="" />
                            ) : (
                              <Loader2 size={12} className="spin muted" />
                            )}
                          </span>
                          <span>{tpl.name}</span>
                        </button>
                      ))}
                    </div>
                    <input
                      className="vclip-title-input"
                      value={coverHook}
                      onChange={(e) => setCoverHook(e.target.value)}
                      placeholder="封面大字，如：未来三年，【会提问的人】胜出"
                    />
                    <div className="vclip-cover-inputs">
                      <input
                        className="vclip-title-input"
                        value={coverSub}
                        onChange={(e) => setCoverSub(e.target.value)}
                        placeholder="副标题（可选）"
                      />
                      <input
                        className="vclip-title-input"
                        value={coverKicker}
                        onChange={(e) => setCoverKicker(e.target.value)}
                        placeholder="顶部眉标（节目名）"
                      />
                    </div>
                  </section>

                  <section className="vclip-sec">
                    <div className="vclip-sec-head">
                      <span className="vclip-label">封面背景剧照</span>
                      {!preparedValid && (
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={!!busyJob}
                          onClick={() => {
                            autoPrepared.current = "";
                            prepShared.current = null;
                            void ensurePrepared(true);
                          }}
                        >
                          <ImageIcon size={12} /> 提取高清剧照
                        </button>
                      )}
                    </div>
                    {prepared?.frames.length ? (
                      <div className="vclip-frames">
                        {prepared.frames.map((src, idx) => (
                          <button
                            key={idx}
                            type="button"
                            className={`vclip-frame-btn ${activeFrameIdx === idx ? "on" : ""}`}
                            onClick={() => setSelectedFrame(idx)}
                          >
                            <img src={src} alt="" />
                            {idx === prepared.bestFrame && (
                              <span className="vclip-frame-best">推荐</span>
                            )}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="muted small">默认使用节目封面；导出时会自动抽取本段最佳帧。</p>
                    )}
                  </section>

                  <section className="vclip-sec">
                    <div className="reading-row">
                      <span>MP4 片头封面</span>
                      <Seg
                        value={coverMode}
                        options={[
                          ["flash", "隐形首帧"],
                          ["hold", "定格 1 秒"],
                          ["none", "不压片头"],
                        ]}
                        onChange={setCoverMode}
                      />
                    </div>
                    <p className="muted small">
                      {coverMode === "flash"
                        ? "开头 0.14 秒隐形放入爆款封面：小红书/视频号/抖音/B站自动抓第 0 帧当封面，播放几乎无感且不吞字。"
                        : coverMode === "hold"
                          ? "片头静态展示 1 秒爆款封面后再开讲，音画同步顺延，适合直接发朋友圈与公众号视频。"
                          : "正片开头不压封面，仅通过下方选项内嵌缩略图或保存独立封面 PNG。"}
                    </p>
                    <div className="vclip-toggles">
                      <label>
                        <input
                          type="checkbox"
                          checked={embedThumbnail}
                          onChange={(e) => setEmbedThumbnail(e.target.checked)}
                        />{" "}
                        内嵌视频缩略图
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={saveCoverSidecar}
                          onChange={(e) => setSaveCoverSidecar(e.target.checked)}
                        />{" "}
                        同目录保存封面 PNG
                      </label>
                      {videoCoverAspect !== "16:9" && saveCoverSidecar && (
                        <label>
                          <input
                            type="checkbox"
                            checked={extraLandscapeCover}
                            onChange={(e) => setExtraLandscapeCover(e.target.checked)}
                          />{" "}
                          附带 16:9 横版封面（公众号/B站）
                        </label>
                      )}
                    </div>
                    <div className="vclip-cover-actions">
                      <button type="button" className="btn ghost sm" onClick={() => void copyCoverImage()}>
                        <Copy size={12} /> 复制封面图
                      </button>
                      <button type="button" className="btn ghost sm" onClick={() => void saveCoverImage()}>
                        <ImageIcon size={12} /> 保存当前封面
                      </button>
                      <button type="button" className="btn ghost sm" onClick={() => void saveCoverImage("3:4")}>
                        <ImageIcon size={12} /> 保存 3:4 小红书封面
                      </button>
                    </div>
                  </section>
                </>
              )}

              {sideTab === "copy" && (
                <section className="vclip-sec vclip-copy-sec">
                  <div className="vclip-sec-head">
                    <Seg
                      value={postPlatform}
                      options={[
                        ["short", "短视频"],
                        ["article", "视频文章"],
                        ["social", "X · 推文"],
                      ]}
                      onChange={setPostPlatform}
                    />
                    <div className="row-actions tight">
                      {postEdits[postPlatform] !== undefined && (
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() =>
                            setPostEdits((m) => {
                              const n = { ...m };
                              delete n[postPlatform];
                              return n;
                            })
                          }
                        >
                          还原
                        </button>
                      )}
                      <button type="button" className="btn sm" onClick={() => void copyCurrentPost()}>
                        <Copy size={12} /> 复制文案
                      </button>
                    </div>
                  </div>
                  {polishing ? (
                    <p className="vclip-writing small">
                      <Loader2 size={12} className="spin" /> AI 正在写发布文案…
                    </p>
                  ) : (
                    <button type="button" className="link-btn small vclip-again" onClick={() => void runAiPolish(true, true)}>
                      换一版
                    </button>
                  )}
                  <p className="muted small">
                    {postPlatform === "short"
                      ? "适配小红书、微信视频号、抖音、B站：直接粘贴标题、推荐钩子与标签。"
                      : postPlatform === "article"
                        ? "适配公众号文章、即刻、知乎：包含观点导读、双语原话摘录与回跳出处。"
                        : "适配 X / 朋友圈：精炼一句话钩子 + 金句原话 + 跳转链接。"}
                  </p>
                  <textarea
                    className="vclip-post-box"
                    value={currentPostText}
                    onChange={(e) => setPostEdits((m) => ({ ...m, [postPlatform]: e.target.value }))}
                  />
                </section>
              )}

              {error && (
                <div className="vclip-err-row">
                  <p className="error-text">{error}</p>
                  {!needsSetup && !busyJob && (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        autoPrepared.current = "";
                        prepShared.current = null;
                        void ensurePrepared(true);
                      }}
                    >
                      重试获取画面
                    </button>
                  )}
                  {needsSetup && (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        requestClose();
                        set({ settingsOpen: true, settingsSection: "ai" });
                      }}
                    >
                      去设置
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="modal-foot vclip-foot">
          {busyJob ? (
            <div className="vclip-foot-progress" role="status">
              <div className="vclip-foot-row">
                <span className="vclip-step">
                  {busyJob.stage === "render" ? "第 2/2 步 · 合成视频" : "第 1/2 步 · 获取画面"}
                </span>
                <span className="muted small clamp1">{busyJob.message}</span>
                <span className="num">{Math.round(busyJob.progress * 100)}%</span>
                <button type="button" className="link-btn" onClick={cancelBusyJob}>
                  取消
                </button>
              </div>
              <div className="bar live">
                <div style={{ width: `${Math.max(3, busyJob.progress * 100)}%` }} />
              </div>
            </div>
          ) : exported ? (
            <div className="vclip-foot-done">
              <span className="vclip-done-mark">
                <Check size={14} strokeWidth={3} /> 已导出
              </span>
              <button
                type="button"
                className="btn sm"
                onClick={() => void api.revealFile(exported.videoPath).catch((e) => notify(errText(e)))}
              >
                <FolderOpen size={13} /> 在文件夹中显示
              </button>
              <button type="button" className="btn ghost sm" onClick={() => void copyCurrentPost()}>
                <Copy size={13} /> 复制文案
              </button>
              <button type="button" className="btn ghost sm" onClick={() => void copyCoverImage()}>
                <ImageIcon size={13} /> 复制封面
              </button>
              <button type="button" className="btn ghost sm" onClick={restartClip}>
                重新剪辑
              </button>
            </div>
          ) : (
            <button type="button" className="btn ghost" onClick={() => void copyCurrentPost()}>
              <Copy size={14} /> 复制发布文案
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={requestClose}>
            关闭
          </button>
          <button type="button" className="btn" disabled={!!busyJob} onClick={() => void runExport(true)}>
            另存为…
          </button>
          <button type="button" className="btn primary" disabled={!!busyJob} onClick={() => void runExport(false)}>
            <Scissors size={14} /> 导出 MP4
          </button>
        </div>
      </div>
    </div>
  );
}