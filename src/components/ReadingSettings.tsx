/**
 * [INPUT]: store.settings / saveSettings；jobs 当前集字幕作实时预览；lib/reading 缩放工具；layout.transcriptBelow
 * [OUTPUT]: Seg、SubSizeSliders、ReadingSettings（显示模式 / 中外双滑块字号 / 字体 / 视频样式 / 字幕列表位置 / 音频下句 / 问答字号 / 自动连播）
 * [POS]: 设置 › 字幕 顶部阅读块；SubSizeSliders 同时供视频画中 Aa 快捷面板复用
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useShallow } from "zustand/react/shallow";
import { SUB_FONT_DEFS } from "../lib/fonts";
import { useT } from "../lib/i18n";
import { useJobs } from "../lib/jobs";
import { useLayout } from "../lib/layout";
import {
  resolveOrigScale,
  resolveSubScale,
  SCALE_MAX,
  SCALE_MIN,
  SUB_FONTS,
  updateOrigScale,
  updateSubScale,
} from "../lib/reading";
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
        <button
          key={String(k)}
          type="button"
          role="radio"
          aria-checked={value === k}
          className={value === k ? "on" : ""}
          onClick={() => onChange(k)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** 中文字幕与原文字幕双滑块；设置页与视频画中 Aa 面板共用。 */
export function SubSizeSliders() {
  const t = useT();
  const s = useStore(
    useShallow((x) => ({
      subtitleScale: x.settings.subtitleScale,
      subtitleSize: x.settings.subtitleSize,
      subtitleOrigScale: x.settings.subtitleOrigScale,
    })),
  );
  const rows: [string, number, (v: number) => void][] = [
    [t("中文"), resolveSubScale(s), updateSubScale],
    [t("原文"), resolveOrigScale(s), updateOrigScale],
  ];
  return (
    <>
      {rows.map(([label, val, apply]) => {
        const pct = Math.round(val * 100);
        return (
          <div className="size-row" key={label}>
            <span>{label}</span>
            <input
              type="range"
              min={Math.round(SCALE_MIN * 100)}
              max={Math.round(SCALE_MAX * 100)}
              step={5}
              value={pct}
              aria-label={t("{line}字幕大小", { line: label })}
              onChange={(e) => apply(Number(e.target.value) / 100)}
            />
            <span className="num size-val">{pct}%</span>
          </div>
        );
      })}
    </>
  );
}

export function ReadingSettings() {
  const t = useT();
  const { settings, saveSettings, current } = useStore(
    useShallow((s) => ({ settings: s.settings, saveSettings: s.saveSettings, current: s.current })),
  );
  const below = useLayout((l) => l.transcriptBelow);
  const save = (p: Partial<Settings>) => void saveSettings(p);
  const tr = useJobs((s) => (current ? s.transcripts[current.id] : undefined));
  const items = useJobs((s) => (current ? s.translations[current.id]?.items : undefined));
  const k = tr?.segments.findIndex((_, i) => !!items?.[i]) ?? -1;
  const orig =
    k >= 0
      ? tr!.segments[k]!.text
      : "The most important thing is to keep learning faster than the world changes.";
  const zh = k >= 0 ? items![k]! : t("最重要的是，学习的速度要比世界变化的速度更快。");
  const fontName = (id: keyof typeof SUB_FONTS) =>
    t(SUB_FONT_DEFS.find((f) => f.id === id)?.name ?? id);

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
        <p className="setup-title">{t("字幕")}</p>
        <div className="reading-row">
          <span>{t("显示")}</span>
          <Seg
            value={settings.subtitleMode}
            options={[
              ["bilingual", t("双语")],
              ["translation", t("中文")],
              ["original", t("原文")],
            ]}
            onChange={(v) => save({ subtitleMode: v })}
          />
        </div>
        <div className="reading-row">
          <span>{t("字号")}</span>
          <div className="reading-sizes">
            <SubSizeSliders />
          </div>
        </div>
        <div className="reading-row">
          <span>{t("字体")}</span>
          <Seg
            value={settings.subtitleFont ?? "sans"}
            options={(Object.keys(SUB_FONTS) as (keyof typeof SUB_FONTS)[]).map((id) => [
              id,
              fontName(id),
            ])}
            onChange={(v) => save({ subtitleFont: v })}
          />
        </div>
        <p className="muted small reading-note">{t("字体同时用于中文和原文两行。")}</p>
        <div className="reading-row">
          <span>{t("视频上的字幕")}</span>
          <Seg
            value={settings.subtitleLook ?? "outline"}
            options={[
              ["box", t("半透明底")],
              ["outline", t("描边，无底")],
            ]}
            onChange={(v) => save({ subtitleLook: v })}
          />
        </div>
        <div className="reading-row">
          <span>{t("字幕列表")}</span>
          <Seg
            value={below ? "below" : "side"}
            options={[
              ["side", t("右侧栏")],
              ["below", t("播放器下方")],
            ]}
            onChange={(v) => useLayout.getState().put({ transcriptBelow: v === "below" })}
          />
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.audioNextLine === true}
            onChange={(e) => save({ audioNextLine: e.target.checked })}
          />{" "}
          {t("音频节目提前显示下一句")}
        </label>
      </section>

      <section className="setup-block">
        <p className="setup-title">{t("AI 问答与导读")}</p>
        <div className="reading-row">
          <span>{t("字号")}</span>
          <Seg
            value={settings.chatSize ?? "m"}
            options={[
              ["m", t("标准")],
              ["l", t("大")],
            ]}
            onChange={(v) => save({ chatSize: v })}
          />
        </div>
      </section>

      <section className="setup-block">
        <p className="setup-title">{t("播放")}</p>
        <label className="check">
          <input
            type="checkbox"
            checked={!!settings.autoNext}
            onChange={(e) => save({ autoNext: e.target.checked })}
          />{" "}
          {t("播完一集，自动接着播同一节目的下一集")}
        </label>
      </section>
    </div>
  );
}
