/**
 * [INPUT]: showLinks、pickName、openUrl（Tauri）
 * [OUTPUT]: YtButton、YtVideoStrip、AlsoOn、HomeShowBanner、usePromo
 * [POS]: 发现横幅 / 单集页订阅条 / YouTube 推广
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { Check, Loader2, Plus, X, Youtube } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useT } from "../lib/i18n";
import { pickName } from "../lib/picks";
import { homeShow, showLinks, subscribeUrl } from "../lib/showLinks";
import { useStore } from "../store";

export const usePromo = () => useStore((s) => s.settings.youtubePromo);

export function YtButton({ channel, label, small }: { channel: string; label?: string; small?: boolean }) {
  const t = useT();
  return (
    <button
      type="button"
      className={`btn yt-btn ${small ? "sm" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        void openUrl(subscribeUrl(channel));
      }}
    >
      <Youtube size={small ? 14 : 16} /> {label ?? t("订阅 YouTube 频道")}
    </button>
  );
}

/** 单集播放器下方：频道信息 + 红色「订阅」按钮。 */
export function YtVideoStrip({ channel, name, cover }: { channel: string; name: string; cover?: string | null }) {
  const t = useT();
  return (
    <div className="yt-strip">
      {cover ? <img src={cover} alt="" /> : <span className="yt-strip-icon"><Youtube size={16} /></span>}
      <div className="yt-strip-text">
        <p className="yt-strip-name clamp1">{name}</p>
        <p className="muted small clamp1">{t("视频版在 YouTube 首发，订阅后新一期第一时间看到")}</p>
      </div>
      <YtButton channel={channel} label={t("订阅")} small />
    </div>
  );
}

export function AlsoOn({ feedUrl }: { feedUrl?: string }) {
  const t = useT();
  const l = showLinks(feedUrl);
  if (!l.bilibili) return null;
  return (
    <button type="button" className="link-btn also-on" onClick={() => void openUrl(l.bilibili!)}>
      {t("也在 B 站")}
    </button>
  );
}

export function HomeShowBanner({
  subscribed,
  busy,
  onSubscribe,
  onOpen,
  onHide,
}: {
  subscribed: boolean;
  busy: boolean;
  onSubscribe: () => void;
  onOpen: () => void;
  onHide: () => void;
}) {
  const t = useT();
  const p = homeShow();
  const yt = showLinks(p?.input).youtube;
  if (!p || !yt) return null;
  return (
    <div
      className="home-show"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <button
        type="button"
        className="icon-btn sm home-show-close"
        title={t("不再显示")}
        aria-label={t("不再显示")}
        onClick={(e) => {
          e.stopPropagation();
          onHide();
        }}
      >
        <X size={15} />
      </button>
      <img src={p.cover} alt="" />
      <div className="home-show-body">
        <p className="home-show-kicker">{t("主创的播客")}</p>
        <p className="home-show-name">{pickName(p)}</p>
        <p className="home-show-desc">
          {t("Next Token · 词元之外：AI 圈一线从业者的长对谈，每期有视频版，在 YouTube 首发。")}
        </p>
        <div className="row-actions">
          <YtButton channel={yt} />
          {subscribed ? (
            <span className="muted small home-show-done">
              <Check size={13} /> {t("已在 App 里订阅")}
            </span>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={(e) => {
                e.stopPropagation();
                onSubscribe();
              }}
              disabled={busy}
            >
              {busy ? <Loader2 size={14} className="spin" /> : <Plus size={15} />} {t("在 App 里订阅")}
            </button>
          )}
          <AlsoOn feedUrl={p.input} />
        </div>
      </div>
    </div>
  );
}