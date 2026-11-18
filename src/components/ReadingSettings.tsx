/**
 * [INPUT]: store.settings / saveSettings；jobs 当前集字幕作预览
 * [OUTPUT]: Seg、ReadingSettings（字号/字体/视频字幕样式/问答字号/自动下一集）
 * [POS]: 设置 › 字幕 顶部阅读块；对齐 SubCast 阅读区布局
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useShallow } from "zustand/react/shallow";
import { SUB_FONT_DEFS } from "../lib/fonts";
import { useJobs } from "../lib/jobs";
import { SUB_FONTS } from "../lib/reading";
import type { Settings } from "../lib/settings";
import { useStore } from "../store";

export function Seg<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg-control" role="radiogroup">
      {options.map(([k, label]) => (
        <button key={String(k)} type="button" role="radio" aria-checked={value === k} className={value === k ? "on" : ""} onClick={() => onChange(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function ReadingSettings() {
  const { settings, saveSettings, current } = useStore(
    useShallow((s) => ({ settings: s.settings, saveSettings: s.saveSettings, current: s.current })),
  );
  const save = (p: Partial<Settings>) => void saveSettings(p);
  const tr = useJobs((s) => (current ? s.transcripts[current.id] : undefined));
  const items = useJobs((s) => (current ? s.translations[current.id]?.items : undefined));
  const k = tr?.segments.findIndex((_, i) => !!items?.[i]) ?? -1;
  const orig = k >= 0 ? tr!.segments[k]!.text : "The most important thing is to keep learning faster than the world changes.";
  const zh = k >= 0 ? items![k]! : "最重要的是，学习的速度要比世界变化的速度更快。";
  const fontName = (id: keyof typeof SUB_FONTS) => SUB_FONT_DEFS.find((f) => f.id === id)?.name ?? id;

  return (
    <div className="reading">
      <div className={`reading-preview look-${settings.subtitleLook ?? "outline"}`} aria-hidden>
        <div className="subtitle-overlay">
          <div className="sub-box">
            {settings.subtitleMode !== "original" && <p className="sub-zh">{zh}</p>}
            {settings.subtitleMode !== "translation" && <p className="sub-orig">{orig}</p>}
          </div>
        </div>
      </div>

      <section className="setup-block">
        <p className="setup-title">字幕</p>
        <div className="reading-row">
          <span>字号</span>
          <Seg
            value={settings.subtitleSize ?? "m"}
            options={
              [
                ["s", "小"],
                ["m", "标准"],
                ["l", "大"],
                ["xl", "特大"],
              ] as const
            }
            onChange={(v) => save({ subtitleSize: v })}
          />
        </div>
        <div className="reading-row">
          <span>字体</span>
          <Seg
            value={settings.subtitleFont ?? "sans"}
            options={(Object.keys(SUB_FONTS) as (keyof typeof SUB_FONTS)[]).map((id) => [id, fontName(id)])}
            onChange={(v) => save({ subtitleFont: v })}
          />
        </div>
        <div className="reading-row">
          <span>视频上的字幕</span>
          <Seg
            value={settings.subtitleLook ?? "outline"}
            options={
              [
                ["box", "半透明底"],
                ["outline", "描边，无底"],
              ] as const
            }
            onChange={(v) => save({ subtitleLook: v })}
          />
        </div>
        <label className="check">
          <input type="checkbox" checked={settings.audioNextLine === true} onChange={(e) => save({ audioNextLine: e.target.checked })} />{" "}
          音频节目提前显示下一句
        </label>
      </section>

      <section className="setup-block">
        <p className="setup-title">AI 问答</p>
        <div className="reading-row">
          <span>字号</span>
          <Seg
            value={settings.chatSize ?? "m"}
            options={
              [
                ["m", "标准"],
                ["l", "大"],
              ] as const
            }
            onChange={(v) => save({ chatSize: v })}
          />
        </div>
      </section>

      <section className="setup-block">
        <p className="setup-title">播放</p>
        <label className="check">
          <input type="checkbox" checked={!!settings.autoNext} onChange={(e) => save({ autoNext: e.target.checked })} />{" "}
          播完一集，自动接着播同一节目的下一集
        </label>
      </section>
    </div>
  );
}
