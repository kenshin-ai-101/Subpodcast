/**
 * [INPUT]: store（init 已拉离线清单）、Chrome、layout、Splitter；AudioEngine / YtEngine / MiniPlayer；playback.armPlayerIntentListener；PlayerBar.toggleTheater；library / listening
 * [OUTPUT]: 应用壳；侧栏拖宽 / 图标轨；首页/发现/统计/生词本/频道/单集路由；F 全屏
 * [POS]: 前端根组件；音/视频引擎 + MiniPlayer 常驻；mount 时挂 playWhenReady 订阅（禁模块顶层）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { Suspense, lazy, useEffect, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "./store";
import { api } from "./lib/api";
import { useLayout, SIDEBAR } from "./lib/layout";
import { tNow, useT } from "./lib/i18n";
import { stepSubScale, useReadingSettings } from "./lib/reading";
import { loadFavorites } from "./lib/library";
import { flushListening, noteListening } from "./lib/listening";
import { activeIndex, armPlayerIntentListener } from "./lib/playback";
import { useJobs } from "./lib/jobs";
import { comboOf, keymap, useKeysHelp } from "./lib/shortcuts";
import { stepVolume, toggleMute } from "./lib/volume";
import { loadYouTube } from "./lib/youtube";
import { AudioEngine } from "./components/AudioEngine";
import { ConfirmHost } from "./components/ConfirmHost";
import { Sidebar, Toast, TopBar } from "./components/Chrome";
import { ChannelView } from "./components/ChannelView";
import { DiscoverView } from "./components/DiscoverView";
import { EpisodeView } from "./components/EpisodeView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { HomeView } from "./components/HomeView";
import { MiniPlayer } from "./components/MiniPlayer";
import { toggleTheater } from "./components/PlayerBar";
import { RecentView } from "./components/RecentView";
import { ShortcutsHelpModal } from "./components/ShortcutsHelpModal";
import { ShowView } from "./components/ShowView";
import { Splitter } from "./components/Splitter";
import { remindReview } from "./components/WordsBook";
import { SelectionTools } from "./components/SelectionTools";
import { useWords } from "./lib/words";
import { AgentConnectDialogHost } from "./components/AgentConnectDialog";
import { QuotePosterDialogHost } from "./components/QuotePosterDialog";
import { VideoClipDialogHost } from "./components/VideoClipDialog";
import { YtEngine } from "./components/YtEngine";

const StatsView = lazy(() => import("./components/StatsView").then((m) => ({ default: m.StatsView })));
const WordsView = lazy(() => import("./components/WordsBook").then((m) => ({ default: m.WordsView })));
const SettingsDialog = lazy(() =>
  import("./components/SettingsDialog").then((m) => ({ default: m.SettingsDialog })),
);
const AddDialog = lazy(() => import("./components/AddDialog").then((m) => ({ default: m.AddDialog })));

const PLAYBACK_RATES: readonly number[] = [0.75, 1, 1.25, 1.5, 1.75, 2];

export default function App() {
  const t = useT();
  const { ready, view, init } = useStore(
    useShallow((s) => ({ ready: s.ready, view: s.view, init: s.init })),
  );
  const { sidebar, sideOpen, put: putLayout } = useLayout(
    useShallow((l) => ({ sidebar: l.sidebar, sideOpen: l.sideOpen, put: l.put })),
  );
  useReadingSettings();

  useEffect(() => {
    void init().then(() => {
      loadFavorites();
      // 预热 iframe API，视频首点少等一轮脚本
      void loadYouTube().catch(() => {});
      window.setTimeout(() => void remindReview(), 4000);
    });
  }, [init]);

  useEffect(() => {
    const offListen = useStore.subscribe((s, prev) => {
      if (prev.playing && !s.playing && s.current) noteListening(s.current, false);
    });
    const offIntent = armPlayerIntentListener();
    const onUnload = () => {
      const c = useStore.getState().current;
      if (c) noteListening(c, false);
      flushListening();
    };
    const onFocus = () => {
      void useStore
        .getState()
        .syncFromDisk()
        .then((changed) => {
          if (!changed) return;
          loadFavorites();
          if (useWords.getState().loaded) void useWords.getState().load(true);
          // 外部 CLI / MCP 可能写入了新的字幕、译文或导读：清掉空闲的字幕内存缓存，让单集页重新从库读取
          const jobs = useJobs.getState();
          const curView = useStore.getState().view;
          const activeEpId = curView.kind === "episode" ? curView.id : useStore.getState().current?.id;
          if (activeEpId && !jobs.asrRunning[activeEpId] && !jobs.translations[activeEpId]?.running) {
            void api.loadTranscript(activeEpId).then((tr) => {
              if (tr) {
                useJobs.setState((j) => ({
                  transcripts: { ...j.transcripts, [activeEpId]: tr },
                }));
              }
            }).catch(() => {});
            void api.getBlob(activeEpId, "zh").then((raw) => {
              if (!raw) return;
              try {
                const items = JSON.parse(raw) as (string | null)[];
                useJobs.setState((j) => ({
                  translations: { ...j.translations, [activeEpId]: { items, running: false } },
                }));
              } catch {
                /* ignore */
              }
            }).catch(() => {});
          }
        })
        .catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("beforeunload", onUnload);
    // 接入系统媒体键（MediaSession）
    const syncMediaSession = () => {
      if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
      const st = useStore.getState();
      const ep = st.current;
      if (!ep) {
        navigator.mediaSession.playbackState = "none";
        return;
      }
      navigator.mediaSession.playbackState = st.playing ? "playing" : "paused";
      if (typeof MediaMetadata !== "undefined") {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: ep.title,
          artist: ep.showTitle ?? tNow("声译"),
          artwork: ep.cover ? [{ src: ep.cover }] : [],
        });
      }
      const tryHandler = (action: MediaSessionAction, fn: MediaSessionActionHandler) => {
        try {
          navigator.mediaSession.setActionHandler(action, fn);
        } catch {
          /* 部分 WebView 不支持该 action */
        }
      };
      tryHandler("play", () => useStore.getState().player?.play());
      tryHandler("pause", () => {
        const s = useStore.getState();
        if (s.playing) s.player?.toggle();
      });
      tryHandler("seekbackward", (d) => {
        const s = useStore.getState();
        s.player?.seek(Math.max(0, s.time - (d?.seekOffset ?? 15)));
      });
      tryHandler("seekforward", (d) => {
        const s = useStore.getState();
        const max = s.length > 0 ? s.length : Number.POSITIVE_INFINITY;
        s.player?.seek(Math.min(max, s.time + (d?.seekOffset ?? 30)));
      });
    };
    const offMedia = useStore.subscribe((s, prev) => {
      if (s.current?.id !== prev.current?.id || s.playing !== prev.playing) syncMediaSession();
    });
    return () => {
      offListen();
      offIntent();
      offMedia();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || !!target?.isContentEditable;
      const combo = comboOf(e);
      if (!combo) return;

      const st = useStore.getState();
      const map = keymap(st.settings.shortcuts);
      const hit = (id: keyof typeof map) => map[id].includes(combo);

      // 全局窗口快捷键：即便在输入或浏览中也可触发
      if (hit("toggleSidebar")) {
        e.preventDefault();
        const l = useLayout.getState();
        l.put({ sideOpen: !l.sideOpen });
        return;
      }
      if (hit("togglePanel")) {
        e.preventDefault();
        const l = useLayout.getState();
        l.put({ panelOpen: !l.panelOpen });
        return;
      }
      if (hit("search")) {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>(".top-search input");
        input?.focus();
        return;
      }
      if (hit("settings")) {
        e.preventDefault();
        st.set({ settingsOpen: !st.settingsOpen });
        return;
      }
      if (hit("keysHelp")) {
        e.preventDefault();
        useKeysHelp.setState((h) => ({ open: !h.open }));
        return;
      }

      // 任意弹窗打开或正在输入时，不抢单键播放/字幕快捷键
      const modalOpen =
        st.settingsOpen ||
        st.addOpen ||
        useKeysHelp.getState().open ||
        !!document.querySelector(".modal-back");
      if (typing || modalOpen) return;

      if (hit("fullscreen") && document.querySelector(".video")) {
        e.preventDefault();
        toggleTheater();
        return;
      }
      if (hit("subtitleMode")) {
        const order = ["bilingual", "translation", "original"] as const;
        const cur = st.settings.subtitleMode;
        const next = order[(order.indexOf(cur) + 1) % order.length];
        e.preventDefault();
        void st.saveSettings({ subtitleMode: next });
        return;
      }
      if (hit("subBigger")) {
        e.preventDefault();
        stepSubScale(1);
        return;
      }
      if (hit("subSmaller")) {
        e.preventDefault();
        stepSubScale(-1);
        return;
      }
      if (hit("mute")) {
        e.preventDefault();
        const muted = toggleMute();
        st.notify(muted ? tNow("已静音") : tNow("已取消静音"));
        return;
      }
      if (hit("volumeUp")) {
        e.preventDefault();
        const lv = stepVolume(1);
        st.notify(tNow("音量 {n}%", { n: Math.round(lv * 100) }));
        return;
      }
      if (hit("volumeDown")) {
        e.preventDefault();
        const lv = stepVolume(-1);
        st.notify(tNow("音量 {n}%", { n: Math.round(lv * 100) }));
        return;
      }

      const p = st.player;
      if (!p || !st.current) return;

      if (hit("playPause")) {
        e.preventDefault();
        p.toggle();
        return;
      }
      const seekBy = (delta: number) => {
        const max = st.length > 0 ? st.length : Number.POSITIVE_INFINITY;
        p.seek(Math.max(0, Math.min(max, st.time + delta)));
      };
      if (hit("back")) {
        e.preventDefault();
        seekBy(-15);
        return;
      }
      if (hit("forward")) {
        e.preventDefault();
        seekBy(30);
        return;
      }
      if (hit("backShort")) {
        e.preventDefault();
        seekBy(-5);
        return;
      }
      if (hit("forwardShort")) {
        e.preventDefault();
        seekBy(5);
        return;
      }
      if (hit("prevLine") || hit("nextLine")) {
        const segs = useJobs.getState().transcripts[st.current.id]?.segments;
        if (!segs?.length) return;
        e.preventDefault();
        const idx = activeIndex(
          segs.map((s) => s.start),
          st.time,
        );
        const nextIdx = hit("prevLine") ? Math.max(0, idx - 1) : Math.min(segs.length - 1, idx + 1);
        p.seek(segs[nextIdx]!.start);
        return;
      }
      if (hit("speedUp") || hit("speedDown")) {
        e.preventDefault();
        const curIdx = PLAYBACK_RATES.reduce(
          (best, r, i) => (Math.abs(r - st.rate) < Math.abs(PLAYBACK_RATES[best]! - st.rate) ? i : best),
          1,
        );
        const nextIdx = hit("speedUp")
          ? Math.min(PLAYBACK_RATES.length - 1, curIdx + 1)
          : Math.max(0, curIdx - 1);
        const nextRate = PLAYBACK_RATES[nextIdx]!;
        p.setRate(nextRate);
        void st.saveSettings({ playbackRate: nextRate });
        st.notify(tNow("倍速 {rate}×", { rate: nextRate }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!ready) return <div className="boot">{t("声译启动中…")}</div>;

  return (
    <div
      className={`app ${sideOpen ? "" : "side-collapsed"}`}
      style={{ "--sidebar-w": `${sideOpen ? sidebar : 72}px` } as CSSProperties}
    >
      <Sidebar />
      <Splitter
        value={sideOpen ? sidebar : 72}
        min={SIDEBAR.min}
        max={SIDEBAR.max}
        def={SIDEBAR.def}
        snap={SIDEBAR.snap}
        edge="right"
        label={t("侧栏宽度")}
        onChange={(w) => putLayout({ sidebar: w, sideOpen: true })}
        onCollapse={() => putLayout({ sideOpen: false })}
      />
      <main className="main">
        {view.kind !== "episode" && <TopBar />}
        <ErrorBoundary>
          {view.kind === "home" && <HomeView />}
          {view.kind === "discover" && <DiscoverView />}
          {view.kind === "stats" && (
            <Suspense fallback={<div className="page stats" />}>
              <StatsView />
            </Suspense>
          )}
          {view.kind === "recent" && <RecentView />}
          {view.kind === "words" && (
            <Suspense fallback={<div className="page" />}>
              <WordsView />
            </Suspense>
          )}
          {view.kind === "channel" && <ChannelView key={view.input} input={view.input} />}
          {view.kind === "show" && <ShowView showId={view.id} />}
          {view.kind === "episode" && <EpisodeView episodeId={view.id} />}
        </ErrorBoundary>
      </main>
      <AudioEngine />
      <YtEngine />
      <MiniPlayer />
      <Suspense fallback={null}>
        <AddDialog />
        <SettingsDialog />
      </Suspense>
      <ErrorBoundary fallbackTitle={t("剪辑工作室加载异常")}>
        <VideoClipDialogHost />
      </ErrorBoundary>
      <ErrorBoundary fallbackTitle={t("海报生成加载异常")}>
        <QuotePosterDialogHost />
      </ErrorBoundary>
      <AgentConnectDialogHost />
      <ShortcutsHelpModal />
      <SelectionTools />
      <ConfirmHost />
      <Toast />
    </div>
  );
}
