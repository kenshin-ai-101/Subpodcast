/**
 * [INPUT]: 统一朗读会话、当前引擎和语速
 * [OUTPUT]: 朗读／停止、语速和引擎快捷入口
 * [POS]: 导读脚注与精读顶栏
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Square, Volume2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { stopClip } from "../lib/clip";
import { useT } from "../lib/i18n";
import { localInstalled, refreshLocalTts, useLocalTts } from "../lib/localTts";
import { TTS_SERVICES } from "../lib/settings";
import { currentTtsService, speak, stopSpeaking } from "../lib/tts";
import { useStore } from "../store";
import { RateControl, RatePicker } from "./RatePicker";
import { LOCAL_TTS_MODELS, PreviewButton, useSystemVoices } from "./TtsSettings";

export function ReadAloud({ text, title }: { text: () => string; title?: string }) {
  const t = useT();
  const { speaking, notify } = useStore(useShallow((s) => ({ speaking: s.speaking, notify: s.notify })));
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const read = () => {
    stopClip();
    void speak(text(), (message) => {
      notify(message);
      if (/Key|下载|下載|download/i.test(message)) setOpen(true);
    });
  };
  return (
    <div className="read-aloud" ref={box}>
      <button type="button" className="btn sm" title={title ?? t("朗读")} onClick={speaking ? stopSpeaking : read}>
        {speaking ? <Square size={11} /> : <Volume2 size={13} />}
        {speaking ? t("停止朗读") : t("朗读")}
      </button>
      <RatePicker />
      <button type="button" className="icon-btn sm" aria-label={t("朗读引擎与音色")} title={t("朗读引擎与音色")} aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDown size={13} />
      </button>
      {open && <ReadAloudSettings onClose={() => setOpen(false)} />}
    </div>
  );
}

export function ReadAloudSettings({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { service, save, set } = useStore(useShallow((s) => ({
    service: currentTtsService(s.settings), save: s.saveSettings, set: s.set,
  })));
  const status = useLocalTts((s) => s.status);
  const systemVoices = useSystemVoices(service.id === "system");
  const voices = service.id === "system" ? systemVoices : service.voices;
  useEffect(() => { void refreshLocalTts().catch(() => {}); }, []);

  const select = (value: string) => {
    stopSpeaking();
    const local = LOCAL_TTS_MODELS.find(({ id }) => id === value);
    const settings = useStore.getState().settings;
    if (local) {
      void save({
        ttsEngine: "local",
        ttsServices: { ...settings.ttsServices, local: { ...settings.ttsServices.local, model: local.id } },
      });
    } else {
      void save({ ttsEngine: value });
    }
  };

  const setVoice = (value: string) => {
    stopSpeaking();
    const settings = useStore.getState().settings;
    void save({ ttsServices: { ...settings.ttsServices, [service.id]: { ...service, voice: value } } });
  };
  const missing = service.id === "local" && !localInstalled(status, service.model ?? "melo");
  return (
    <div className="read-aloud-pop" role="dialog" aria-label={t("朗读设置")}>
      <label className="tts-field">
        {t("引擎")}
        <select value={service.id === "local" ? service.model ?? "melo" : service.id} onChange={(e) => select(e.target.value)}>
          <option value="system">{t("系统增强语音")}</option>
          {LOCAL_TTS_MODELS.map(({ id, name }) =>
            <option key={id} value={id} disabled={!localInstalled(status, id)}>{t(name)}</option>
          )}
          <optgroup label={t("云端")}>
            {TTS_SERVICES.filter((item) => item.group === "cloud").map((item) => (
              <option key={item.id} value={item.id}>{t(item.name)}</option>
            ))}
          </optgroup>
        </select>
      </label>
      {voices.length > 0 && (service.id !== "local" || service.model === "kokoro") && (
        <label className="tts-field">
          {t("音色")}
          <select value={service.voice} onChange={(e) => setVoice(e.target.value)}>
            {service.id === "system" && <option value="">{t("按语言自动选择")}</option>}
            {service.voice && !voices.some((v) => v.id === service.voice) && <option value={service.voice}>{service.voice}</option>}
            {voices.map((voice) => <option key={voice.id} value={voice.id}>{t(voice.name)}</option>)}
          </select>
        </label>
      )}
      <label className="tts-field">
        {t("朗读语速")}
        <RateControl />
      </label>
      <div className="row-actions">
        <PreviewButton service={service} disabled={missing} />
        <button type="button" className="link-btn small" onClick={() => {
          stopSpeaking();
          onClose();
          set({ settingsOpen: true, settingsSection: "tts" });
        }}>{t("打开朗读设置")}</button>
      </div>
      {service.group === "cloud" && <p className="privacy-note">{t("朗读文字会发送到所选服务。")}</p>}
    </div>
  );
}
