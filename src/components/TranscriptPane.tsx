/**
 * [INPUT]: jobs 字幕/译文/asr、asrModels、store；switchYoutubeTrack；SubtitleExport；highlights
 * [OUTPUT]: 右侧字幕面板（GenCard/导出/学英语/行列表）+「高光」子模式
 * [POS]: 听懂主路径；高光列表与行内标记；剪视频走 VideoClipDialog
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDown,
  Download,
  Ellipsis,
  Languages,
  ListChecks,
  Loader2,
  Mic,
  PenLine,
  Play,
  Scissors,
  Sparkles,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { api, errText, type Episode, type Segment } from "../lib/api";
import { useAsrModels, type AsrModel } from "../lib/asrModels";
import { looksEnglish } from "../lib/dict";
import { clock } from "../lib/format";
import {
  loadHighlights,
  previewEpisodeRange,
  useHighlights,
  type HighlightClip,
} from "../lib/highlights";
import { resolveLocale, tNow, useT } from "../lib/i18n";
import {
  cancelAsr,
  ensureTranscript,
  generateTranscript,
  looksChinese,
  switchYoutubeTrack,
  useJobs,
} from "../lib/jobs";
import { activeIndex, seekEpisode } from "../lib/playback";
import { activeCloudAsr, ASR_SERVICES, CLOUD_ASR_MAIN, type Settings } from "../lib/settings";
import { useStore } from "../store";
import { HighlightsPanel, useClipWarm } from "./HighlightViews";
import { CassetteArt, NightNote, TrayArt, WaveToTextArt } from "./Illustrations";
import { LearnText, LearnTip, WordCard, useLearnMarks, type CardTarget } from "./Learn";
import { Dictation, EpisodeWords, useShadowing } from "./LearnPractice";
import { SubtitleExport } from "./SubtitleExport";
import { openVideoClipDialog } from "./VideoClipDialog";

type Mode = "bilingual" | "translation" | "original";

const trackCache = new Map<string, { language: string; auto: boolean }[]>();
const autoStarted = new Set<string>();

function sourceLabel(source: string) {
  switch (source) {
    case "youtube":
      return tNow("YouTube 官方");
    case "youtube-auto":
      return tNow("YouTube 自动");
    case "qiaomu":
      return tNow("精读站原文");
    case "podscribe":
      return "Podscribe";
    case "cloud":
    case "openai":
      return tNow("云端识别");
    case "qwen3":
      return tNow("本机 Qwen3");
    case "whisper":
      return tNow("本机 Whisper");
    default:
      return source || tNow("字幕");
  }
}

function engineLabel(engine?: string) {
  if (engine === "youtube") return tNow("节目方中文字幕");
  if (engine === "google") return tNow("谷歌翻译");
  if (engine === "llm") return tNow("模型翻译");
  return null;
}

function sizeMb(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)} GB` : `${Math.round(n)} MB`;
}

function pickerModels(models: AsrModel[], s: Settings) {
  return models.filter(
    (m) => m.id === "qwen3-asr" || m.installed || (s.asrEngine === "local" && s.asrModel === m.id),
  );
}

function pickerCloud(s: Settings) {
  return ASR_SERVICES.filter((a) => CLOUD_ASR_MAIN.includes(a.id) || s.asrEngine === a.id);
}

function TrackPicker({
  episode,
  language,
  auto,
}: {
  episode: Episode;
  language: string;
  auto: boolean;
}) {
  const t = useT();
  const uiLang = useStore((s) => s.settings.uiLang);
  const notify = useStore((s) => s.notify);
  const [tracks, setTracks] = useState(trackCache.get(episode.id) ?? null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("pointerdown", h);
      document.removeEventListener("keydown", k);
    };
  }, [open]);

  useEffect(() => {
    setTracks(trackCache.get(episode.id) ?? null);
    setOpen(false);
  }, [episode.id]);

  useEffect(() => {
    if (tracks || !episode.videoId) return;
    let live = true;
    void api
      .youtubeTracks(episode.id)
      .then((list) => {
        trackCache.set(episode.id, list);
        if (live) setTracks(list);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [episode.id, episode.videoId, tracks]);

  if (!tracks || tracks.length < 2) return null;

  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([resolveLocale(uiLang)], { type: "language" });
  } catch {
    /* old WebView */
  }
  const name = (l: string) => {
    try {
      return names?.of(l) ?? l;
    } catch {
      return l;
    }
  };
  const label = (x: { language: string; auto: boolean }) =>
    `${name(x.language)}${x.auto ? ` · ${t("自动")}` : ""}`;

  const pick = async (x: { language: string; auto: boolean }) => {
    setOpen(false);
    if (x.language === language && x.auto === auto) return;
    setBusy(true);
    try {
      await switchYoutubeTrack(episode, x.language, x.auto);
    } catch (e) {
      notify(t("切换字幕失败：{msg}", { msg: errText(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel-menu" ref={box}>
      <button
        type="button"
        className="track-pick"
        title={t("字幕语言")}
        aria-label={t("字幕语言")}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen(!open)}
      >
        {busy ? <Loader2 size={13} className="spin" /> : <Languages size={14} />}
        <span>{label({ language, auto })}</span>
        <ChevronDown size={12} className={open ? "flip" : ""} />
      </button>
      {open && (
        <div className="panel-menu-pop" role="menu">
          {tracks.map((x) => {
            const on = x.language === language && x.auto === auto;
            return (
              <button
                key={`${x.auto}:${x.language}`}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                className={on ? "on" : ""}
                onClick={() => void pick(x)}
              >
                {label(x)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NoTranscript({
  ep,
  official,
  officialError,
}: {
  ep: Episode;
  official: string;
  officialError?: string;
}) {
  const t = useT();
  const notify = useStore((s) => s.notify);
  const set = useStore((s) => s.set);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const playing = useStore((s) => s.playing && s.current?.id === ep.id);
  const player = useStore((s) => s.player);
  const current = useStore((s) => s.current);
  const { settings, saveSettings } = useStore(
    useShallow((s) => ({ settings: s.settings, saveSettings: s.saveSettings })),
  );
  const openAsrSettings = () => set({ settingsOpen: true, settingsSection: "subtitles" });
  const { asrRunning, asrProgress, asrError } = useJobs(
    useShallow((s) => ({
      asrRunning: s.asrRunning[ep.id],
      asrProgress: s.asrProgress[ep.id],
      asrError: s.asrError[ep.id],
    })),
  );
  const { models, downloading, refresh, download, cancelDownload } = useAsrModels(
    useShallow((s) => ({
      models: s.models,
      downloading: s.downloading,
      refresh: s.refresh,
      download: s.download,
      cancelDownload: s.cancelDownload,
    })),
  );
  const [options, setOptions] = useState(false);
  const [cloudKey, setCloudKey] = useState<boolean | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const model = models.find((m) => m.id === settings.asrModel) ?? models[0];
  const cloud = settings.asrEngine !== "local" ? activeCloudAsr(settings) : undefined;
  const dlId = model && downloading[model.id] != null ? model.id : Object.keys(downloading)[0];
  const dlPct = dlId != null ? downloading[dlId] : undefined;

  useEffect(() => {
    setCloudKey(null);
    if (cloud?.needsKey && !settingsOpen) {
      void api.hasApiKey(`asr.${cloud.id}`).then(setCloudKey);
    }
  }, [cloud?.id, cloud?.needsKey, settingsOpen]);

  const missingKey = !!cloud?.needsKey && cloudKey === false;
  const ready = !!model && (cloud ? cloudKey === true || !cloud.needsKey : !!model.installed);

  const pickEngine = (value: string) => {
    if (value === "more") {
      openAsrSettings();
      return;
    }
    const [kind, id] = value.split(":");
    void saveSettings(kind === "cloud" ? { asrEngine: id } : { asrEngine: "local", asrModel: id });
  };

  const generate = async () => {
    if (!model) return;
    if (missingKey) {
      openAsrSettings();
      return;
    }
    if (!cloud && !model.installed) {
      try {
        await download(model.id);
      } catch (e) {
        notify(errText(e));
        return;
      }
    }
    void generateTranscript(ep).catch((e) => notify(errText(e)));
  };

  // 官方已确认没有、识别就绪且正在播放：自动开识别（本会话每集一次）
  useEffect(() => {
    if (
      playing &&
      ready &&
      official === "none" &&
      !asrRunning &&
      !asrError &&
      !autoStarted.has(ep.id)
    ) {
      autoStarted.add(ep.id);
      void generateTranscript(ep).catch(() => {
        autoStarted.delete(ep.id);
      });
    }
  }, [playing, ready, official, asrRunning, asrError, ep.id]);

  const stopRunning = async () => {
    await cancelAsr(ep.id);
    useJobs.setState((s) => ({
      asrRunning: { ...s.asrRunning, [ep.id]: false },
      asrError: { ...s.asrError, [ep.id]: undefined },
      asrProgress: { ...s.asrProgress, [ep.id]: undefined },
    }));
  };

  const switchEngine = async (value: string) => {
    if (value === "more") {
      openAsrSettings();
      return;
    }
    const [kind, id] = value.split(":");
    await saveSettings(kind === "cloud" ? { asrEngine: id } : { asrEngine: "local", asrModel: id });
    if (asrRunning) await stopRunning();
    const m = kind === "cloud" ? models.find((x) => x.id === settings.asrModel) ?? models[0] : models.find((x) => x.id === id);
    if (!m) return;
    if (kind !== "cloud" && !m.installed) {
      try {
        await download(m.id);
      } catch (e) {
        notify(errText(e));
        return;
      }
    }
    void generateTranscript(ep).catch((e) => notify(errText(e)));
  };

  if (official === "searching" || official === "idle") {
    return (
      <div className="transcript">
        <div className="status-line">
          <Loader2 size={14} className="spin" />
          <span className="status-text">{t("正在查找字幕…")}</span>
        </div>
        <div className="gen-wrap">
          <div className="gen-card">
            <div className="gen-skel" aria-hidden>
              <span />
              <span />
              <span />
            </div>
            <p className="gen-note">{t("先看节目有没有自带字幕…")}</p>
          </div>
        </div>
      </div>
    );
  }

  if (dlPct != null && dlId) {
    const pct = Math.round(dlPct * 100);
    return (
      <GenCard
        icon={<TrayArt busy />}
        title={t("正在准备识别模型")}
        note={t("只需下载这一次，完成后自动生成字幕。可以先听着。")}
      >
        <div className="gen-progress">
          <div className="bar live">
            <div style={{ width: `${Math.max(2, pct)}%` }} />
          </div>
          <span>{pct}%</span>
        </div>
        <button type="button" className="btn ghost sm" onClick={() => void cancelDownload(dlId)}>
          {t("取消")}
        </button>
      </GenCard>
    );
  }

  if (asrRunning || (asrProgress && asrProgress.stage !== "done" && asrProgress.stage !== "error")) {
    const live = asrProgress?.live ?? [];
    const pct = Math.round((asrProgress?.progress ?? 0) * 100);
    const label =
      asrProgress?.message ||
      (asrProgress?.stage === "download" ? t("正在获取音频") : t("正在识别"));
    return (
      <div className="transcript">
        <div className="status-line">
          <Loader2 size={14} className="spin" />
          <span className="status-text">
            {label} · {pct}%
          </span>
          <span className="row-actions tight">
            <select
              className="engine-switch-mini"
              aria-label={t("换一种识别方式")}
              title={t("换一种识别方式（从头开始）")}
              value=""
              onChange={(e) => e.target.value && void switchEngine(e.target.value)}
            >
              <option value="">{t("换一种方式…")}</option>
              <optgroup label={t("本机模型 · 音频不出本机")}>
                {pickerModels(models, settings)
                  .filter((m) => !(settings.asrEngine === "local" && settings.asrModel === m.id))
                  .map((m) => (
                    <option key={m.id} value={`local:${m.id}`}>
                      {m.name}
                      {m.installed ? "" : ` · ${sizeMb(m.sizeMb)}`}
                    </option>
                  ))}
              </optgroup>
              <optgroup label={t("云端服务 · 更快，需要 Key")}>
                {pickerCloud(settings)
                  .filter((a) => settings.asrEngine !== a.id)
                  .map((a) => (
                    <option key={a.id} value={`cloud:${a.id}`}>
                      {t(a.name)}
                    </option>
                  ))}
              </optgroup>
              <option value="more">{t("更多…")}</option>
            </select>
            <button type="button" className="btn ghost sm" onClick={() => void stopRunning()}>
              {t("取消")}
            </button>
          </span>
        </div>
        <div className="lines">
          {live.map((s, i) => (
            <div
              className="line live"
              key={`${s.start}-${i}`}
              role="button"
              tabIndex={0}
              onClick={() => current?.id === ep.id && player?.seek(s.start)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  current?.id === ep.id && player?.seek(s.start);
                }
              }}
            >
              <span className="line-time">{clock(s.start)}</span>
              <div className="line-text">
                <p className="orig">
                  {s.text}
                  {i === live.length - 1 && <span className="live-caret" aria-hidden />}
                </p>
              </div>
            </div>
          ))}
          {!live.length && (
            <div className="asr-wait">
              <CassetteArt mode={asrProgress?.stage === "download" ? "fetch" : "listen"} />
              <p className="muted">
                {asrProgress?.stage === "download"
                  ? t("先把音频取回来，马上开始听写")
                  : asrProgress?.message?.includes("解码")
                    ? t("正在把音频转成识别用的格式，稍等片刻")
                    : settings.asrModel === "qwen3-asr"
                      ? t("识别完成后会一次性显示全部文字")
                      : t("识别出的文字会实时出现在这里")}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (asrError) {
    return (
      <GenCard
        icon={<CassetteArt mode="tangled" />}
        title={t("字幕没有生成成功")}
        note={t("可以换一个识别模型，或检查网络后再试。")}
      >
        {asrError && (
          <p className="gen-warn" title={asrError}>
            <span>{plainError(asrError)}</span>
          </p>
        )}
        <button
          type="button"
          className="btn primary gen-go"
          onClick={() => {
            useJobs.setState((s) => ({
              asrError: { ...s.asrError, [ep.id]: undefined },
              asrProgress: { ...s.asrProgress, [ep.id]: undefined },
            }));
            void generate();
          }}
        >
          {t("重试")}
        </button>
      </GenCard>
    );
  }

  const needsDownload = !cloud && !!model && !model.installed;
  const canAsr = cloud ? !!ep.audioUrl : !!(ep.audioUrl || ep.videoId);

  return (
    <GenCard
      icon={<WaveToTextArt />}
      title={t("这集还没有字幕")}
      note={
        cloud
          ? t("用 {name} 生成，音频会上传到该服务，速度更快。生成后自动翻译成中文。", { name: t(cloud.name) })
          : t("用本机模型生成，音频只在这台电脑上处理。生成后自动翻译成中文。")
      }
    >
      {official === "error" && officialError && (
        <p className="gen-warn" title={officialError}>
          <span>{t("节目自带的字幕没读到：{msg}", { msg: plainError(officialError) })}</span>
        </p>
      )}
      <button
        type="button"
        className="btn primary gen-go"
        disabled={!model || !canAsr}
        title={!canAsr ? (cloud ? t("这集没有音频地址，无法云端识别") : t("这集没有可识别的音频")) : undefined}
        onClick={() => void generate()}
      >
        {missingKey ? t("先填写 API Key") : t("生成字幕")}
      </button>
      {needsDownload && model && (
        <p className="gen-size">{t("第一次会先下载识别模型（约 {size}），之后不用再下载", { size: sizeMb(model.sizeMb) })}</p>
      )}
      {needsDownload &&
        (() => {
          const have = models.find((m) => m.installed && !m.from) ?? models.find((m) => m.installed);
          return have ? (
            <button
              type="button"
              className="link-btn gen-alt"
              onClick={() => void saveSettings({ asrEngine: "local", asrModel: have.id })}
            >
              {have.from
                ? t("改用 {from} 里已有的 {name}，不用下载", { from: have.from, name: have.name })
                : t("改用已下载的 {name}", { name: have.name })}
            </button>
          ) : null;
        })()}
      {missingKey && cloud && (
        <p className="gen-size">{t("用 {name} 识别需要它的 API Key，填好就能开始", { name: t(cloud.name) })}</p>
      )}
      <button
        type="button"
        className="link-btn gen-more"
        aria-expanded={options}
        onClick={() => setOptions(!options)}
      >
        {t("识别设置")}
        <ChevronDown size={12} className={options ? "flip" : ""} />
      </button>
      {!options && <NightNote />}
      {options && (
        <div className="gen-options">
          <label>
            <span>{t("识别方式")}</span>
            <select
              value={cloud ? `cloud:${cloud.id}` : `local:${model?.id ?? ""}`}
              onChange={(e) => pickEngine(e.target.value)}
            >
              <optgroup label={t("本机模型 · 音频不出本机")}>
                {pickerModels(models, settings).map((m) => (
                  <option key={m.id} value={`local:${m.id}`}>
                    {m.name}
                    {m.installed ? "" : ` · ${sizeMb(m.sizeMb)}`}
                  </option>
                ))}
              </optgroup>
              <optgroup label={t("云端服务 · 更快，需要 Key")}>
                {pickerCloud(settings).map((a) => (
                  <option key={a.id} value={`cloud:${a.id}`}>
                    {t(a.name)}
                  </option>
                ))}
              </optgroup>
              <option value="more">{t("更多…")}</option>
            </select>
          </label>
        </div>
      )}
    </GenCard>
  );
}

/** 错误文案可读化：长 URL 对听者无意义，完整内容留在 title。 */
const plainError = (m: string) => m.replace(/[：:]?\s*https?:\/\/\S+/g, "").trim() || m;

/** 无字幕时居中空态卡：插画 + 标题 + 说明 + 动作。 */
function GenCard({
  icon,
  title,
  note,
  children,
}: {
  icon: ReactNode;
  title: string;
  note: string;
  children?: ReactNode;
}) {
  return (
    <div className="transcript">
      <div className="gen-wrap">
        <div className="gen-card">
          <span className="gen-art" aria-hidden>
            {icon}
          </span>
          <h3 className="gen-title">{title}</h3>
          <p className="gen-note">{note}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

interface LearnMenuState {
  segments: Segment[];
  zh: (string | null | undefined)[] | undefined;
  active: number;
  shadow: boolean;
  setShadow: (v: boolean) => void;
  canShadow: boolean;
}

/** 「…」：外语导出 + 学英语工具。中文播客用栏上显式「导出」按钮。 */
function PanelMenu({
  ep,
  segments,
  zh,
  foreign,
  mode,
  source,
  learn,
}: {
  ep: Episode;
  segments: Segment[];
  zh?: (string | null | undefined)[];
  foreign: boolean;
  mode: Mode;
  source: string;
  learn?: LearnMenuState;
}) {
  const t = useT();
  const [menu, setMenu] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [words, setWords] = useState(false);
  const [dictation, setDictation] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return (
    <div className="panel-menu" ref={box}>
      <button
        type="button"
        className="icon-btn"
        title={t("更多")}
        aria-label={t("更多")}
        aria-expanded={menu}
        onClick={() => setMenu(!menu)}
      >
        <Ellipsis size={15} />
      </button>
      {menu && (
        <div className="panel-menu-pop right" role="menu">
          {learn && (
            <>
              <button type="button" role="menuitem" onClick={() => { setMenu(false); setWords(true); }}>
                <ListChecks size={14} /> {t("本期生词…")}
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={learn.shadow}
                disabled={!learn.canShadow}
                title={learn.canShadow ? undefined : t("先播放这一集")}
                onClick={() => {
                  setMenu(false);
                  learn.setShadow(!learn.shadow);
                }}
              >
                <Mic size={14} /> {learn.shadow ? t("退出跟读模式") : t("跟读模式")}
              </button>
              <button type="button" role="menuitem" onClick={() => { setMenu(false); setDictation(true); }}>
                <PenLine size={14} /> {t("听写练习…")}
              </button>
              <div className="menu-sep" role="separator" />
            </>
          )}
          {foreign && (
            <button type="button" role="menuitem" onClick={() => { setMenu(false); setExporting(true); }}>
              <Download size={14} /> {t("导出字幕…")}
            </button>
          )}
        </div>
      )}
      {exporting && (
        <SubtitleExport
          episode={ep}
          segments={segments}
          translations={zh}
          foreign={foreign}
          mode={mode}
          sourceLabel={sourceLabel(source)}
          onClose={() => setExporting(false)}
        />
      )}
      {words && learn && (
        <EpisodeWords ep={ep} segments={learn.segments} zh={learn.zh} onClose={() => setWords(false)} />
      )}
      {dictation && learn && (
        <Dictation
          ep={ep}
          segments={learn.segments}
          from={Math.max(0, learn.active)}
          onClose={() => setDictation(false)}
        />
      )}
    </div>
  );
}

export function TranscriptPane({ episode }: { episode: Episode }) {
  const t = useT();
  const time = useStore((s) => s.time);
  const currentId = useStore((s) => s.current?.id);
  const { subtitleMode, learnOn, learnCard } = useStore(
    useShallow((s) => ({
      subtitleMode: s.settings.subtitleMode,
      learnOn: s.settings.learnOn,
      learnCard: s.settings.learnCard,
    })),
  );
  const saveSettings = useStore((s) => s.saveSettings);
  const { transcript, official, error, translation } = useJobs(
    useShallow((s) => ({
      transcript: s.transcripts[episode.id],
      official: s.official[episode.id] ?? "idle",
      error: s.officialError[episode.id],
      translation: s.translations[episode.id],
    })),
  );
  const mode: Mode = subtitleMode;
  const listRef = useRef<HTMLDivElement>(null);
  const setMode = (next: Mode) => void saveSettings({ subtitleMode: next });
  const [card, setCard] = useState<CardTarget | null>(null);
  const [shadow, setShadow] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showHighlights, setShowHighlights] = useState(false);
  const closeCard = useCallback(() => setCard(null), []);
  const hlBundle = useHighlights((s) => s.bundles[episode.id]);
  const hlLoading = useHighlights((s) => !!s.loading[episode.id]);

  useEffect(() => {
    void ensureTranscript(episode);
  }, [episode.id]);

  useEffect(() => {
    setShowHighlights(false);
    setCard(null);
    setShadow(false);
    void loadHighlights(episode.id);
  }, [episode.id]);

  const isCurrent = currentId === episode.id;
  const segs = transcript?.segments ?? [];
  useClipWarm(episode, segs);
  const starts = useMemo(() => segs.map((s) => s.start), [segs]);
  const active = isCurrent && segs.length ? activeIndex(starts, time) : -1;
  const zhItems = translation?.items;

  const hlStarts = useMemo(() => {
    const map = new Map<number, HighlightClip>();
    for (const c of hlBundle?.clips ?? []) {
      if (!map.has(c.startIdx)) map.set(c.startIdx, c);
    }
    return map;
  }, [hlBundle]);

  const hlRange = useMemo(() => {
    const cover = new Set<number>();
    for (const c of hlBundle?.clips ?? []) {
      for (let i = c.startIdx; i <= c.endIdx; i++) cover.add(i);
    }
    return cover;
  }, [hlBundle]);

  const onHlPreview = useCallback(
    (c: HighlightClip) => previewEpisodeRange(episode, c.start, c.end),
    [episode],
  );
  const onHlClip = useCallback(
    (c: HighlightClip) => openVideoClipDialog({ ep: episode, segments: segs, zh: zhItems, clip: c }),
    [episode, segs, zhItems],
  );
  const rowVirtualizer = useVirtualizer({
    count: segs.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 68,
    overscan: 8,
  });

  const jumpFromHl = useCallback(
    (index: number, t: number) => {
      setShowHighlights(false);
      seekEpisode(episode, t);
      requestAnimationFrame(() => {
        rowVirtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
      });
    },
    [episode, rowVirtualizer],
  );
  const foreign = useMemo(
    () =>
      transcript
        ? !looksChinese(transcript.language, segs.slice(0, 3).map((s) => s.text).join(""))
        : false,
    [transcript, segs],
  );
  const english = useMemo(
    () =>
      transcript
        ? looksEnglish(transcript.language, segs.slice(0, 20).map((x) => x.text).join(" "))
        : false,
    [transcript, segs],
  );
  const marks = useLearnMarks(english);
  const learning = !!marks || (english && learnOn);
  const zhTag = engineLabel(translation?.engine);

  useShadowing(shadow && isCurrent, episode.id, segs);
  useEffect(() => {
    if (!learning) setShadow(false);
  }, [learning]);

  useEffect(() => {
    if (!isCurrent || active < 0 || showHighlights) return;
    rowVirtualizer.scrollToIndex(active, { align: "auto", behavior: "smooth" });
  }, [active, isCurrent, showHighlights, rowVirtualizer]);

  const onWordClick = (e: React.MouseEvent) => {
    if (!marks || !learnCard) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>(".lw");
    if (!el || window.getSelection()?.toString()) return;
    const i = Number(el.closest<HTMLElement>("[data-i]")?.dataset.i);
    const seg = segs[i];
    if (!seg) return;
    e.stopPropagation();
    e.preventDefault();
    setCard({
      el,
      token: el.textContent ?? "",
      seg,
      zh: typeof translation?.items?.[i] === "string" ? translation.items[i] : null,
    });
  };

  // 与原站一致：有字幕先渲染行；无字幕才进查找 / GenCard
  if (!segs.length) {
    return <NoTranscript ep={episode} official={official} officialError={error} />;
  }

  return (
    <div className="transcript">
      <div className="panel-bar">
        <span className="source-tag">{sourceLabel(transcript!.source)}</span>
        {zhTag && foreign && <span className="source-tag muted">{zhTag}</span>}
        {episode.videoId && transcript && (
          <TrackPicker
            episode={episode}
            language={transcript.language}
            auto={transcript.source === "youtube-auto"}
          />
        )}
        <div className="spacer" />
        <button
          type="button"
          className={`hl-toggle ${showHighlights ? "on" : ""} ${hlBundle?.clips.length ? "has" : ""}`}
          title={t("高光金句片段")}
          aria-pressed={showHighlights}
          onClick={() => setShowHighlights((v) => !v)}
        >
          <Sparkles size={13} />
          <span>{t("高光")}</span>
          {(hlBundle?.clips.length || hlLoading) && (
            <span className="hl-badge">{hlLoading ? "…" : hlBundle?.clips.length}</span>
          )}
        </button>
        {!foreign && (
          <button
            type="button"
            className="track-pick"
            title={t("导出字幕")}
            aria-label={t("导出字幕")}
            disabled={!segs.length}
            onClick={() => setExporting(true)}
          >
            <Download size={14} />
            <span>{t("导出")}</span>
          </button>
        )}
        {(foreign || learning) && (
          <PanelMenu
            ep={episode}
            segments={segs}
            zh={translation?.items}
            foreign={foreign}
            mode={mode}
            source={transcript!.source}
            learn={
              learning
                ? {
                    segments: segs,
                    zh: translation?.items,
                    active,
                    shadow,
                    setShadow,
                    canShadow: isCurrent,
                  }
                : undefined
            }
          />
        )}
        {foreign && (
          <div className="seg-control" role="group" aria-label={t("字幕显示")}>
            {(
              [
                ["bilingual", t("双语")],
                ["translation", t("中文")],
                ["original", t("原文")],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" className={mode === k ? "on" : ""} onClick={() => setMode(k)}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {translation?.running && <div className="translate-bar">{t("正在翻译成中文…")}</div>}
      {translation?.error && <div className="translate-bar">{translation.error}</div>}
      {shadow && isCurrent && (
        <div className="shadow-bar">
          <Mic size={13} />
          <span>{t("跟读模式：每句说完会停一下，跟着说一遍")}</span>
          <button type="button" className="btn ghost sm" onClick={() => setShadow(false)}>
            {t("退出")}
          </button>
        </div>
      )}
      {showHighlights ? (
        <HighlightsPanel
          ep={episode}
          segments={segs}
          zh={zhItems}
          onJumpToTranscript={jumpFromHl}
        />
      ) : (
      <div
        className={`lines${marks && learnCard ? " learning" : ""}`}
        ref={listRef}
        onClickCapture={onWordClick}
      >
        {english && <LearnTip />}
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {rowVirtualizer.getVirtualItems().map((vRow) => {
            const i = vRow.index;
            const s = segs[i]!;
            const zh = translation?.items?.[i];
            const showZh = foreign && zh && mode !== "original";
            // 学英语时中文模式仍保留原文，方便点词
            const showOrig = mode !== "translation" || !zh || !!marks;
            const hl = hlStarts.get(i);
            const inHl = hlRange.has(i);
            const hlEnd = inHl && !hlRange.has(i + 1);
            return (
              <div
                key={`${s.start}-${i}`}
                data-index={i}
                ref={rowVirtualizer.measureElement}
                className={hl ? "hl-group" : undefined}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vRow.start}px)`,
                }}
              >
                {hl && (
                  <div className="hl-head">
                    <span className="hl-score">✦ {hl.score}</span>
                    <span className="hl-head-title clamp1">{hl.title}</span>
                    <span className="spacer" />
                    <button type="button" className="link-btn" onClick={() => onHlPreview(hl)}>
                      <Play size={11} fill="currentColor" /> {t("试看")}
                    </button>
                    {episode.videoId && (
                      <button type="button" className="link-btn hl-clip-btn" onClick={() => onHlClip(hl)}>
                        <Scissors size={11} /> {t("剪视频")}
                      </button>
                    )}
                  </div>
                )}
                <div
                  data-i={i}
                  role="button"
                  tabIndex={0}
                  className={`line ${i === active ? "active" : ""}${inHl ? " hl-in" : ""}${hl ? " hl-start" : ""}${hlEnd ? " hl-end" : ""}`}
                  onClick={() => seekEpisode(episode, s.start)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      seekEpisode(episode, s.start);
                    }
                  }}
                >
                  <div className="line-time">{clock(s.start)}</div>
                  <div className="line-text">
                    {showZh && <div className="zh">{zh}</div>}
                    {showOrig && (
                      <div className="orig">
                        {marks ? <LearnText text={s.text} marks={marks} /> : s.text}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {card && <WordCard target={card} ep={episode} onClose={closeCard} />}
      </div>
      )}
      {exporting && !foreign && (
        <SubtitleExport
          episode={episode}
          segments={segs}
          translations={translation?.items}
          foreign={false}
          mode="original"
          sourceLabel={sourceLabel(transcript!.source)}
          onClose={() => setExporting(false)}
        />
      )}
    </div>
  );
}
