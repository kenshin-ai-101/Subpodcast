/**
 * [INPUT]: store、Chrome、各视图；useReadingSettings
 * [OUTPUT]: SubCast 对齐的应用壳
 * [POS]: 前端根组件；挂载阅读 CSS 变量
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "./store";
import { useReadingSettings } from "./lib/reading";
import { AddDialog } from "./components/AddDialog";
import { ConfirmHost } from "./components/ConfirmHost";
import { Sidebar, Toast, TopBar } from "./components/Chrome";
import { EpisodeView } from "./components/EpisodeView";
import { HomeView } from "./components/HomeView";
import { SettingsDialog } from "./components/SettingsDialog";
import { ShowView } from "./components/ShowView";

export default function App() {
  const { ready, view, init } = useStore(
    useShallow((s) => ({ ready: s.ready, view: s.view, init: s.init })),
  );
  useReadingSettings();

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>(".top-search input");
        input?.focus();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        useStore.getState().set({ settingsOpen: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!ready) return <div className="boot">声译启动中…</div>;

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {view.kind !== "episode" && <TopBar />}
        {view.kind === "home" && <HomeView />}
        {view.kind === "show" && <ShowView showId={view.id} />}
        {view.kind === "episode" && <EpisodeView episodeId={view.id} />}
      </main>
      <AddDialog />
      <SettingsDialog />
      <ConfirmHost />
      <Toast />
    </div>
  );
}
