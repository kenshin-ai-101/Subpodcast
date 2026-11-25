/**
 * [INPUT]: store；api；ReadingSettings / ModelSettings / TtsSettings / ShortcutSettings；plugin-opener
 * [OUTPUT]: 设置对话框（字幕 / AI / 朗读 / 通用 / 学英语）；KeyRow / KeyField / DefaultButton / ProviderEditor
 * [POS]: 与 SubCast 设置项与布局对齐的原创实现；不做「关于」；保持对话框不改成页面
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Captions,
  Check,
  ChevronDown,
  Cloud,
  Cpu,
  ExternalLink,
  HardDrive,
  Keyboard,
  Loader2,
  FolderOpen,
  GraduationCap,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
  Volume2,
  X,
  type LucideIcon,
} from "lucide-react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, errText, type CliStatus, type StorageInfo } from "../lib/api";
import { AgentSettings } from "./AgentConnectDialog";
import { ask } from "../lib/confirm";
import { useT } from "../lib/i18n";
import { bytes, clearAudioCache, clearDownloads, useOffline } from "../lib/offline";
import { stopSpeaking } from "../lib/tts";
import {
  ASR_SERVICES,
  CLOUD_ASR_MAIN,
  activeCloudAsr,
  type CloudAsr,
  type LangSetting,
  type Provider,
  type SettingsSection,
  type ThemeSetting,
} from "../lib/settings";
import { IS_MAC, kbd } from "../lib/shortcuts";
import { useStore } from "../store";
import { LearnSettings } from "./LearnSettings";
import { LocalAsrPicker } from "./LocalAsrSettings";
import { ModelSettings } from "./ModelSettings";
import { ReadingSettings } from "./ReadingSettings";
import { ShortcutSettings } from "./ShortcutSettings";
import { TtsSettings } from "./TtsSettings";

const NO_AUTO = { autoCapitalize: "off" as const, autoCorrect: "off" as const, spellCheck: false };

const NAV: [SettingsSection, string, LucideIcon][] = [
  ["subtitles", "字幕", Captions],
  ["ai", "AI", Sparkles],
  ["tts", "朗读", Volume2],
  ["general", "通用", SlidersHorizontal],
  ["learn", "学英语", GraduationCap],
];

const LANGS: { id: LangSetting; name: string }[] = [
  { id: "zh-CN", name: "简体中文" },
  { id: "zh-TW", name: "繁體中文" },
  { id: "en", name: "English" },
];

function systemLangName() {
  const tag = (navigator.language || "zh-CN").toLowerCase();
  if (tag.startsWith("zh-tw") || tag.startsWith("zh-hk")) return "繁體中文";
  if (tag.startsWith("zh")) return "简体中文";
  if (tag.startsWith("en")) return "English";
  return navigator.language;
}

/** 翻译默认模型按钮。 */
export function DefaultButton({ id, isDefault }: { id: string; isDefault: boolean }) {
  const t = useT();
  const saveSettings = useStore((s) => s.saveSettings);
  const mode = useStore((s) => s.settings.translateMode);
  return isDefault ? (
    <p className="default-on small">
      <Check size={13} /> {t("当前默认模型")}
    </p>
  ) : (
    <button
      type="button"
      className="btn primary sm"
      onClick={() =>
        void saveSettings({
          translateProvider: id,
          chatProvider: id,
          ...(mode === "google" ? { translateMode: "auto" as const } : {}),
        })
      }
    >
      {t("设为默认模型")}
    </button>
  );
}

export function KeyField({ account, placeholder }: { account: string; placeholder?: string }) {
  const [key, setKey] = useState("");
  const [has, setHas] = useState(false);
  useEffect(() => {
    setKey("");
    void api.hasApiKey(account).then(setHas);
  }, [account]);
  return (
    <KeyRow
      key={account}
      has={has}
      value={key}
      onValue={setKey}
      placeholder={placeholder}
      onSave={async () => {
        await api.setApiKey(account, key);
        setHas(!!key.trim());
        setKey("");
      }}
      onDelete={async () => {
        await api.setApiKey(account, "");
        setHas(false);
      }}
    />
  );
}

function KeyRow({
  has,
  value,
  onValue,
  onSave,
  onDelete,
  placeholder,
}: {
  has: boolean;
  value: string;
  onValue: (v: string) => void;
  onSave: () => Promise<void>;
  onDelete: () => Promise<void>;
  placeholder?: string;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  if (has && !editing) {
    return (
      <div className="key-row key-saved" title={t("已保存在本机（正式签名版用钥匙串；开发/未签名用本机文件）")}>
        <span className="key-state">
          <Check size={14} />
          <span>{t("已保存")}</span>
          <span className="key-dots" aria-hidden>
            ••••••••
          </span>
        </span>
        <button type="button" className="btn sm" onClick={() => setEditing(true)}>
          {t("更换")}
        </button>
        <button type="button" className="icon-btn" title={t("删除 Key")} aria-label={t("删除 Key")} onClick={() => void onDelete()}>
          <Trash2 size={14} />
        </button>
      </div>
    );
  }
  return (
    <div className="key-row">
      <input
        {...NO_AUTO}
        type="password"
        autoFocus={editing}
        value={value}
        onChange={(e) => onValue(e.target.value)}
        placeholder={placeholder ?? t("粘贴 API Key")}
      />
      <button type="button" className="btn sm" onClick={() => void onSave().then(() => setEditing(false))} disabled={!value.trim()}>
        {t("保存")}
      </button>
      {has && (
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            onValue("");
            setEditing(false);
          }}
        >
          {t("取消")}
        </button>
      )}
    </div>
  );
}

export function ProviderEditor({ p, onChange }: { p: Provider; onChange: (p: Provider) => void }) {
  const t = useT();
  const settings = useStore((s) => s.settings);
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testOk, setTestOk] = useState(false);
  const [live, setLive] = useState<string[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    setKey("");
    setLive(null);
    setAdvanced(!p.needsKey);
    void api.hasApiKey(p.id).then(setHasKey);
  }, [p.id]);

  const saveKey = async () => {
    await api.setApiKey(p.id, key);
    setHasKey(!!key.trim());
    setKey("");
  };

  const fetchModels = async () => {
    setFetching(true);
    setTesting(null);
    setTestOk(false);
    try {
      if (key.trim()) await saveKey();
      const ids = await api.listModels({
        provider: p.id,
        baseUrl: p.baseUrl,
        protocol: p.protocol,
      });
      setLive(ids);
      if (!ids.length) setTesting(t("这个服务没有返回模型列表，请手动填写"));
    } catch (e) {
      setTesting(errText(e));
    } finally {
      setFetching(false);
    }
  };

  const test = async () => {
    setTesting("…");
    setTestOk(false);
    try {
      if (key.trim()) await saveKey();
      const r = await api.llmChat({
        provider: p.id,
        baseUrl: p.baseUrl,
        model: p.model,
        protocol: p.protocol,
        messages: [
          { role: "system", content: "Reply with one short word." },
          { role: "user", content: "ping" },
        ],
        stream: false,
      });
      setTesting(`${t("可用")} ✓ ${r.slice(0, 20)}`);
      setTestOk(true);
    } catch (e) {
      setTesting(errText(e));
    }
  };

  const forTranslate = settings.translateProvider === p.id && settings.translateMode !== "google";

  return (
    <div className="provider-form">
      {p.needsKey && (
        <div className="setup-block">
          <div className="setup-head">
            <p className="setup-title">API Key</p>
            {p.keyUrl && (
              <button type="button" className="link-btn" onClick={() => void openUrl(p.keyUrl!)}>
                {t("去官网申请")} <ExternalLink size={11} />
              </button>
            )}
          </div>
          <KeyRow
            key={p.id}
            has={hasKey}
            value={key}
            onValue={setKey}
            onSave={saveKey}
            onDelete={async () => {
              await api.setApiKey(p.id, "");
              setHasKey(false);
            }}
          />
        </div>
      )}
      <div className="setup-block">
        <DefaultButton id={p.id} isDefault={forTranslate} />
      </div>
      <div className="row-actions">
        <button type="button" className="btn sm" onClick={() => void test()} disabled={testing === "…"}>
          {testing === "…" && <Loader2 size={13} className="spin" />} {t("测试连接")}
        </button>
        {testing && testing !== "…" && <span className={testOk ? "ok-text small" : "error-text small"}>{testing}</span>}
        <span className="spacer" />
        <button type="button" className="adv-toggle" onClick={() => setAdvanced(!advanced)}>
          <ChevronDown size={12} className={advanced ? "flip" : ""} /> {t("高级设置")}
        </button>
      </div>
      {advanced && (
        <div className="adv-body">
          <label>
            <span>{t("接口类型")}</span>
            <select value={p.protocol} onChange={(e) => onChange({ ...p, protocol: e.target.value as Provider["protocol"] })}>
              <option value="openai">{t("OpenAI 兼容")}</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label>
            <span>{t("接口地址")}</span>
            <input {...NO_AUTO} value={p.baseUrl} onChange={(e) => onChange({ ...p, baseUrl: e.target.value })} placeholder="https://…/v1" />
          </label>
          <label>
            <span>{t("模型")}</span>
            <input
              {...NO_AUTO}
              value={p.model}
              list={`models-${p.id}`}
              onChange={(e) => onChange({ ...p, model: e.target.value })}
              placeholder={t("模型名")}
            />
            <datalist id={`models-${p.id}`}>
              {[...new Set([...(live ?? []), ...(p.models ?? [])])].map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          {(p.models?.length || live?.length) ? (
            <div className="model-chips">
              {[...new Set([...(p.models ?? []), ...(live ?? []).slice(0, 40)])].map((m) => (
                <button key={m} type="button" className={`chip sm ${p.model === m ? "on" : ""}`} onClick={() => onChange({ ...p, model: m })}>
                  {m}
                </button>
              ))}
            </div>
          ) : null}
          <div className="row-actions">
            <button type="button" className="btn ghost sm" onClick={() => void fetchModels()} disabled={fetching}>
              {fetching ? <Loader2 size={13} className="spin" /> : null} {t("获取模型列表")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CloudAsrEditor({ a, onChange }: { a: CloudAsr; onChange: (a: CloudAsr) => void }) {
  const t = useT();
  return (
    <div className="provider-form">
      <p className="muted small">
        {t("{note}。识别时音频会发送到 {name}。", { note: t(a.note), name: t(a.name) })}
      </p>
      <label>
        <span>{t("接口地址")}</span>
        <input {...NO_AUTO} value={a.baseUrl} onChange={(e) => onChange({ ...a, baseUrl: e.target.value })} />
      </label>
      <label>
        <span>{t("模型")}</span>
        <input {...NO_AUTO} value={a.model} list={`asr-${a.id}`} onChange={(e) => onChange({ ...a, model: e.target.value })} />
        <datalist id={`asr-${a.id}`}>
          {a.models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      {a.models.length > 1 && (
        <div className="model-chips">
          {a.models.map((m) => (
            <button key={m} type="button" className={`chip sm ${a.model === m ? "on" : ""}`} onClick={() => onChange({ ...a, model: m })}>
              {m}
            </button>
          ))}
        </div>
      )}
      {a.needsKey && (
        <label>
          <span>API Key</span>
          <KeyField account={`asr.${a.id}`} />
        </label>
      )}
      <div className="row-actions">
        <span className="spacer" />
        {a.keyUrl && (
          <button type="button" className="btn ghost sm" onClick={() => void openUrl(a.keyUrl!)}>
            <ExternalLink size={13} /> {t("获取 Key")}
          </button>
        )}
      </div>
    </div>
  );
}

function StorageSettings({ expanded, toggle, onAsr, onTts }: {
  expanded: boolean; toggle: () => void; onAsr: () => void; onTts: () => void;
}) {
  const t = useT();
  const saved = useOffline((s) => s.saved);
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const reload = () => void api.storageInfo().then(setInfo).catch(() => {});
  useEffect(() => {
    if (expanded) reload();
  }, [expanded, saved]);
  const total = info
    ? info.downloads + info.models + info.library + info.temp
      + (info.audioCache ?? 0) + (info.ttsCache ?? 0) + (info.ttsModels ?? 0)
    : null;
  return (
    <>
      <button type="button" className="setting-row" aria-expanded={expanded} onClick={toggle}>
        <HardDrive size={15} /> <span>{t("存储")}</span>
        {total != null && <span className="muted small">{t("占用 {size}", { size: bytes(total) })}</span>}
        <ChevronDown size={14} className={expanded ? "flip" : ""} />
      </button>
      {expanded && <Storage info={info} reload={reload} onAsr={onAsr} onTts={onTts} />}
    </>
  );
}

/** 高光剪辑默认落到系统「下载」，可改到自选目录。 */
function ClipExportRow() {
  const t = useT();
  const notify = useStore((s) => s.notify);
  const { clipExportDir, saveSettings } = useStore(
    useShallow((s) => ({
      clipExportDir: s.settings.clipExportDir ?? "",
      saveSettings: s.saveSettings,
    })),
  );
  const pick = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({
        directory: true,
        multiple: false,
        defaultPath: clipExportDir || undefined,
      });
      if (typeof dir === "string" && dir) void saveSettings({ clipExportDir: dir });
    } catch (e) {
      notify(errText(e));
    }
  };
  const openDir = async () => {
    try {
      await api.revealFile(clipExportDir);
    } catch (e) {
      notify(errText(e));
    }
  };
  return (
    <div className="storage-row">
      <div className="storage-row-text">
        <p className="storage-row-name">{t("高光剪辑导出到")}</p>
        <p className="muted small clamp1" title={clipExportDir || undefined}>
          {clipExportDir || t("「下载」文件夹")}
        </p>
      </div>
      <button type="button" className="btn sm" onClick={() => void pick()}>
        <FolderOpen size={13} /> {t("选择文件夹")}
      </button>
      {!!clipExportDir && (
        <button type="button" className="btn ghost sm" onClick={() => void openDir()}>
          {t("打开")}
        </button>
      )}
      {!!clipExportDir && (
        <button type="button" className="btn ghost sm" onClick={() => void saveSettings({ clipExportDir: "" })}>
          {t("恢复默认")}
        </button>
      )}
    </div>
  );
}

function Storage({ info, reload, onAsr, onTts }: {
  info: StorageInfo | null; reload: () => void; onAsr: () => void; onTts: () => void;
}) {
  const t = useT();
  const saved = useOffline((s) => s.saved);
  const notify = useStore((s) => s.notify);
  const n = Object.keys(saved).length;
  const size = (b?: number) => (info ? (b ? bytes(b) : "0 MB") : "…");
  const clearAll = async () => {
    if (!(await ask(t("删除全部已下载的音频？字幕、精读和收听进度都会保留。")))) return;
    await clearDownloads();
    reload();
  };
  const clearTts = async () => {
    if (!(await ask(t("清理朗读缓存？下次朗读会重新合成，字幕与精读内容不受影响。")))) return;
    stopSpeaking();
    await api.clearTtsCache();
    reload();
  };
  const clearAlignCache = async () => {
    if (!(await ask(t("清理字幕对齐音频缓存？之后需要对齐时会重新下载。")))) return;
    await clearAudioCache();
    reload();
  };
  return (
    <div className="storage-list">
      <div className="storage-row">
        <div className="storage-row-text">
          <p className="storage-row-name">{t("离线下载")}</p>
          <p className="muted small">
            {n ? t("{n} 集音频，没有网络也能听", { n }) : t("在单集页点下载按钮，就能离线收听")}
          </p>
        </div>
        <span className="storage-size">{size(info?.downloads)}</span>
        <button type="button" className="btn sm" onClick={() => void api.openDataFolder("downloads")}>
          <FolderOpen size={13} /> {t("打开文件夹")}
        </button>
        {n > 0 && (
          <button type="button" className="icon-btn" title={t("全部删除")} onClick={() => void clearAll().catch((e) => notify(errText(e)))}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
      <ClipExportRow />
      <div className="storage-row">
        <div className="storage-row-text">
          <p className="storage-row-name">{t("语音识别模型")}</p>
          <p className="muted small">{t("本机识别用的模型，在「字幕」里下载或删除")}</p>
        </div>
        <span className="storage-size">{size(info?.models)}</span>
        <button type="button" className="btn sm" onClick={() => void api.openDataFolder("models")}>
          <FolderOpen size={13} /> {t("打开文件夹")}
        </button>
        <button type="button" className="btn ghost sm" onClick={onAsr}>
          {t("管理")}
        </button>
      </div>
      <div className="storage-row">
        <div className="storage-row-text">
          <p className="storage-row-name">{t("节目库")}</p>
          <p className="muted small">{t("订阅、字幕、翻译、精读和收听进度")}</p>
        </div>
        <span className="storage-size">{size(info?.library)}</span>
        <button type="button" className="btn ghost sm" onClick={() => void api.openDataFolder("data")}>
          <FolderOpen size={13} /> {t("打开文件夹")}
        </button>
      </div>
      {!!info?.ttsModels && (
        <div className="storage-row">
          <div className="storage-row-text">
            <p className="storage-row-name">{t("本地语音模型")}</p>
            <p className="muted small">{t("Melo、Kokoro 离线朗读用的模型，在「朗读」里下载或删除")}</p>
          </div>
          <span className="storage-size">{size(info.ttsModels)}</span>
          <button type="button" className="btn sm" onClick={() => void api.openDataFolder("tts-models")}>
            <FolderOpen size={13} /> {t("打开文件夹")}
          </button>
          <button type="button" className="btn ghost sm" onClick={onTts}>
            {t("管理")}
          </button>
        </div>
      )}
      {!!info?.ttsCache && (
        <div className="storage-row">
          <div className="storage-row-text">
            <p className="storage-row-name">{t("朗读缓存")}</p>
            <p className="muted small">
              {t("朗读精读和字幕中文翻译生成的语音缓存；最多占 500 MB，久不用的先删")}
            </p>
          </div>
          <span className="storage-size">{size(info.ttsCache)}</span>
          <button type="button" className="btn ghost sm" onClick={() => void api.openDataFolder("tts-cache")}>
            <FolderOpen size={13} /> {t("打开文件夹")}
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => void clearTts().catch((e) => notify(errText(e)))}
          >
            {t("清理")}
          </button>
        </div>
      )}
      {!!info?.audioCache && (
        <div className="storage-row">
          <div className="storage-row-text">
            <p className="storage-row-name">{t("对齐音频缓存")}</p>
            <p className="muted small">
              {t("用于声纹/语音对齐的播客音频缓存，最多占 2 GB，久不用的会自动清理")}
            </p>
          </div>
          <span className="storage-size">{size(info.audioCache)}</span>
          <button type="button" className="btn ghost sm" onClick={() => void api.openDataFolder("audio-cache")}>
            <FolderOpen size={13} /> {t("打开文件夹")}
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => void clearAlignCache().catch((e) => notify(errText(e)))}
          >
            {t("清理")}
          </button>
        </div>
      )}
      {!!info?.temp && (
        <div className="storage-row">
          <div className="storage-row-text">
            <p className="storage-row-name">{t("临时文件")}</p>
            <p className="muted small">{t("中断的识别留下的音频，可以放心清理")}</p>
          </div>
          <span className="storage-size">{size(info.temp)}</span>
          <button
            type="button"
            className="btn sm"
            onClick={() => void api.clearTemp().then(reload).catch((e) => notify(errText(e)))}
          >
            {t("清理")}
          </button>
        </div>
      )}
    </div>
  );
}

function CliSettings() {
  const t = useT();
  const notify = useStore((s) => s.notify);
  const [status, setStatus] = useState<CliStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void api.cliStatus().then(setStatus).catch(e => setError(errText(e))); }, []);

  const install = async () => {
    setBusy(true);
    try {
      const next = await api.cliInstall();
      setStatus(next);
      notify(t("已安装 subpodcast 命令"));
    } catch (e) {
      notify(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <p className="muted small">{error || t("正在检查…")}</p>;

  const badge = !status.bundled
    ? t("开发态需先构建 subpodcast-cli")
    : status.installed && !status.needsUpdate
      ? t("已就绪")
      : status.needsUpdate
        ? t("需要更新链接")
        : t("未安装");

  return (
    <div className="provider-form cli-settings">
      <p className="muted small">
        {t("在终端使用 subpodcast 命令管理播客。")}
      </p>
      <p className="small">
        <span>
          {t("命令行状态")}：{badge}
        </span>
        {status.linkPath ? ` · ${status.linkPath}` : ""}
      </p>
      {status.installed && !status.inPath && status.linkPath && (
        <p className="muted small">
          {t("请将 {dir} 加入 PATH 环境变量。", {
            dir: status.linkPath.replace(/[/\\][^/\\]+$/, ""),
          })}
        </p>
      )}
      <div className="row-actions">
        {status.bundled && (!status.installed || status.needsUpdate) && (
          <button type="button" className="btn sm" disabled={busy} onClick={() => void install()}>
            {busy ? <Loader2 size={13} className="spin" /> : <Terminal size={13} />}{" "}
            {status.needsUpdate ? t("更新链接") : t("安装 subpodcast 命令")}
          </button>
        )}
      </div>
    </div>
  );
}

export function SettingsDialog() {
  const t = useT();
  const { settingsOpen, settingsSection, settings, saveSettings, set, notify } = useStore(
    useShallow((s) => ({
      settingsOpen: s.settingsOpen,
      settingsSection: s.settingsSection,
      settings: s.settings,
      saveSettings: s.saveSettings,
      set: s.set,
      notify: s.notify,
    })),
  );
  const [section, setSection] = useState<SettingsSection>(settingsSection ?? "subtitles");
  const [moreCloud, setMoreCloud] = useState(false);
  const [proxy, setProxy] = useState(settings.proxy);
  const [showKeys, setShowKeys] = useState(false);
  const [showStorage, setShowStorage] = useState(false);
  const [showCli, setShowCli] = useState(false);

  useEffect(() => {
    if (settingsOpen) {
      setSection(settingsSection === "agents" ? "general" : settingsSection ?? "subtitles");
      setProxy(settings.proxy);
      if (settingsSection === "agents") {
        const frame = requestAnimationFrame(() => document.getElementById("agent-connect")?.scrollIntoView({ block: "start" }));
        return () => cancelAnimationFrame(frame);
      }
    }
  }, [settingsOpen, settingsSection]);

  useEffect(() => {
    if (settingsOpen) return stopSpeaking;
  }, [settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        set({ settingsOpen: false, settingsSection: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, set]);

  if (!settingsOpen) return null;
  const close = () => set({ settingsOpen: false, settingsSection: null });
  const cloud = activeCloudAsr(settings);
  const isLocal = settings.asrEngine === "local";

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal wide settings-modal" role="dialog" aria-modal="true" aria-label={t("设置")}>
        <div className="modal-head">
          <h3>{t("设置")}</h3>
          <button type="button" className="icon-btn" onClick={close} aria-label={t("关闭")}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body settings-modal-body">
          <div className="settings">
            <nav className="settings-nav">
              {NAV.map(([k, label, Icon]) => (
                <button key={k} type="button" className={section === k ? "on" : ""} onClick={() => setSection(k)}>
                  <Icon size={15} aria-hidden />
                  {t(label)}
                </button>
              ))}
            </nav>
            <div className="settings-body">
              {section === "subtitles" && (
                <>
                  <ReadingSettings />
                  <section className="setup-block">
                    <p className="setup-title">{t("如果没有字幕时")}</p>
                    <p className="muted small">{t("先查节目自带的字幕；没有时才听写。")}</p>
                    <div className="engine-switch">
                      <button
                        type="button"
                        className={`engine ${isLocal ? "on" : ""}`}
                        onClick={() =>
                          void saveSettings({
                            asrEngine: "local",
                            asrModel: settings.asrModel?.startsWith("gpt") || settings.asrModel?.includes("/") ? "qwen3-asr" : settings.asrModel || "qwen3-asr",
                          })
                        }
                      >
                        <Cpu size={18} />
                        <div>
                          <p>{t("本机模型")}</p>
                          <p className="muted small">{t("免费，音频不出本机")}</p>
                        </div>
                      </button>
                      <button
                        type="button"
                        className={`engine ${!isLocal ? "on" : ""}`}
                        onClick={() => void saveSettings({ asrEngine: !isLocal ? settings.asrEngine : "openai" })}
                      >
                        <Cloud size={18} />
                        <div>
                          <p>{t("云端服务")}</p>
                          <p className="muted small">{t("更快，需要 Key，按量付费")}</p>
                        </div>
                      </button>
                    </div>
                    {isLocal ? (
                      <LocalAsrPicker />
                    ) : (
                      <>
                        <div className="provider-tabs">
                          {ASR_SERVICES.filter((a) => moreCloud || CLOUD_ASR_MAIN.includes(a.id) || settings.asrEngine === a.id).map((a) => (
                            <button
                              key={a.id}
                              type="button"
                              className={`chip ${settings.asrEngine === a.id ? "on" : ""}`}
                              onClick={() => void saveSettings({ asrEngine: a.id, asrModel: settings.cloudAsr[a.id]?.model ?? a.model })}
                            >
                              {t(a.name)}
                            </button>
                          ))}
                          {!moreCloud && (
                            <button type="button" className="chip" onClick={() => setMoreCloud(true)}>
                              {t("更多")}
                            </button>
                          )}
                        </div>
                        {cloud && (
                          <CloudAsrEditor
                            key={cloud.id}
                            a={cloud}
                            onChange={(na) =>
                              void saveSettings({
                                cloudAsr: { ...settings.cloudAsr, [na.id]: na },
                                asrModel: na.model,
                              })
                            }
                          />
                        )}
                      </>
                    )}
                  </section>
                </>
              )}

              {section === "ai" && <ModelSettings ProviderEditor={ProviderEditor} />}

              {section === "tts" && <TtsSettings />}

              {section === "learn" && <LearnSettings />}

              {section === "general" && (
                <>
                  <section className="setup-block">
                    <p className="setup-title">{t("界面")}</p>
                    <label>
                      <span>{t("外观")}</span>
                      <select
                        value={settings.theme ?? "system"}
                        onChange={(e) => void saveSettings({ theme: e.target.value as ThemeSetting })}
                      >
                        <option value="system">{t("跟随系统")}</option>
                        <option value="light">{t("浅色")}</option>
                        <option value="dark">{t("深色")}</option>
                      </select>
                    </label>
                    <label>
                      <span>{t("界面语言")}</span>
                      <select value={settings.uiLang} onChange={(e) => void saveSettings({ uiLang: e.target.value as LangSetting })}>
                        <option value="auto">{t("跟随系统")}（{systemLangName()}）</option>
                        {LANGS.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={settings.youtubePromo}
                        onChange={(e) => void saveSettings({ youtubePromo: e.target.checked })}
                      />{" "}
                      {t("显示节目的 YouTube 订阅按钮")}
                    </label>
                    {settings.youtubePromo && (
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={!settings.homeBannerHidden}
                          onChange={(e) => void saveSettings({ homeBannerHidden: !e.target.checked })}
                        />{" "}
                        {t("在发现页顶部显示推荐横幅")}
                      </label>
                    )}
                  </section>
                  <section className="setup-block">
                    <p className="setup-title">{t("订阅")}</p>
                    <div className="row-actions">
                      <button type="button" className="btn sm" onClick={() => set({ settingsOpen: false, addOpen: true, addTab: "import" })}>
                        {t("导入订阅…")}
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={async () => {
                          try {
                            const path = await api.exportOpml();
                            notify(t("已导出到「下载」：{file}", { file: path.split(/[\\/]/).pop() ?? "" }));
                            void revealItemInDir(path).catch(() => {});
                          } catch (e) {
                            notify(errText(e));
                          }
                        }}
                      >
                        {t("导出 OPML")}
                      </button>
                    </div>
                  </section>
                  <section className="setup-block">
                    <p className="setup-title">{t("网络")}</p>
                    <label>
                      <span>{t("代理")}</span>
                      <div className="key-row">
                        <input {...NO_AUTO} value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder={t("留空则直连；连不上再试系统代理")} />
                        <button
                          type="button"
                          className="btn sm"
                          onClick={async () => {
                            try {
                              await saveSettings({ proxy });
                              notify(t("代理已保存"));
                            } catch (e) {
                              notify(errText(e));
                            }
                          }}
                        >
                          {t("保存")}
                        </button>
                      </div>
                    </label>
                    <label>
                      <span>{t("YouTube 要求验证时")}</span>
                      <select
                        value={settings.ytCookiesBrowser ?? ""}
                        onChange={(e) => void saveSettings({ ytCookiesBrowser: e.target.value })}
                      >
                        <option value="">{t("先问我")}</option>
                        {(IS_MAC ? ["chrome", "safari", "edge", "firefox", "brave"] : ["chrome", "edge", "firefox", "brave"]).map((b) => (
                          <option key={b} value={b}>
                            {t("借用 {browser} 的 YouTube 登录", { browser: b[0]!.toUpperCase() + b.slice(1) })}
                          </option>
                        ))}
                      </select>
                    </label>
                  </section>
                  <section className="setup-block" id="agent-connect">
                    <p className="setup-title">{t("让 AI 助手调用声译")}</p>
                    <AgentSettings />
                  </section>
                  <section className="setup-block">
                    <p className="setup-title">{t("共享")}</p>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={settings.shareTranscripts}
                        onChange={(e) => void saveSettings({ shareTranscripts: e.target.checked })}
                      />{" "}
                      {t("匿名分享我生成的字幕、译文和导读")}
                    </label>
                    <p className="muted small">{t("只分享文字与匿名安装标识，默认关闭；含鉴权或内网的私有源永不上传。")}</p>
                  </section>
                  <section className="setup-block">
                    <button type="button" className="setting-row" aria-expanded={showKeys} onClick={() => setShowKeys(!showKeys)}>
                      <Keyboard size={15} /> <span>{t("快捷键")}</span>
                      <span className="muted small">{kbd("⌘/")} {t("随时查看")}</span>
                      <ChevronDown size={14} className={showKeys ? "flip" : ""} />
                    </button>
                    {showKeys && <ShortcutSettings />}
                    <StorageSettings expanded={showStorage} toggle={() => setShowStorage(!showStorage)}
                      onAsr={() => setSection("subtitles")} onTts={() => setSection("tts")} />
                    <button type="button" className="setting-row" aria-expanded={showCli} onClick={() => setShowCli(!showCli)}>
                      <Terminal size={15} /> <span>{t("命令行工具（CLI）")}</span>
                      <span className="muted small">subpodcast</span>
                      <ChevronDown size={14} className={showCli ? "flip" : ""} />
                    </button>
                    {showCli && <CliSettings />}
                  </section>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
