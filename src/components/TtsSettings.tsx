/**
 * [INPUT]: TTS 服务、音色、系统语音、模型安装状态与 API Key
 * [OUTPUT]: 设置 › 朗读，含下载、试听和语速控制
 * [POS]: 本地与云端朗读配置
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useId, useState } from "react";
import { Check, Cloud, Cpu, Download, ExternalLink, Square, Trash2, Volume2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import { api, errText, type LocalModelId, type SystemVoice } from "../lib/api";
import { ask } from "../lib/confirm";
import { cancelLocalTts, deleteLocalTts, installLocalTts, localInstalled, refreshLocalTts, useLocalTts } from "../lib/localTts";
import { bytes } from "../lib/offline";
import { TTS_CLOUD_MAIN, TTS_SERVICES, type TtsService, type TtsVoice } from "../lib/settings";
import { currentTtsService, listWebSystemVoices, previewVoice, stopSpeaking, useTtsPreview } from "../lib/tts";
import { RateControl } from "./RatePicker";
import { KeyField } from "./SettingsDialog";

const NO_AUTO = { autoCapitalize: "off" as const, autoCorrect: "off" as const, spellCheck: false };
export const LOCAL_TTS_MODELS: { id: LocalModelId; name: string; description: string }[] = [
  { id: "melo", name: "Melo", description: "离线朗读，支持中文和英文" },
  { id: "kokoro", name: "Kokoro", description: "离线朗读，可选多种音色" },
];

export function useSystemVoices(enabled: boolean): SystemVoice[] {
  const [voices, setVoices] = useState<SystemVoice[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let native: SystemVoice[] = [];
    const refresh = () => {
      const web = listWebSystemVoices();
      const labels = new Set(web.map((v) => `${v.name}:${v.lang.replaceAll("_", "-")}`));
      setVoices([...web, ...native.filter((v) => !labels.has(`${v.name}:${v.lang}`))]);
    };
    refresh();
    void api.ttsSystemVoices().then((items) => {
      if (active) {
        native = items;
        refresh();
      }
    }).catch(() => {});
    const synthesis = window.speechSynthesis;
    synthesis?.addEventListener("voiceschanged", refresh);
    return () => {
      active = false;
      synthesis?.removeEventListener("voiceschanged", refresh);
    };
  }, [enabled]);
  return enabled ? voices : [];
}

export function PreviewButton({ service, disabled }: { service: TtsService; disabled?: boolean }) {
  const active = useTtsPreview((s) => s.active);
  const playing = active === `${service.id}:${service.model ?? ""}:${service.voice}`;
  return (
    <button className="btn sm" type="button" disabled={disabled} onClick={() => void previewVoice(service.id, service.voice)}>
      {playing ? <Square size={12} /> : <Volume2 size={13} />}
      {playing ? "停止试听" : "试听"}
    </button>
  );
}

function updateService(id: string, patch: Partial<TtsService>, activate = false) {
  const { settings, saveSettings, notify } = useStore.getState();
  void saveSettings({
    ...(activate ? { ttsEngine: id } : {}),
    ttsServices: { ...settings.ttsServices, [id]: { ...settings.ttsServices[id], ...patch } },
  }).catch((error) => notify(errText(error)));
}

function VoicePicker({ service, voices, children }: { service: TtsService; voices: TtsVoice[]; children?: React.ReactNode }) {
  const id = useId();
  const hasCustom = !voices.some((option) => option.id === service.voice) && !!service.voice;
  const [customMode, setCustom] = useState<boolean | null>(null);
  const custom = customMode ?? (hasCustom || service.id === "custom");

  return (
    <>
      <div className="tts-field">
        <label htmlFor={id}>音色</label>
        <div className="row-actions">
          {voices.length > 0 && (
            <select id={id} value={custom ? "__custom__" : service.voice} onChange={(event) => {
              const value = event.target.value;
              setCustom(value === "__custom__");
              if (value !== "__custom__") updateService(service.id, { voice: value });
            }}>
              {service.id === "system" && <option value="">按语言自动选择</option>}
              {voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
              <option value="__custom__">自定义音色</option>
            </select>
          )}
          {children}
        </div>
      </div>
      {(custom || (!voices.length && service.id !== "system")) && (
        <input {...NO_AUTO} aria-label="音色 ID" value={service.voice} onChange={(event) =>
          updateService(service.id, { voice: event.target.value })} placeholder="音色 ID" />
      )}
    </>
  );
}

function ModelCard({ id, name, description }: (typeof LOCAL_TTS_MODELS)[number]) {
  const { state, downloading, busy, supported } = useLocalTts(useShallow((s) => ({
    state: s.status?.models.find((model) => model.id === id),
    downloading: s.downloading?.id === id ? s.downloading : null,
    busy: !!s.downloading,
    supported: s.status?.supported,
  })));
  const selected = useStore((s) => s.settings.ttsEngine === "local" && s.settings.ttsServices.local.model === id);
  const notify = useStore((s) => s.notify);

  const select = () => {
    stopSpeaking();
    updateService("local", { model: id }, true);
    if (!state?.installed && !busy) void installLocalTts(id);
  };
  const remove = async () => {
    if (!(await ask(`删除「${name}」本地语音模型？下次使用时需要重新下载。`))) return;
    stopSpeaking();
    await deleteLocalTts(id);
    const store = useStore.getState();
    if (store.settings.ttsEngine === "local" && store.settings.ttsServices.local.model === id) {
      await store.saveSettings({ ttsEngine: "system" });
    }
  };
  const percent = downloading?.total ? Math.min(100, Math.round(100 * downloading.received / downloading.total)) : null;
  return (
    <div className={`voice-card${selected ? " on" : ""}`}>
      <button type="button" className="voice-card-pick" aria-pressed={selected} disabled={!supported || (busy && !state?.installed)} onClick={select}>
        <span>{name}</span>
        <small className="muted">{description}</small>
      </button>
      <div className="voice-card-actions">
        {downloading ? (
          <>
            <progress aria-label={`${name} 下载进度`} max={100} value={percent ?? undefined} />
            <span className="small" aria-live="polite">{percent == null ? "下载中" : `${percent}%`}</span>
            <button type="button" className="btn ghost sm" onClick={() => void cancelLocalTts(id).catch((e) => notify(errText(e)))}>取消</button>
          </>
        ) : state?.installed ? (
          <>
            <span className="voice-card-ok"><Check size={13} /> 已下载</span>
            <button type="button" className="icon-btn sm" aria-label={`删除 ${name}`} title={`删除 ${name}`} onClick={() => void remove().catch((e) => notify(errText(e)))}>
              <Trash2 size={14} />
            </button>
          </>
        ) : supported ? (
          <>
            <span className="muted small">{state ? bytes(state.bytes) : "首次使用需下载"}</span>
            <button type="button" className="btn sm" disabled={busy} onClick={select}><Download size={13} /> 下载</button>
          </>
        ) : <span className="muted small">{supported === false ? "此平台暂不支持" : "正在检查"}</span>}
      </div>
    </div>
  );
}

function TtsKey({ service }: { service: TtsService }) {
  const [shared, setShared] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all((service.sharedAccounts ?? []).map((id) => api.hasApiKey(id).catch(() => false))).then((keys) => {
      if (active) setShared(keys.some(Boolean));
    });
    return () => { active = false; };
  }, [service.sharedAccounts]);
  if (!service.needsKey && service.id !== "custom") return null;
  const placeholder = service.id === "custom" ? "API Key（可选）" : shared ? "已配置共享 Key，专用 Key 可留空" : "输入 API Key";
  return (
    <div className="setup-block">
      <div className="row-actions">
        <p className="setup-title">API Key</p>
        {service.keyUrl && <button className="btn ghost sm" type="button" onClick={() => void openUrl(service.keyUrl!)}><ExternalLink size={13} /> 获取 Key</button>}
      </div>
      <KeyField account={`tts.${service.id}`} placeholder={placeholder} />
      {!!service.sharedAccounts?.length && <p className="muted small">{shared ? "留空会使用已配置的共享 Key。" : "配置该服务的 AI 或字幕 Key 后，可以在这里共用。"}</p>}
    </div>
  );
}

function CloudSettings({ service }: { service: TtsService }) {
  const modelList = useId();
  return (
    <>
      {service.id === "custom" && (
        <label className="tts-field">
          接口地址
          <input {...NO_AUTO} value={service.baseUrl ?? ""} onChange={(e) => updateService(service.id, { baseUrl: e.target.value })} placeholder="http://127.0.0.1:8880/v1" />
        </label>
      )}
      {!!service.models?.length && (
        <label className="tts-field">
          模型
          <input {...NO_AUTO} list={modelList} value={service.model ?? ""} onChange={(e) => updateService(service.id, { model: e.target.value })} />
          <datalist id={modelList}>
            {service.models.map((model) => <option key={model} value={model} />)}
          </datalist>
        </label>
      )}
      <VoicePicker service={service} voices={service.voices}><PreviewButton service={service} /></VoicePicker>
      {service.id === "doubao" && (
        <label className="check">
          <input type="checkbox" checked={service.resource === "seed-icl-2.0"} onChange={(e) =>
            updateService(service.id, { resource: e.target.checked ? "seed-icl-2.0" : "seed-tts-2.0" })} />
          使用复刻音色
        </label>
      )}
      <TtsKey service={service} />
    </>
  );
}

export function TtsSettings() {
  const { service, save, notify } = useStore(useShallow((s) => ({
    service: currentTtsService(s.settings), save: s.saveSettings, notify: s.notify,
  })));
  const status = useLocalTts((s) => s.status);
  const sysVoices = useSystemVoices(service.id === "system");
  const [more, setMore] = useState(!TTS_CLOUD_MAIN.includes(service.id) && service.group === "cloud");
  const local = service.group === "local";
  useEffect(() => {
    void refreshLocalTts().catch((error) => notify(errText(error)));
  }, [notify]);

  const choose = (id: string) => {
    stopSpeaking();
    void save({ ttsEngine: id });
  };

  return (
    <div className="tts-settings">
      <section className="setup-block">
        <p className="setup-title">朗读引擎</p>
        <div className="model-chips" role="group" aria-label="朗读引擎类型">
          <button className={`chip${local ? " on" : ""}`} type="button" aria-pressed={local} onClick={() => { if (!local) choose("system"); }}><Cpu size={14} /> 本地</button>
          <button className={`chip${local ? "" : " on"}`} type="button" aria-pressed={!local} onClick={() => { if (local) choose("doubao"); }}><Cloud size={14} /> 云端</button>
        </div>
        {local ? (
          <>
            <div className={`voice-card${service.id === "system" ? " on" : ""}`}>
              <button className="voice-card-pick" type="button" aria-pressed={service.id === "system"} onClick={() => choose("system")}>
                <span>系统增强语音</span>
                <small className="muted">优先使用设备已安装的增强音色</small>
              </button>
              <span className="voice-card-ok"><Check size={13} /> 无需下载</span>
            </div>
            {LOCAL_TTS_MODELS.map((model) => <ModelCard key={model.id} {...model} />)}
            {service.id === "system" ? (
              <VoicePicker key={service.id} service={service} voices={sysVoices.map((voice) => ({ id: voice.id, name: `${voice.name} · ${voice.lang}` }))}>
                <PreviewButton service={service} />
              </VoicePicker>
            ) : service.model === "kokoro" ? (
              <VoicePicker key={service.model} service={service} voices={service.voices}>
                <PreviewButton service={service} disabled={!localInstalled(status, "kokoro")} />
              </VoicePicker>
            ) : (
              <div className="row-actions"><PreviewButton service={service} disabled={!localInstalled(status, "melo")} /></div>
            )}
          </>
        ) : (
          <>
            <div className="model-chips" role="group" aria-label="云端朗读服务">
              {TTS_SERVICES.filter((item) => item.group === "cloud" && (more || TTS_CLOUD_MAIN.includes(item.id) || item.id === service.id))
                .map((item) => (
                  <button key={item.id} className={`chip${service.id === item.id ? " on" : ""}`} type="button" aria-pressed={service.id === item.id} onClick={() => choose(item.id)}>
                    {item.name}
                  </button>
                ))}
              <button className="link-btn small" type="button" aria-expanded={more} onClick={() => setMore(!more)}>{more ? "收起其他服务" : "更多服务"}</button>
            </div>
            <CloudSettings key={service.id} service={service} />
          </>
        )}
        <p className="privacy-note">{local ? "朗读在本机处理，文字留在此设备。" : `朗读和试听的文字会发送到${service.id === "custom" ? "配置的服务地址" : ` ${service.name}`}。`}</p>
      </section>

      <section className="setup-block">
        <p className="setup-title">语速</p>
        <RateControl />
      </section>
    </div>
  );
}
