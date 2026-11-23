/**
 * [INPUT]: settings.ttsRate 与朗读速度档位
 * [OUTPUT]: RateControl 分段控件、RatePicker 紧凑弹层
 * [POS]: 朗读设置和导读／精读工具栏
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { TTS_RATES } from "../lib/settings";
import { useStore } from "../store";

export function RateControl({ onPick }: { onPick?: () => void }) {
  const { rate, save } = useStore(useShallow((s) => ({ rate: s.settings.ttsRate, save: s.saveSettings })));
  return (
    <div className="tts-rate" role="group" aria-label="朗读语速">
      {TTS_RATES.map((value) => (
        <button type="button" key={value} aria-pressed={rate === value} onClick={() => {
          void save({ ttsRate: value });
          onPick?.();
        }}>
          {value}×
        </button>
      ))}
    </div>
  );
}

export function RatePicker() {
  const rate = useStore((s) => s.settings.ttsRate);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="tts-rate-picker" ref={root}>
      <button type="button" className="btn sm" title="朗读语速" aria-label={`朗读语速 ${rate} 倍`} aria-expanded={open} onClick={() => setOpen(!open)}>
        {rate}× <ChevronDown size={12} />
      </button>
      {open && <div className="tts-rate-pop"><RateControl onPick={() => setOpen(false)} /></div>}
    </div>
  );
}
