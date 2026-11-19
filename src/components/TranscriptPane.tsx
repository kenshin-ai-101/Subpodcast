/**
 * [INPUT]: jobs 字幕/译文/asr、asrModels 下载进度、store.time/playing/settings；switchYoutubeTrack；exportTranscript
 * [OUTPUT]: 右侧字幕面板（查找中 / 模型下载 / GenCard；导出 MD·PDF；学英语标词/词卡/跟读听写 / 行列表）
 * [POS]: 听懂主路径；官方瀑布由 EpisodeView+ensureTranscript；无字幕空态走 GenCard+WaveToTextArt
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ChevronDown, Download, Ellipsis, FileText, Languages, ListChecks, Loader2, Mic, PenLine } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { api, errText, type Episode, type Segment } from "../lib/api";
import { useAsrModels, type AsrModel } from "../lib/asrModels";
import { looksEnglish } from "../lib/dict";
import {
  runTranscriptExport,
  type ExportFormat,
  type ExportMode,
} from "../lib/exportTranscript";
import { clock } from "../lib/format";
import {
  cancelAsr,
  ensureTranscript,
  generateTranscript,
  looksChinese,
  switchYoutubeTrack,
  useJobs,
} from "../lib/jobs";
import { activeIndex } from "../lib/playback";
import { activeCloudAsr, ASR_SERVICES, CLOUD_ASR_MAIN, type Settings } from "../lib/settings";
import { useStore } from "../store";
import { CassetteArt, NightNote, TrayArt, WaveToTextArt } from "./Illustrations";
import { LearnText, LearnTip, WordCard, useLearnMarks, type CardTarget } from "./Learn";
import { Dictation, EpisodeWords, useShadowing } from "./LearnPractice";

type Mode = "bilingual" | "translation" | "original";

const trackCache = new Map<string, { language: string; auto: boolean }[]>();
const autoStarted = new Set<string>();

function sourceLabel(source: string) {
  switch (source) {
    case "youtube":
      return "YouTube 官方";
    case "youtube-auto":
      return "YouTube 自动";
    case "qiaomu":
      return "精读站原文";
    case "podscribe":
      return "Podscribe";
    case "cloud":
    case "openai":
      return "云端识别";
    case "qwen3":
      return "本机 Qwen3";
    case "whisper":
      return "本机 Whisper";
    default:
      return source || "字幕";
  }
}

function engineLabel(engine?: string) {
  if (engine === "youtube") return "节目方中文字幕";
  if (engine === "google") return "谷歌翻译";
  if (engine === "llm") return "模型翻译";
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
    if (tracks || !episode.videoId) return;
    void api
      .youtubeTracks(episode.id)
      .then((list) => {
        trackCache.set(episode.id, list);
        setTracks(list);
      })
      .catch(() => {});
  }, [episode.id, episode.videoId, tracks]);

  if (!tracks || tracks.length < 2) return null;

  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(["zh-CN"], { type: "language" });
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
    `${name(x.language)}${x.auto ? " · 自动" : ""}`;

  const pick = async (x: { language: string; auto: boolean }) => {
    setOpen(false);
    if (x.language === language && x.auto === auto) return;
    setBusy(true);
    try {
      await switchYoutubeTrack(episode, x.language, x.auto);
    } catch (e) {
      notify(`切换字幕失败：${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel-menu" ref={box}>
      <button
        type="button"
        className="track-pick"
        title="字幕语言"
        aria-label="字幕语言"
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
          <span className="status-text">正在查找字幕…</span>
        </div>
        <div className="gen-wrap">
          <div className="gen-card">
            <div className="gen-skel" aria-hidden>
              <span />
              <span />
              <span />
            </div>
            <p className="gen-note">先看节目有没有自带字幕…</p>
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
        title="正在准备识别模型"
        note="只需下载这一次，完成后自动生成字幕。可以先听着。"
      >
        <div className="gen-progress">
          <div className="bar live">
            <div style={{ width: `${Math.max(2, pct)}%` }} />
          </div>
          <span>{pct}%</span>
        </div>
        <button type="button" className="btn ghost sm" onClick={() => void cancelDownload(dlId)}>
          取消
        </button>
      </GenCard>
    );
  }

  if (asrRunning || (asrProgress && asrProgress.stage !== "done" && asrProgress.stage !== "error")) {
    const live = asrProgress?.live ?? [];
    const pct = Math.round((asrProgress?.progress ?? 0) * 100);
    const label =
      asrProgress?.message ||
      (asrProgress?.stage === "download" ? "正在获取音频" : "正在识别");
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
              aria-label="换一种识别方式"
              title="换一种识别方式（从头开始）"
              value=""
              onChange={(e) => e.target.value && void switchEngine(e.target.value)}
            >
              <option value="">换一种方式…</option>
              <optgroup label="本机模型 · 音频不出本机">
                {pickerModels(models, settings)
                  .filter((m) => !(settings.asrEngine === "local" && settings.asrModel === m.id))
                  .map((m) => (
                    <option key={m.id} value={`local:${m.id}`}>
                      {m.name}
                      {m.installed ? "" : ` · ${sizeMb(m.sizeMb)}`}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="云端服务 · 更快，需要 Key">
                {pickerCloud(settings)
                  .filter((a) => settings.asrEngine !== a.id)
                  .map((a) => (
                    <option key={a.id} value={`cloud:${a.id}`}>
                      {a.name}
                    </option>
                  ))}
              </optgroup>
              <option value="more">更多…</option>
            </select>
            <button type="button" className="btn ghost sm" onClick={() => void stopRunning()}>
              取消
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
                  ? "先把音频取回来，马上开始听写"
                  : asrProgress?.message?.includes("解码")
                    ? "正在把音频转成识别用的格式，稍等片刻"
                    : settings.asrModel === "qwen3-asr"
                      ? "识别完成后会一次性显示全部文字"
                      : "识别出的文字会实时出现在这里"}
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
        title="字幕没有生成成功"
        note="可以换一个识别模型，或检查网络后再试。"
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
          重试
        </button>
      </GenCard>
    );
  }

  const needsDownload = !cloud && !!model && !model.installed;
  const canAsr = cloud ? !!ep.audioUrl : !!(ep.audioUrl || ep.videoId);

  return (
    <GenCard
      icon={<WaveToTextArt />}
      title="这集还没有字幕"
      note={
        cloud
          ? `用${cloud.name}生成，音频会上传到该服务，速度更快。生成后自动翻译成中文。`
          : "用本机模型生成，音频只在这台电脑上处理。生成后自动翻译成中文。"
      }
    >
      {official === "error" && officialError && (
        <p className="gen-warn" title={officialError}>
          <span>节目自带的字幕没读到：{plainError(officialError)}</span>
        </p>
      )}
      <button
        type="button"
        className="btn primary gen-go"
        disabled={!model || !canAsr}
        title={!canAsr ? (cloud ? "这集没有音频地址，无法云端识别" : "这集没有可识别的音频") : undefined}
        onClick={() => void generate()}
      >
        {missingKey ? "先填写 API Key" : "生成字幕"}
      </button>
      {needsDownload && model && (
        <p className="gen-size">第一次会先下载识别模型（约 {sizeMb(model.sizeMb)}），之后不用再下载</p>
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
                ? `改用${have.from}里已有的 ${have.name}，不用下载`
                : `改用已下载的 ${have.name}`}
            </button>
          ) : null;
        })()}
      {missingKey && cloud && (
        <p className="gen-size">用{cloud.name}识别需要它的 API Key，填好就能开始</p>
      )}
      <button
        type="button"
        className="link-btn gen-more"
        aria-expanded={options}
        onClick={() => setOptions(!options)}
      >
        识别设置
        <ChevronDown size={12} className={options ? "flip" : ""} />
      </button>
      {!options && <NightNote />}
      {options && (
        <div className="gen-options">
          <label>
            <span>识别方式</span>
            <select
              value={cloud ? `cloud:${cloud.id}` : `local:${model?.id ?? ""}`}
              onChange={(e) => pickEngine(e.target.value)}
            >
              <optgroup label="本机模型 · 音频不出本机">
                {pickerModels(models, settings).map((m) => (
                  <option key={m.id} value={`local:${m.id}`}>
                    {m.name}
                    {m.installed ? "" : ` · ${sizeMb(m.sizeMb)}`}
                  </option>
                ))}
              </optgroup>
              <optgroup label="云端服务 · 更快，需要 Key">
                {pickerCloud(settings).map((a) => (
                  <option key={a.id} value={`cloud:${a.id}`}>
                    {a.name}
                  </option>
                ))}
              </optgroup>
              <option value="more">更多…</option>
            </select>
          </label>
        </div>
      )}
    </GenCard>
  );
}

/** 错误文案可读化：长 URL 对听者无意义，完整内容留在 title。 */
const plainError = (m: string) => m.replace(/[：:]?\s*https?:\/\/\S+/g, "").trim() || m;

function ExportMenu({
  episode,
  segments,
  translations,
  mode,
  foreign,
  source,
}: {
  episode: Episode;
  segments: { start: number; end: number; text: string }[];
  translations?: (string | null)[];
  mode: ExportMode;
  foreign: boolean;
  source: string;
}) {
  const notify = useStore((s) => s.notify);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
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

  const run = async (format: ExportFormat) => {
    setOpen(false);
    setBusy(true);
    try {
      const path = await runTranscriptExport({
        format,
        episode,
        segments,
        translations,
        mode,
        foreign,
        sourceLabel: sourceLabel(source),
      });
      notify(`已导出到「下载」：${path.split(/[\\/]/).pop() ?? ""}`);
      void revealItemInDir(path).catch(() => {});
    } catch (e) {
      notify(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel-menu" ref={box}>
      <button
        type="button"
        className="track-pick"
        title="导出字幕"
        aria-label="导出字幕"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy || !segments.length}
        onClick={() => setOpen(!open)}
      >
        {busy ? <Loader2 size={13} className="spin" /> : <Download size={14} />}
        <span>导出</span>
        <ChevronDown size={12} className={open ? "flip" : ""} />
      </button>
      {open && (
        <div className="panel-menu-pop export-pop" role="menu">
          <button type="button" role="menuitem" onClick={() => void run("md")}>
            <FileText size={14} />
            <span>Markdown</span>
          </button>
          <button type="button" role="menuitem" onClick={() => void run("pdf")}>
            <FileText size={14} />
            <span>PDF</span>
          </button>
        </div>
      )}
    </div>
  );
}

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

function LearnPanelMenu({ ep, learn }: { ep: Episode; learn: LearnMenuState }) {
  const [menu, setMenu] = useState(false);
  const [words, setWords] = useState(false);
  const [dictation, setDictation] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const h = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("pointerdown", h);
    return () => document.removeEventListener("pointerdown", h);
  }, [menu]);

  return (
    <div className="panel-menu" ref={box}>
      <button
        type="button"
        className="icon-btn"
        title="更多"
        aria-label="更多"
        aria-expanded={menu}
        onClick={() => setMenu(!menu)}
      >
        <Ellipsis size={15} />
      </button>
      {menu && (
        <div className="panel-menu-pop" role="menu">
          <button type="button" role="menuitem" onClick={() => { setMenu(false); setWords(true); }}>
            <ListChecks size={14} /> 本期生词…
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={learn.shadow}
            disabled={!learn.canShadow}
            title={learn.canShadow ? undefined : "先播放这一集"}
            onClick={() => {
              setMenu(false);
              learn.setShadow(!learn.shadow);
            }}
          >
            <Mic size={14} /> {learn.shadow ? "退出跟读模式" : "跟读模式"}
          </button>
          <button type="button" role="menuitem" onClick={() => { setMenu(false); setDictation(true); }}>
            <PenLine size={14} /> 听写练习…
          </button>
        </div>
      )}
      {words && (
        <EpisodeWords ep={ep} segments={learn.segments} zh={learn.zh} onClose={() => setWords(false)} />
      )}
      {dictation && (
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
  const time = useStore((s) => s.time);
  const player = useStore((s) => s.player);
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
  const closeCard = useCallback(() => setCard(null), []);

  useEffect(() => {
    void ensureTranscript(episode);
  }, [episode.id]);

  const segs = transcript?.segments ?? [];
  const starts = segs.map((s) => s.start);
  const active = segs.length ? activeIndex(starts, time) : -1;
  const foreign = transcript
    ? !looksChinese(transcript.language, segs.slice(0, 3).map((s) => s.text).join(""))
    : false;
  const english = transcript
    ? looksEnglish(transcript.language, segs.slice(0, 20).map((x) => x.text).join(" "))
    : false;
  const marks = useLearnMarks(english);
  const learning = !!marks || (english && learnOn);
  const isCurrent = currentId === episode.id;
  const zhTag = engineLabel(translation?.engine);

  useShadowing(shadow && isCurrent, episode.id, segs);
  useEffect(() => {
    if (!learning) setShadow(false);
  }, [learning]);

  useEffect(() => {
    const root = listRef.current;
    if (!root || active < 0) return;
    root.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

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
        <ExportMenu
          episode={episode}
          segments={segs}
          translations={translation?.items}
          mode={mode}
          foreign={foreign}
          source={transcript!.source}
        />
        {learning && (
          <LearnPanelMenu
            ep={episode}
            learn={{
              segments: segs,
              zh: translation?.items,
              active,
              shadow,
              setShadow,
              canShadow: isCurrent,
            }}
          />
        )}
        {foreign && (
          <div className="seg-control" role="group" aria-label="字幕显示">
            {(
              [
                ["bilingual", "双语"],
                ["translation", "中文"],
                ["original", "原文"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" className={mode === k ? "on" : ""} onClick={() => setMode(k)}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {translation?.running && <div className="translate-bar">正在翻译成中文…</div>}
      {translation?.error && <div className="translate-bar">{translation.error}</div>}
      {shadow && isCurrent && (
        <div className="shadow-bar">
          <Mic size={13} />
          <span>跟读模式：每句说完会停一下，跟着说一遍</span>
          <button type="button" className="btn ghost sm" onClick={() => setShadow(false)}>
            退出
          </button>
        </div>
      )}
      <div
        className={`lines${marks && learnCard ? " learning" : ""}`}
        ref={listRef}
        onClickCapture={onWordClick}
      >
        {english && <LearnTip />}
        {segs.map((s, i) => {
          const zh = translation?.items?.[i];
          const showZh = foreign && zh && mode !== "original";
          // 学英语时中文模式仍保留原文，方便点词
          const showOrig = mode !== "translation" || !zh || !!marks;
          return (
            <div
              key={`${s.start}-${i}`}
              data-i={i}
              className={`line ${i === active ? "active" : ""}`}
              onClick={() => player?.seek(s.start)}
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
          );
        })}
        {card && <WordCard target={card} ep={episode} onClose={closeCard} />}
      </div>
    </div>
  );
}
