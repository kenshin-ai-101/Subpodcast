/**
 * [INPUT]: store；api；ReadingSettings / ModelSettings / ShortcutSettings；plugin-opener
 * [OUTPUT]: 设置对话框（字幕 / AI / 通用 / 学英语）；KeyRow / KeyField / DefaultButton / ProviderEditor
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
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, errText } from "../lib/api";
import {
  ASR_SERVICES,
  CLOUD_ASR_MAIN,
  activeCloudAsr,
  type CloudAsr,
  type LangSetting,
  type Provider,
  type SettingsSection,
} from "../lib/settings";
import { IS_MAC, kbd } from "../lib/shortcuts";
import { useStore } from "../store";
import { LearnSettings } from "./LearnSettings";
import { LocalAsrPicker } from "./LocalAsrSettings";
import { ModelSettings } from "./ModelSettings";
import { ReadingSettings } from "./ReadingSettings";
import { ShortcutSettings } from "./ShortcutSettings";

const NO_AUTO = { autoCapitalize: "off" as const, autoCorrect: "off" as const, spellCheck: false };

const NAV: [SettingsSection, string, LucideIcon][] = [
  ["subtitles", "字幕", Captions],
  ["ai", "AI", Sparkles],
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
  const saveSettings = useStore((s) => s.saveSettings);
  const mode = useStore((s) => s.settings.translateMode);
  return isDefault ? (
    <p className="default-on small">
      <Check size={13} /> 当前默认模型
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
      设为默认模型
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
  const [editing, setEditing] = useState(false);
  if (has && !editing) {
    return (
      <div className="key-row key-saved" title="已保存在本机（正式签名版用钥匙串；开发/未签名用本机文件）">
        <span className="key-state">
          <Check size={14} />
          <span>已保存</span>
          <span className="key-dots" aria-hidden>
            ••••••••
          </span>
        </span>
        <button type="button" className="btn sm" onClick={() => setEditing(true)}>
          更换
        </button>
        <button type="button" className="icon-btn" title="删除 Key" aria-label="删除 Key" onClick={() => void onDelete()}>
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
        placeholder={placeholder ?? "粘贴 API Key"}
      />
      <button type="button" className="btn sm" onClick={() => void onSave().then(() => setEditing(false))} disabled={!value.trim()}>
        保存
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
          取消
        </button>
      )}
    </div>
  );
}

export function ProviderEditor({ p, onChange }: { p: Provider; onChange: (p: Provider) => void }) {
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
      if (!ids.length) setTesting("这个服务没有返回模型列表，请手动填写");
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
      setTesting(`可用 ✓ ${r.slice(0, 20)}`);
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
                去官网申请 <ExternalLink size={11} />
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
          {testing === "…" && <Loader2 size={13} className="spin" />} 测试连接
        </button>
        {testing && testing !== "…" && <span className={testOk ? "ok-text small" : "error-text small"}>{testing}</span>}
        <span className="spacer" />
        <button type="button" className="adv-toggle" onClick={() => setAdvanced(!advanced)}>
          <ChevronDown size={12} className={advanced ? "flip" : ""} /> 高级设置
        </button>
      </div>
      {advanced && (
        <div className="adv-body">
          <label>
            <span>接口类型</span>
            <select value={p.protocol} onChange={(e) => onChange({ ...p, protocol: e.target.value as Provider["protocol"] })}>
              <option value="openai">OpenAI 兼容</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label>
            <span>接口地址</span>
            <input {...NO_AUTO} value={p.baseUrl} onChange={(e) => onChange({ ...p, baseUrl: e.target.value })} placeholder="https://…/v1" />
          </label>
          <label>
            <span>模型</span>
            <input
              {...NO_AUTO}
              value={p.model}
              list={`models-${p.id}`}
              onChange={(e) => onChange({ ...p, model: e.target.value })}
              placeholder="模型名"
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
              {fetching ? <Loader2 size={13} className="spin" /> : null} 获取模型列表
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CloudAsrEditor({ a, onChange }: { a: CloudAsr; onChange: (a: CloudAsr) => void }) {
  return (
    <div className="provider-form">
      <p className="muted small">
        {a.note}。识别时音频会发送到 {a.name}。
      </p>
      <label>
        <span>接口地址</span>
        <input {...NO_AUTO} value={a.baseUrl} onChange={(e) => onChange({ ...a, baseUrl: e.target.value })} />
      </label>
      <label>
        <span>模型</span>
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
            <ExternalLink size={13} /> 获取 Key
          </button>
        )}
      </div>
    </div>
  );
}

function StorageTotal() {
  const [total, setTotal] = useState<number | null>(null);
  useEffect(() => {
    void api
      .storageInfo()
      .then((i) => setTotal(i.downloads + i.models + i.library + i.temp))
      .catch(() => {});
  }, []);
  if (total == null) return null;
  const mb = total / (1024 * 1024);
  const size = mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return <span className="muted small">占用 {size}</span>;
}

function Storage({ onAsr }: { onAsr: () => void }) {
  const [info, setInfo] = useState<{ downloads: number; models: number; library: number; temp: number } | null>(null);
  const load = () => void api.storageInfo().then(setInfo).catch(() => {});
  useEffect(load, []);
  const size = (b?: number) => {
    if (!info) return "…";
    if (!b) return "0 MB";
    const mb = b / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  };
  return (
    <div className="storage-list">
      <div className="storage-row">
        <div className="storage-row-text">
          <p className="storage-row-name">离线下载</p>
          <p className="muted small">MVP 暂未开放离线下载</p>
        </div>
        <span className="storage-size">{size(info?.downloads)}</span>
        <button type="button" className="btn sm" onClick={() => void api.openDataFolder("downloads")}>
          <FolderOpen size={13} /> 打开文件夹
        </button>
      </div>
      <div className="storage-row">
        <div className="storage-row-text">
          <p className="storage-row-name">语音识别模型</p>
          <p className="muted small">本机识别用的模型（二期），在「字幕」里管理</p>
        </div>
        <span className="storage-size">{size(info?.models)}</span>
        <button type="button" className="btn sm" onClick={() => void api.openDataFolder("models")}>
          <FolderOpen size={13} /> 打开文件夹
        </button>
        <button type="button" className="btn ghost sm" onClick={onAsr}>
          管理
        </button>
      </div>
      <div className="storage-row">
        <div className="storage-row-text">
          <p className="storage-row-name">节目库</p>
          <p className="muted small">订阅、字幕、翻译和收听进度</p>
        </div>
        <span className="storage-size">{size(info?.library)}</span>
        <button type="button" className="btn ghost sm" onClick={() => void api.openDataFolder("data")}>
          <FolderOpen size={13} /> 打开文件夹
        </button>
      </div>
      {!!info?.temp && (
        <div className="storage-row">
          <div className="storage-row-text">
            <p className="storage-row-name">临时文件</p>
            <p className="muted small">中断的识别留下的音频，可以放心清理</p>
          </div>
          <span className="storage-size">{size(info.temp)}</span>
          <button type="button" className="btn sm" onClick={() => void api.clearTemp().then(load)}>
            清理
          </button>
        </div>
      )}
    </div>
  );
}

export function SettingsDialog() {
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

  useEffect(() => {
    if (settingsOpen) {
      setSection(settingsSection ?? "subtitles");
      setProxy(settings.proxy);
    }
  }, [settingsOpen, settingsSection]);

  if (!settingsOpen) return null;
  const close = () => set({ settingsOpen: false, settingsSection: null });
  const cloud = activeCloudAsr(settings);
  const isLocal = settings.asrEngine === "local";

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal wide settings-modal" role="dialog" aria-modal="true" aria-label="设置">
        <div className="modal-head">
          <h3>设置</h3>
          <button type="button" className="icon-btn" onClick={close} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body settings-modal-body">
          <div className="settings">
            <nav className="settings-nav">
              {NAV.map(([k, label, Icon]) => (
                <button key={k} type="button" className={section === k ? "on" : ""} onClick={() => setSection(k)}>
                  <Icon size={15} aria-hidden />
                  {label}
                </button>
              ))}
            </nav>
            <div className="settings-body">
              {section === "subtitles" && (
                <>
                  <ReadingSettings />
                  <section className="setup-block">
                    <p className="setup-title">如果没有字幕时</p>
                    <p className="muted small">先查节目自带的字幕；没有时才听写。</p>
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
                          <p>本机模型</p>
                          <p className="muted small">免费，音频不出本机</p>
                        </div>
                      </button>
                      <button
                        type="button"
                        className={`engine ${!isLocal ? "on" : ""}`}
                        onClick={() => void saveSettings({ asrEngine: !isLocal ? settings.asrEngine : "openai" })}
                      >
                        <Cloud size={18} />
                        <div>
                          <p>云端服务</p>
                          <p className="muted small">更快，需要 Key，按量付费</p>
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
                              {a.name}
                            </button>
                          ))}
                          {!moreCloud && (
                            <button type="button" className="chip" onClick={() => setMoreCloud(true)}>
                              更多
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

              {section === "learn" && <LearnSettings />}

              {section === "general" && (
                <>
                  <section className="setup-block">
                    <p className="setup-title">界面</p>
                    <label>
                      <span>界面语言</span>
                      <select value={settings.uiLang} onChange={(e) => void saveSettings({ uiLang: e.target.value as LangSetting })}>
                        <option value="auto">跟随系统（{systemLangName()}）</option>
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
                      显示节目的 YouTube 订阅按钮
                    </label>
                    {settings.youtubePromo && (
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={!settings.homeBannerHidden}
                          onChange={(e) => void saveSettings({ homeBannerHidden: !e.target.checked })}
                        />{" "}
                        在发现页顶部显示推荐横幅
                      </label>
                    )}
                  </section>
                  <section className="setup-block">
                    <p className="setup-title">订阅</p>
                    <div className="row-actions">
                      <button type="button" className="btn sm" onClick={() => set({ settingsOpen: false, addOpen: true, addTab: "import" })}>
                        导入订阅…
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={async () => {
                          try {
                            const path = await api.exportOpml();
                            notify(`已导出到「下载」：${path.split(/[\\/]/).pop() ?? ""}`);
                            void revealItemInDir(path).catch(() => {});
                          } catch (e) {
                            notify(errText(e));
                          }
                        }}
                      >
                        导出 OPML
                      </button>
                    </div>
                  </section>
                  <section className="setup-block">
                    <p className="setup-title">网络</p>
                    <label>
                      <span>代理</span>
                      <div className="key-row">
                        <input {...NO_AUTO} value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder="留空就用系统代理" />
                        <button
                          type="button"
                          className="btn sm"
                          onClick={async () => {
                            try {
                              await saveSettings({ proxy });
                              notify("代理已保存");
                            } catch (e) {
                              notify(errText(e));
                            }
                          }}
                        >
                          保存
                        </button>
                      </div>
                    </label>
                    <label>
                      <span>YouTube 要求验证时</span>
                      <select
                        value={settings.ytCookiesBrowser ?? ""}
                        onChange={(e) => void saveSettings({ ytCookiesBrowser: e.target.value })}
                      >
                        <option value="">先问我</option>
                        {(IS_MAC ? ["chrome", "safari", "edge", "firefox", "brave"] : ["chrome", "edge", "firefox", "brave"]).map((b) => (
                          <option key={b} value={b}>
                            借用 {b[0]!.toUpperCase() + b.slice(1)} 的 YouTube 登录
                          </option>
                        ))}
                      </select>
                    </label>
                  </section>
                  <section className="setup-block">
                    <p className="setup-title">共享</p>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={settings.shareTranscripts}
                        onChange={(e) => void saveSettings({ shareTranscripts: e.target.checked })}
                      />{" "}
                      匿名分享我生成的字幕、译文和导读
                    </label>
                    <p className="muted small">只分享文字与匿名安装标识，帮别人跳过识别、机翻与导读。</p>
                  </section>
                  <section className="setup-block">
                    <button type="button" className="setting-row" aria-expanded={showKeys} onClick={() => setShowKeys(!showKeys)}>
                      <Keyboard size={15} /> <span>快捷键</span>
                      <span className="muted small">{kbd("⌘/")} 随时查看</span>
                      <ChevronDown size={14} className={showKeys ? "flip" : ""} />
                    </button>
                    {showKeys && <ShortcutSettings />}
                    <button
                      type="button"
                      className="setting-row"
                      aria-expanded={showStorage}
                      onClick={() => setShowStorage(!showStorage)}
                    >
                      <HardDrive size={15} /> <span>存储</span>
                      <StorageTotal />
                      <ChevronDown size={14} className={showStorage ? "flip" : ""} />
                    </button>
                    {showStorage && <Storage onAsr={() => setSection("subtitles")} />}
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
