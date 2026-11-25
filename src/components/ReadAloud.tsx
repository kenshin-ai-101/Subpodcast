/**
 * [INPUT]: 统一朗读会话、当前引擎和语速
 * [OUTPUT]: 朗读／停止与下拉快捷设置（Portal fixed 防裁切，含引擎、音色、语速与试听）
 * [POS]: 字幕中文朗读、导读脚注与精读顶栏共用
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Square, Volume2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { stopClip } from "../lib/clip";
import { useT } from "../lib/i18n";
import { localInstalled, refreshLocalTts, useLocalTts } from "../lib/localTts";
import { TTS_SERVICES } from "../lib/settings";
import { currentTtsService, speak, stopSpeaking } from "../lib/tts";
import { useStore } from "../store";
import { RateControl } from "./RatePicker";
import { LOCAL_TTS_MODELS, PreviewButton, useSystemVoices } from "./TtsSettings";

export function ReadAloud({ text, title }: { text: () => string; title?: string }) {
  const t = useT();
  const { speaking, notify } = useStore(useShallow((s) => ({ speaking: s.speaking, notify: s.notify })));
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

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
      <button type="button" className="icon-btn sm" aria-label={t("朗读设置")} title={t("朗读设置")} aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDown size={13} />
      </button>
      {open && <ReadAloudSettings anchorRef={box} onClose={() => setOpen(false)} />}
    </div>
  );
}

export function ReadAloudSettings({
  anchorRef,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const t = useT();
  const { service, save, set } = useStore(useShallow((s) => ({
    service: currentTtsService(s.settings), save: s.saveSettings, set: s.set,
  })));
  const status = useLocalTts((s) => s.status);
  const systemVoices = useSystemVoices(service.id === "system");
  const voices = service.id === "system" ? systemVoices : service.voices;
  const popRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({
    left: 0,
    top: 0,
    ready: false,
  });

  useEffect(() => { void refreshLocalTts().catch(() => {}); }, []);

  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current;
      const pop = popRef.current;
      if (!anchor || !pop) return;
      const r = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if ((r.width === 0 && r.height === 0) || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) {
        onCloseRef.current();
        return;
      }
      const margin = 12;
      const gap = 6;
      const w = pop.offsetWidth || 300;
      const h = pop.offsetHeight || 220;

      // 默认右对齐锚点；位于右栏内时优先保持在右栏内，再兜底夹紧到视口内
      let left = r.right - w;
      const panel = anchor.closest<HTMLElement>(".ep-right");
      if (panel) {
        const pr = panel.getBoundingClientRect();
        if (pr.width >= w + margin * 2) {
          left = Math.min(Math.max(pr.left + margin, left), pr.right - w - margin);
        }
      }
      left = Math.min(Math.max(margin, left), Math.max(margin, vw - w - margin));

      const preferTop = Boolean(anchor.closest(".summary-foot"));
      const below = r.bottom + gap;
      const above = r.top - gap - h;
      const top = preferTop
        ? above >= margin
          ? above
          : Math.min(below, Math.max(margin, vh - h - margin))
        : below + h <= vh - margin
          ? below
          : above >= margin
            ? above
            : Math.max(margin, vh - h - margin);

      setPos({ left: Math.round(left), top: Math.round(top), ready: true });
    };

    place();
    const ro = new ResizeObserver(place);
    if (popRef.current) ro.observe(popRef.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    const closeOutside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!popRef.current?.contains(target) && !anchorRef.current?.contains(target)) {
        onCloseRef.current();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [anchorRef]);

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
  return createPortal(
    <div
      ref={popRef}
      className="read-aloud-pop"
      role="dialog"
      aria-label={t("朗读设置")}
      style={{
        left: pos.left,
        top: pos.top,
        visibility: pos.ready ? "visible" : "hidden",
      }}
    >
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
      <div className="tts-field">
        <span>{t("朗读语速")}</span>
        <RateControl />
      </div>
      <div className="row-actions">
        <PreviewButton service={service} disabled={missing} />
        <button type="button" className="link-btn small" onClick={() => {
          stopSpeaking();
          onClose();
          set({ settingsOpen: true, settingsSection: "tts" });
        }}>{t("打开朗读设置")}</button>
      </div>
      {service.group === "cloud" && <p className="privacy-note">{t("朗读文字会发送到所选服务。")}</p>}
    </div>,
    document.body,
  );
}
