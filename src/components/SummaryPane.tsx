/**
 * [INPUT]: guides.ensureGuide/runGuide；jobs.llmReady；store.load/seekSoon；ReadAloud；Illustrations；Markdown
 * [OUTPUT]: 右侧「导读」Tab（连模型 / 查共享 / 生成中 / 成稿+朗读脚注）
 * [POS]: 右栏「导读」Tab；任务态在 lib/guides，切 tab 不丢流
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Loader2, RefreshCw } from "lucide-react";
import type { Episode } from "../lib/api";
import { shortModel } from "../lib/ai";
import { ensureGuide, runGuide, useGuides } from "../lib/guides";
import { llmReady, useJobs } from "../lib/jobs";
import { seekSoon, useStore } from "../store";
import { PageArt, PlugArt } from "./Illustrations";
import { Markdown } from "./Markdown";
import { ReadAloud } from "./ReadAloud";

function useConnected() {
  const settings = useStore((s) => s.settings);
  const open = useStore((s) => s.settingsOpen);
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    if (!open) void llmReady("chat").then(setOk);
  }, [settings, open]);
  return ok;
}

function ConnectCard({ onLater }: { onLater: () => void }) {
  const { saveSettings, set } = useStore(
    useShallow((s) => ({ saveSettings: s.saveSettings, set: s.set })),
  );
  return (
    <div className="connect-card">
      <PlugArt className="cc-art" />
      <p className="es-title">导读还差一个模型</p>
      <p className="muted">推荐 DeepSeek，国内直连，一集约 ¥0.1。Key 只保存在本机。</p>
      <div className="row-actions center">
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            const s = useStore.getState();
            void saveSettings({ chatProvider: s.settings.chatProvider || "deepseek" });
            set({ settingsOpen: true, settingsSection: "ai" });
          }}
        >
          连接模型
        </button>
        <button type="button" className="btn ghost" onClick={onLater}>
          稍后
        </button>
      </div>
    </div>
  );
}

function useSeek(ep: Episode) {
  const ref = useRef(ep);
  ref.current = ep;
  return useCallback((t: number) => {
    const cur = ref.current;
    const s = useStore.getState();
    if (s.current?.id === cur.id) s.player?.seek(t);
    else {
      s.load({ ...cur, progress: t });
      seekSoon(t);
    }
  }, []);
}

/** Markdown → 朗读文本：去掉链接、时间戳、标题与强调记号。 */
function plainText(md: string) {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[?\b\d{1,2}(:\d{2}){1,2}\]?/g, "")
    .replace(/^#+\s*|[*_`>]+/gm, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function SummaryPane({ episode }: { episode: Episode }) {
  const transcript = useJobs((s) => s.transcripts[episode.id]);
  const connected = useConnected();
  const seek = useSeek(episode);
  const settings = useStore((s) => s.settings);
  const provider = settings.providers[settings.chatProvider];
  const set = useStore((s) => s.set);
  const [skipConnect, setSkipConnect] = useState(false);
  const job = useGuides(
    useShallow((s) => {
      const j = s[episode.id];
      return {
        summary: j?.summary ?? null,
        streaming: j?.streaming ?? null,
        error: j?.error ?? null,
        needsSetup: !!j?.needsSetup,
        shared: !!j?.shared,
        checking: !!j?.checking,
      };
    }),
  );

  useEffect(() => {
    setSkipConnect(false);
  }, [episode.id]);

  useEffect(() => {
    void ensureGuide(episode);
  }, [episode.id, transcript]);

  const text = job.streaming ?? job.summary;
  const busy = job.streaming != null;
  const ready = !!transcript?.segments.length;

  if (!text && connected === false && !skipConnect) {
    return (
      <div className="panel-empty">
        <ConnectCard onLater={() => setSkipConnect(true)} />
      </div>
    );
  }

  if (!text && busy) {
    return (
      <div className="panel-empty guide-wait" role="status">
        <PageArt writing />
        <p className="es-title">正在通读整期文字稿</p>
        <p className="wait-steps" aria-hidden>
          <span>先划出重点</span>
          <span>再理一条时间线</span>
          <span>挑几句值得记住的原话</span>
        </p>
        <span className="sr-only">正在生成…</span>
      </div>
    );
  }

  if (!text && job.checking) {
    return (
      <div className="panel-empty" role="status">
        <PageArt />
        <p className="muted">
          <Loader2 size={14} className="spin" /> 正在查找别人分享的导读…
        </p>
      </div>
    );
  }

  if (!text) {
    return (
      <div className="panel-empty">
        <PageArt />
        <p className="es-title">一键中文导读</p>
        <p className="muted">一句话总结、时间线、核心观点、原话和推荐片段，都带时间戳。</p>
        {job.error && <p className="error-text">{job.error}</p>}
        {job.error && job.needsSetup && (
          <button
            type="button"
            className="btn"
            onClick={() => set({ settingsOpen: true, settingsSection: "ai" })}
          >
            去设置
          </button>
        )}
        <button
          type="button"
          className="btn primary"
          disabled={!ready || busy}
          onClick={() => void runGuide(episode)}
        >
          {busy ? "正在生成…" : "生成导读"}
        </button>
        {!ready && <p className="muted small">字幕准备好后可以生成。</p>}
      </div>
    );
  }

  return (
    <div className="summary-pane">
      <Markdown text={text} onSeek={seek} />
      {!busy && (
        <div className="summary-foot">
          <span className="muted small">
            {job.shared
              ? "来自共享导读，没有花你的额度"
              : provider
                ? `${provider.name} · ${shortModel(provider.model)}`
                : ""}
          </span>
          <ReadAloud text={() => plainText(text)} />
          <button type="button" className="btn ghost sm" onClick={() => void runGuide(episode)}>
            <RefreshCw size={13} /> 重新生成
          </button>
        </div>
      )}
      {job.error && <p className="error-text">{job.error}</p>}
    </div>
  );
}
