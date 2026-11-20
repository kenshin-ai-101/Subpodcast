/**
 * [INPUT]: store（init 已拉离线清单）、Chrome、layout、Splitter；AudioEngine / YtEngine / MiniPlayer；playback.armPlayerIntentListener；PlayerBar.toggleTheater；library / listening
 * [OUTPUT]: 应用壳；侧栏拖宽 / 图标轨；首页/发现/统计/生词本/频道/单集路由；F 全屏
 * [POS]: 前端根组件；音/视频引擎 + MiniPlayer 常驻；mount 时挂 playWhenReady 订阅（禁模块顶层）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { Suspense, lazy, useEffect, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "./store";
import { SIDEBAR, useLayout } from "./lib/layout";
import { useReadingSettings } from "./lib/reading";
import { loadFavorites } from "./lib/library";
import { flushListening, noteListening } from "./lib/listening";
import { armPlayerIntentListener } from "./lib/playback";
import { comboOf, keymap } from "./lib/shortcuts";
import { loadYouTube } from "./lib/youtube";
import { AddDialog } from "./components/AddDialog";
import { AudioEngine } from "./components/AudioEngine";
import { ConfirmHost } from "./components/ConfirmHost";
import { Sidebar, Toast, TopBar } from "./components/Chrome";
import { ChannelView } from "./components/ChannelView";
import { DiscoverView } from "./components/DiscoverView";
import { EpisodeView } from "./components/EpisodeView";
import { HomeView } from "./components/HomeView";
import { MiniPlayer } from "./components/MiniPlayer";
import { toggleTheater } from "./components/PlayerBar";
import { RecentView } from "./components/RecentView";
import { SettingsDialog } from "./components/SettingsDialog";
import { ShowView } from "./components/ShowView";
import { Splitter } from "./components/Splitter";
import { remindReview, WordsView } from "./components/WordsBook";
import { YtEngine } from "./components/YtEngine";

const StatsView = lazy(() => import("./components/StatsView").then((m) => ({ default: m.StatsView })));

export default function App() {
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
    window.addEventListener("beforeunload", onUnload);
    return () => {
      offListen();
      offIntent();
      window.removeEventListener("beforeunload", onUnload);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement | null)?.isContentEditable;
      const combo = comboOf(e);
      if (combo) {
        const map = keymap(useStore.getState().settings.shortcuts);
        if (map.toggleSidebar.includes(combo)) {
          e.preventDefault();
          const l = useLayout.getState();
          l.put({ sideOpen: !l.sideOpen });
          return;
        }
        if (map.togglePanel.includes(combo)) {
          e.preventDefault();
          const l = useLayout.getState();
          l.put({ panelOpen: !l.panelOpen });
          return;
        }
        // F：视频 theater 全屏（仅视频舞台存在时）
        if (!typing && map.fullscreen.includes(combo) && document.querySelector(".video")) {
          e.preventDefault();
          toggleTheater();
          return;
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>(".top-search input");
        input?.focus();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        useStore.getState().set({ settingsOpen: true });
      }
      // C：双语 → 中文 → 原文（输入框内不抢）
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "c") {
        const order = ["bilingual", "translation", "original"] as const;
        const cur = useStore.getState().settings.subtitleMode;
        const next = order[(order.indexOf(cur) + 1) % order.length];
        e.preventDefault();
        void useStore.getState().saveSettings({ subtitleMode: next });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!ready) return <div className="boot">声译启动中…</div>;

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
        label="侧栏宽度"
        onChange={(w) => putLayout({ sidebar: w, sideOpen: true })}
        onCollapse={() => putLayout({ sideOpen: false })}
      />
      <main className="main">
        {view.kind !== "episode" && <TopBar />}
        {view.kind === "home" && <HomeView />}
        {view.kind === "discover" && <DiscoverView />}
        {view.kind === "stats" && (
          <Suspense fallback={<div className="page stats" />}>
            <StatsView />
          </Suspense>
        )}
        {view.kind === "recent" && <RecentView />}
        {view.kind === "words" && <WordsView />}
        {view.kind === "channel" && <ChannelView key={view.input} input={view.input} />}
        {view.kind === "show" && <ShowView showId={view.id} />}
        {view.kind === "episode" && <EpisodeView episodeId={view.id} />}
      </main>
      <AudioEngine />
      <YtEngine />
      <MiniPlayer />
      <AddDialog />
      <SettingsDialog />
      <ConfirmHost />
      <Toast />
    </div>
  );
}
