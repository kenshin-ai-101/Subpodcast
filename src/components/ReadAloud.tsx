/**
 * [INPUT]: tts.speak/stopSpeaking；settings.ttsVoice/ttsResource/VOICES；KeyField；store.speaking
 * [OUTPUT]: ReadAloud 按钮 + 音色/Key 小弹层
 * [POS]: 导读脚注与精读顶栏；朗读时暂停播客
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown, ExternalLink, Square, Volume2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { VOICES } from "../lib/settings";
import { speak, stopSpeaking } from "../lib/tts";
import { useStore } from "../store";
import { KeyField } from "./SettingsDialog";

const NO_AUTO = { autoCapitalize: "off" as const, autoCorrect: "off" as const, spellCheck: false };

export function ReadAloud({ text, title }: { text: () => string; title?: string }) {
  const speaking = useStore((s) => s.speaking);
  const notify = useStore((s) => s.notify);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", h);
    return () => document.removeEventListener("pointerdown", h);
  }, [open]);

  const read = () =>
    void speak(text(), (m) => {
      notify(m);
      if (m.includes("Key")) setOpen(true);
    });

  return (
    <div className="read-aloud" ref={box}>
      {speaking ? (
        <button type="button" className="btn sm" onClick={stopSpeaking}>
          <Square size={11} /> 停止朗读
        </button>
      ) : (
        <button type="button" className="btn sm" title={title ?? "朗读"} onClick={read}>
          <Volume2 size={13} /> 朗读
        </button>
      )}
      <button
        type="button"
        className="icon-btn sm"
        aria-label="朗读设置"
        title="朗读设置"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronDown size={13} />
      </button>
      {open && <ReadAloudSettings />}
    </div>
  );
}

function ReadAloudSettings() {
  const { settings, saveSettings } = useStore(
    useShallow((s) => ({ settings: s.settings, saveSettings: s.saveSettings })),
  );
  const [custom, setCustom] = useState(!VOICES.some(([id]) => id === settings.ttsVoice));
  return (
    <div className="read-aloud-pop" role="dialog" aria-label="朗读设置">
      <p className="setup-title">音色</p>
      <div className="model-chips">
        {VOICES.map(([id, name]) => (
          <button
            key={id}
            type="button"
            className={`chip sm ${settings.ttsVoice === id ? "on" : ""}`}
            onClick={() => void saveSettings({ ttsVoice: id, ttsResource: "seed-tts-2.0" })}
          >
            {name}
          </button>
        ))}
      </div>
      <p className="setup-title">豆包语音 Key</p>
      <KeyField account="tts.doubao" placeholder="填过豆包语音识别的可以留空" />
      <div className="row-actions">
        <button
          type="button"
          className="link-btn small"
          onClick={() =>
            void openUrl(
              "https://console.volcengine.com/speech/new/setting/apikeys?projectName=default",
            )
          }
        >
          <ExternalLink size={12} /> 获取 Key
        </button>
        <span className="spacer" />
        <button type="button" className="link-btn small" onClick={() => setCustom(!custom)}>
          自定义音色
        </button>
      </div>
      {custom && (
        <>
          <input
            {...NO_AUTO}
            value={settings.ttsVoice}
            onChange={(e) => void saveSettings({ ttsVoice: e.target.value.trim() })}
            placeholder="复刻音色或其他音色的 ID"
          />
          <label className="check">
            <input
              type="checkbox"
              checked={settings.ttsResource === "seed-icl-2.0"}
              onChange={(e) =>
                void saveSettings({
                  ttsResource: e.target.checked ? "seed-icl-2.0" : "seed-tts-2.0",
                })
              }
            />{" "}
            这是我复刻的声音
          </label>
        </>
      )}
      <p className="muted small">朗读时文字会发送到豆包语音。</p>
    </div>
  );
}
