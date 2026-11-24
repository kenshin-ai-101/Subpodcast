/**
 * [INPUT]: dict / words / clip / jobs.llmReady / api.llmChat / store
 * [OUTPUT]: useLearnOn、useLearnMarks、LearnText、WordCard、LearnTip、EmptyState、Meaning、ClipIcon、ClipLabel、fmtWait、dueLabel
 * [POS]: 英语学习模式前端核心（标词 / 词卡 / 统一朗读 / 引导）；练习见 LearnPractice，生词本见 WordsBook
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { Check, GraduationCap, Loader2, Pause, Play, Plus, Volume2 } from "lucide-react";
import { api, type Episode, type Segment } from "../lib/api";
import { clipKey, prefetchClip, speak, toggleClip, useClipState } from "../lib/clip";
import { WORD_RE, isNew, loadDict, lookup, tagLabel, useDict } from "../lib/dict";
import { tNow, useT } from "../lib/i18n";
import { llmReady } from "../lib/jobs";
import type { LearnLevel } from "../lib/settings";
import { useWords, type Word } from "../lib/words";
import { useStore } from "../store";

const CTX_PROMPT =
  "你是耐心的英语老师。用户给出一个英文单词和它所在的句子。用一句简短的中文（不超过 40 个字）说明这个词在这句话里的具体意思，可以点出它和句中其他部分的关系。只输出这句解释，不要重复单词，不要加引号。";

/** 学习模式已开，并触发词典 / 生词本加载。 */
export function useLearnOn(): boolean {
  const on = useStore((s) => s.settings.learnOn);
  useEffect(() => {
    if (on) {
      void loadDict();
      void useWords.getState().load();
    }
  }, [on]);
  return on;
}

export const fmtWait = (ms: number) => {
  const m = ms / 60_000;
  if (m < 60) return tNow("{m} 分钟", { m: Math.max(1, Math.round(m)) });
  const h = m / 60;
  if (h < 24) return tNow("{h} 小时", { h: Math.round(h) });
  const d = h / 24;
  if (d < 31) return tNow("{n} 天", { n: Math.round(d) });
  return tNow("{n} 个月", { n: Math.round(d / 30) });
};

export const dueLabel = (w: Word, now: number) => {
  if (w.card.state === 0) return { text: tNow("新词"), now: false };
  if (w.card.due <= now) return { text: tNow("今天"), now: true };
  return { text: tNow("{wait}后", { wait: fmtWait(w.card.due - now) }), now: false };
};

export function EmptyState({
  art,
  title,
  note,
  children,
}: {
  art?: ReactNode;
  title?: string;
  note?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="panel-empty empty-state">
      {art && <div className="es-art">{art}</div>}
      {title && <p className="es-title">{title}</p>}
      {note && <p className="es-note">{note}</p>}
      {children}
    </div>
  );
}

/** 词典义项：词性与释义分行。 */
export function Meaning({ text }: { text: string }) {
  return (
    <div className="wc-def">
      {text.split("\n").map((l, i) => {
        const m = l.match(/^([a-z]+\.(?:\s*&\s*[a-z]+\.)?|\[[^\]]+\])\s*(.*)$/);
        return (
          <p key={i}>{m ? <><span className="wc-pos">{m[1]}</span>{m[2]}</> : l}</p>
        );
      })}
    </div>
  );
}

/** 裁剪中转圈；播放中显示暂停；否则播放三角。 */
export function ClipIcon({ k, size = 12 }: { k: string; size?: number }) {
  // 拆成原始字段订阅，避免每渲染新建 selector（zustand 5 更稳）
  const active = useClipState((s) => s.key === k);
  const loading = useClipState((s) => (s.key === k ? s.loading : false));
  if (active && loading) return <Loader2 size={size} className="spin" />;
  if (active) return <Pause size={size} className="fill-ico" />;
  return <Play size={size} className="fill-ico" />;
}

/** 图标 + 文案；播放中文案变为「暂停」。 */
export function ClipLabel({ k, label }: { k: string; label: string }) {
  const t = useT();
  const active = useClipState((s) => s.key === k);
  const loading = useClipState((s) => (s.key === k ? s.loading : false));
  return (
    <>
      <ClipIcon k={k} />
      {active && !loading ? t("暂停") : label}
    </>
  );
}

export interface LearnMarks {
  data: NonNullable<ReturnType<typeof useDict.getState>["data"]>;
  level: LearnLevel;
  mark: boolean;
  saved: Record<string, Word>;
  known: Record<string, number>;
}

/** 英文字幕标词所需数据；不适用时为 null。 */
export function useLearnMarks(english: boolean): LearnMarks | null {
  const on = useLearnOn();
  const { level, mark, card } = useStore(
    useShallow((s) => ({
      level: s.settings.learnLevel,
      mark: s.settings.learnMark,
      card: s.settings.learnCard,
    })),
  );
  const data = useDict((s) => s.data);
  const { saved, known } = useWords(useShallow((s) => ({ saved: s.words, known: s.known })));
  return useMemo(
    () => (on && english && data && (mark || card) ? { data, level, mark, saved, known } : null),
    [on, english, data, level, mark, card, saved, known],
  );
}

/** 英文行：词可标、可点。 */
export const LearnText = memo(function LearnText({ text, marks }: { text: string; marks: LearnMarks }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(WORD_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    const e = lookup(marks.data, m[0]);
    const proper =
      /^[A-Z]/.test(m[0]) && ((i > 0 && !/[.?!]["”]?\s*$/.test(text.slice(0, i))) || !e?.tags);
    const cls =
      e && marks.saved[e.lemma]
        ? " saved"
        : e && marks.mark && !proper && !marks.known[e.lemma] && isNew(e, marks.level)
          ? " new"
          : "";
    out.push(
      <span key={i} className={`lw${cls}`}>
        {m[0]}
      </span>,
    );
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
});

export interface CardTarget {
  el: HTMLElement;
  token: string;
  seg: Segment;
  zh?: string | null;
}

/** 点击单词的词卡：释义、句内义、原声、加入生词本。 */
export function WordCard({ target, ep, onClose }: { target: CardTarget; ep: Episode; onClose: () => void }) {
  const t = useT();
  const data = useDict((s) => s.data);
  const entry = useMemo(() => (data ? lookup(data, target.token) : null), [data, target.token]);
  const id = entry?.lemma ?? target.token.toLowerCase();
  const saved = useWords((s) => s.words[id]);
  const isKnown = useWords((s) => !!s.known[id]);
  const aiOn = useStore((s) => s.settings.learnAi);
  const [ctx, setCtx] = useState<string | null>(saved?.ctx ?? null);
  const [ctxState, setCtxState] = useState<"idle" | "loading" | "none" | "error">("idle");
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });

  useEffect(() => {
    setCtx(saved?.ctx ?? null);
    setCtxState("idle");
  }, [id, target.seg.text, saved?.ctx]);

  useEffect(() => {
    target.el.classList.add("open");
    return () => target.el.classList.remove("open");
  }, [target.el]);

  useEffect(() => {
    const place = () => {
      const r = target.el.getBoundingClientRect();
      const h = box.current?.offsetHeight ?? 240;
      const w = 320;
      const left = Math.min(Math.max(12, r.left - 20), window.innerWidth - w - 12);
      const below = r.bottom + 8 + h < window.innerHeight - 12;
      setPos(below ? { left, top: r.bottom + 8 } : { left, top: Math.max(12, r.top - 8 - h) });
    };
    place();
    const ro = new ResizeObserver(place);
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, [target.el, ctxState, ctx]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!box.current?.contains(n) && !target.el.contains(n)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const scroll = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [onClose, target.el]);

  useEffect(() => {
    if (!aiOn || saved?.ctx) return;
    let live = true;
    void (async () => {
      if (!(await llmReady("chat"))) {
        if (live) setCtxState("none");
        return;
      }
      const settings = useStore.getState().settings;
      const p = settings.providers[settings.chatProvider];
      if (!p?.model) {
        if (live) setCtxState("none");
        return;
      }
      setCtxState("loading");
      try {
        const r = await api.llmChat({
          provider: p.id,
          baseUrl: p.baseUrl,
          model: settings.chatModel || p.model,
          protocol: p.protocol,
          messages: [
            { role: "system", content: CTX_PROMPT },
            { role: "user", content: `单词：${target.token}\n句子：${target.seg.text}` },
          ],
        });
        if (!live) return;
        const text = r.trim().replace(/^["“]|["”]$/g, "").slice(0, 120);
        setCtx(text);
        setCtxState("idle");
        if (useWords.getState().words[id]) useWords.getState().update(id, { ctx: text });
      } catch {
        if (live) setCtxState("error");
      }
    })();
    return () => {
      live = false;
    };
  }, [aiOn, target.token, target.seg.text, id, saved?.ctx]);

  const add = () => {
    useWords.getState().add({
      id,
      word: target.token,
      ipa: entry?.ipa ?? "",
      meaning: entry?.meaning ?? ctx ?? "",
      ctx: ctx ?? undefined,
      tag: entry ? tagLabel(entry.tags) : "",
      sentence: target.seg.text,
      sentenceZh: target.zh ?? undefined,
      episodeId: ep.id,
      episodeTitle: ep.title,
      showTitle: ep.showTitle ?? undefined,
      start: target.seg.start,
      end: target.seg.end,
    });
    useStore.getState().notify(t("已加入生词本：{word}", { word: entry?.lemma ?? target.token }));
    prefetchClip(ep.id, target.seg.start, target.seg.end);
  };

  const listen = async () => {
    await toggleClip(ep, target.seg.start, target.seg.end, target.seg.text);
  };
  const label = entry ? tagLabel(entry.tags) : "";

  return createPortal(
    <div ref={box} className="word-card" style={pos} role="dialog" aria-label={entry?.lemma ?? target.token}>
      <div className="wc-head">
        <span className="wc-word">{entry?.lemma ?? target.token}</span>
        {label && <span className="pill">{label}</span>}
        <button
          type="button"
          className="icon-btn sm wc-say"
          title={t("读单词")}
          aria-label={t("读单词")}
          onClick={() => speak(entry?.lemma ?? target.token)}
        >
          <Volume2 size={15} />
        </button>
      </div>
      {entry?.ipa && <p className="wc-ipa">/{entry.ipa}/</p>}
      {entry ? <Meaning text={entry.meaning} /> : <p className="wc-none muted small">{t("词典里没有这个词")}</p>}
      {aiOn && ctxState !== "none" && (
        <div className="wc-ctx">
          <span className="wc-ctx-h">{t("在这句里")}</span>
          {ctx ? (
            ctx
          ) : ctxState === "loading" ? (
            <span className="skeleton wc-skel" />
          ) : ctxState === "error" ? (
            <span className="muted">{t("暂时没能解释，稍后再试")}</span>
          ) : null}
        </div>
      )}
      <div className="wc-foot">
        <button type="button" className="btn sm play" onClick={() => void listen()}>
          <ClipLabel k={clipKey(ep.id, target.seg.start, target.seg.end)} label={t("原声")} />
        </button>
        {saved ? (
          <button
            type="button"
            className="btn sm ghost wc-saved"
            onClick={() => {
              onClose();
              void import("./WordsBook").then(({ openWord }) => openWord(id));
            }}
          >
            <Check size={13} />
            {t("已在生词本")}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                if (isKnown) {
                  useWords.getState().unknow(id);
                  useStore.getState().notify(t("已恢复标词：{word}", { word: entry?.lemma ?? target.token }));
                } else {
                  useWords.getState().know([id]);
                  useStore.getState().notify(t("已标为认识，后续不再高亮：{word}", { word: entry?.lemma ?? target.token }));
                  onClose();
                }
              }}
            >
              {isKnown ? t("恢复标词") : t("已认识")}
            </button>
            <button type="button" className="btn sm primary" onClick={add}>
              <Plus size={13} />
              {t("加入生词本")}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** 首次英文稿顶栏：是否打开学习模式。 */
export function LearnTip() {
  const t = useT();
  const { asked, on, save } = useStore(
    useShallow((s) => ({
      asked: s.settings.learnAsked,
      on: s.settings.learnOn,
      save: s.saveSettings,
    })),
  );
  if (asked || on) return null;
  return (
    <div className="learn-tip">
      <span className="learn-tip-ic">
        <GraduationCap size={16} />
      </span>
      <div className="learn-tip-text">
        <p className="learn-tip-t">{t("想顺便学英语吗？")}</p>
        <p className="learn-tip-s">{t("点字幕里的单词就能查，生词进生词本。")}</p>
      </div>
      <div className="learn-tip-acts">
        <button type="button" className="btn sm ghost" onClick={() => void save({ learnAsked: true })}>
          {t("不用了")}
        </button>
        <button
          type="button"
          className="btn sm primary"
          onClick={() => {
            void save({ learnAsked: true, learnOn: true });
            useStore.getState().notify(t("已打开英语学习模式，可以在 设置 › 学英语 里调整"));
          }}
        >
          {t("打开")}
        </button>
      </div>
    </div>
  );
}

