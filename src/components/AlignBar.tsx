/**
 * [INPUT]: store.align / current / time / settings.skipAds；event align；timemap.alignCurrent / setManualMap / nudgeFromHere / gaps / toPlay
 * [OUTPUT]: AlignBar — 字幕对齐条（自动声纹/语音探针对齐 / 点句锚点 / ±1s / 偏移徽章 / 恢复 / 跳广告）
 * [POS]: 字幕面板顶栏；HTMLAudio 播音轨时可用
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Crosshair, Loader2, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useT } from "../lib/i18n";
import { alignCurrent, gaps, nudgeFromHere, setManualMap, toPlay } from "../lib/timemap";
import { useStore } from "../store";

export function AlignBar({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { align, currentId, time, skipAds, saveSettings } = useStore(
    useShallow((s) => ({
      align: s.current && s.align?.id === s.current.id ? s.align : null,
      currentId: s.current?.id ?? null,
      time: Math.floor(s.time),
      skipAds: !!s.settings.skipAds,
      saveSettings: s.saveSettings,
    })),
  );
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    setProgress(null);
    const off = listen<{ episodeId: string; progress: number | null }>("align", (e) => {
      if (e.payload.episodeId === currentId) setProgress(e.payload.progress);
    });
    return () => {
      void off.then((f) => f());
    };
  }, [currentId]);

  const working = align?.status === "working";
  const ads = gaps(align?.map).length;
  const rawOffset = align?.map?.pieces.length
    ? Math.round((toPlay(align.map, time) - time) * 10) / 10
    : 0;
  const offsetBadge =
    Math.abs(rawOffset) >= 0.1 ? `${rawOffset > 0 ? "+" : ""}${rawOffset.toFixed(1)}s` : null;
  const status = working
    ? progress != null
      ? t("正在下载你听到的这份音频来比对 {pct}%", { pct: Math.round(progress * 100) })
      : t("正在比对字幕和你听到的音频，可能要一两分钟…")
    : align?.status === "aligned" && align.map?.method === "manual"
      ? t("字幕时间已按你点的位置调整")
      : align?.status === "aligned"
        ? ads
          ? t("已按你听到的音频对齐，其中 {n} 段只在你的音频里有（多半是广告）", { n: ads })
          : t("已按你听到的音频对齐")
        : align?.status === "same"
          ? t("字幕就是按你听到的这份音频做的，时间应该一致")
          : align?.status === "failed"
            ? t("两份音频差别太大，没能自动对齐")
            : t("这份字幕没记下它对应哪份音频。点「自动对齐」，会听几段你的音频来比对");

  return (
    <div className="align-bar">
      <div className="align-row">
        {working ? <Loader2 size={13} className="spin" /> : <Crosshair size={13} />}
        <span className="align-status">{status}</span>
        {offsetBadge && (
          <span className="align-offset num" title={t("当前字幕时间偏移")}>
            {offsetBadge}
          </span>
        )}
        <button type="button" className="icon-btn sm" onClick={onClose} aria-label={t("关闭")}>
          <X size={14} />
        </button>
      </div>
      <p className="align-hint">{t("边听边点：听到哪句就点哪句，从那句起字幕会对上声音。")}</p>
      <div className="align-row">
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => nudgeFromHere(-1)}
          title={t("从当前这句起，字幕早 1 秒出现")}
        >
          {t("字幕提前 1 秒")}
        </button>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => nudgeFromHere(1)}
          title={t("从当前这句起，字幕晚 1 秒出现")}
        >
          {t("字幕推后 1 秒")}
        </button>
        <button
          type="button"
          className="btn ghost sm"
          disabled={working}
          onClick={() => void alignCurrent(true)}
        >
          {t("重新自动对齐")}
        </button>
        {align?.map && (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() =>
              void setManualMap({
                playBytes: align.localBytes,
                method: "manual",
                pieces: [],
              })
            }
          >
            {t("恢复原始时间")}
          </button>
        )}
      </div>
      {ads > 0 && (
        <label className="align-check">
          <input
            type="checkbox"
            checked={skipAds}
            onChange={(e) => void saveSettings({ skipAds: e.target.checked })}
          />
          {t("自动跳过只在你的音频里的片段")}
        </label>
      )}
    </div>
  );
}
