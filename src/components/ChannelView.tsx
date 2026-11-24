/**
 * [INPUT]: api.previewShow/cachedShow、MonthFilter、picks
 * [OUTPUT]: ChannelView — 订阅前频道预览
 * [POS]: 从发现点进精选节目；列表用 EpFeed
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, Loader2, Plus, RefreshCw } from "lucide-react";
import { api, errText, type Episode, type Show } from "../lib/api";
import { plainText } from "../lib/format";
import { useT } from "../lib/i18n";
import { PICKS, pickName, pickSub, sameFeed, showName } from "../lib/picks";
import { showLinks } from "../lib/showLinks";
import { playAll } from "../lib/queue";
import { useStore } from "../store";
import { EpFeed, EpisodeRow } from "./HomeView";
import { MonthFilter, useMonthFilter } from "./MonthFilter";
import { AlsoOn, usePromo, YtButton } from "./PromoBanner";

function EpisodeList({ episodes }: { episodes: Episode[] | null }) {
  const t = useT();
  const openEpisode = useStore((s) => s.openEpisode);
  if (episodes == null) return <p className="muted">{t("加载中…")}</p>;
  if (!episodes.length) return <p className="muted">{t("暂无单集")}</p>;
  return (
    <EpFeed>
      {episodes.map((ep) => (
        <EpisodeRow key={ep.id} ep={ep} onOpen={() => openEpisode(ep)} />
      ))}
    </EpFeed>
  );
}

export function ChannelView({ input }: { input: string }) {
  const t = useT();
  const { shows, reloadShows, notify, go } = useStore(
    useShallow((s) => ({
      shows: s.shows,
      reloadShows: s.reloadShows,
      notify: s.notify,
      go: s.go,
    })),
  );
  const pick = PICKS.find((p) => sameFeed(p.input, input));
  const sub = shows.find((s) => sameFeed(s.feedUrl, input));
  const [data, setData] = useState<{ show: Show; episodes: Episode[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const { month, setMonth, filtered: shown } = useMonthFilter(data?.episodes ?? null);
  const promo = usePromo();
  const links = showLinks(pick?.input ?? input);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    void api.cachedShow(input).then((cached) => {
      if (!live) return;
      if (cached) setData(cached);
      if (cached && Date.now() - cached.fetchedAt < 30 * 60_000) return;
      setRefreshing(true);
      void api
        .previewShow(input)
        .then((d) => live && setData(d))
        .catch((e) => live && !cached && setError(errText(e)))
        .finally(() => live && setRefreshing(false));
    });
    return () => {
      live = false;
    };
  }, [input, attempt]);

  const subscribe = async () => {
    setBusy(true);
    try {
      const show = await api.addSubscription(input);
      await reloadShows();
      notify(t("已订阅「{title}」", { title: pick ? pickName(pick) : show.title }));
      go({ kind: "show", id: show.id });
    } catch (e) {
      notify(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const cover = pick?.cover ?? data?.show.cover;
  const desc = pick?.intro ?? plainText(data?.show.description ?? "").slice(0, 300);
  const playable = (shown ?? []).filter((e) => (e.audioUrl || e.videoId) && !(e.duration && e.progress >= e.duration * 0.97));

  return (
    <div className="page">
      <div className="show-head">
        {cover ? <img src={cover} alt="" /> : <div className="cover-fallback" />}
        <div className="show-info">
          <p className="meta-line">{pick ? pickSub(pick) : data?.show.author ?? t("频道")}</p>
          <h1 className="show-title-h">{pick ? pickName(pick) : showName(data?.show.title ?? "")}</h1>
          {pick && pickName(pick) !== pick.title && <span className="orig-line clamp1">{pick.title}</span>}
          {desc && <p className="show-desc clamp3">{desc}</p>}
          <div className="row-actions">
            {sub ? (
              <button type="button" className="btn sm" onClick={() => go({ kind: "show", id: sub.id })}>
                <Check size={13} /> {t("已订阅 · 查看")}
              </button>
            ) : (
              <button type="button" className="btn primary" onClick={() => void subscribe()} disabled={busy}>
                {busy ? <Loader2 size={14} className="spin" /> : <Plus size={15} />} {t("订阅")}
              </button>
            )}
            {playable.length > 1 && (
              <button type="button" className="btn sm" onClick={() => playAll(playable)}>
                {t("播放全部（{n}）", { n: playable.length })}
              </button>
            )}
            {promo && links.youtube && <YtButton channel={links.youtube} small={!!sub} />}
            {promo && links.youtube && <AlsoOn feedUrl={pick?.input ?? input} />}
            {data && (
              <span className="muted small">
                {t("{n} 期节目 · 不订阅也可以直接收听", { n: data.episodes.length })}
                {refreshing ? ` · ${t("正在更新…")}` : ""}
              </span>
            )}
          </div>
        </div>
      </div>
      {error ? (
        <div className="panel-empty">
          <p className="error-text">{error}</p>
          <button type="button" className="btn sm" onClick={() => setAttempt((n) => n + 1)}>
            <RefreshCw size={13} /> {t("重试")}
          </button>
        </div>
      ) : (
        <>
          <MonthFilter episodes={data?.episodes ?? null} month={month} onChange={setMonth} />
          <EpisodeList episodes={shown} />
        </>
      )}
    </div>
  );
}