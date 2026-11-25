/**
 * [INPUT]: dict / words / clip / LearnModal（foot 钉底）/ store
 * [OUTPUT]: EpisodeWords、useShadowing、ShadowBar、Dictation
 * [POS]: 英语学习 · 本期生词 / 跟读（定时停顿 + 倒计时条 / 重听）/ 听写；不做 ASR 打分引擎
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { Loader2, Mic, Play, SkipForward, Volume2 } from "lucide-react";
import { type Episode, type Segment } from "../lib/api";
import { playClip, prefetchClip, stopClip } from "../lib/clip";
import { WORD_RE, isNew, lookup, tagLabel, useDict, type Entry } from "../lib/dict";
import { clock } from "../lib/format";
import { useT } from "../lib/i18n";
import type { LearnLevel } from "../lib/settings";
import { useWords } from "../lib/words";
import { useStore } from "../store";
import { LearnModal } from "./LearnModal";
import type { LearnMarks } from "./Learn";
import { EmptyState } from "./Learn";

interface Found {
  entry: Entry;
  token: string;
  seg: Segment;
  idx: number;
  count: number;
}

function episodeWords(segments: Segment[], data: LearnMarks["data"], level: LearnLevel): Found[] {
  const found = new Map<string, Found>();
  segments.forEach((seg, idx) => {
    for (const m of seg.text.matchAll(WORD_RE)) {
      const e = lookup(data, m[0]);
      if (!e || !isNew(e, level)) continue;
      const i = m.index ?? 0;
      if (/^[A-Z]/.test(m[0]) && (i > 0 || !e.tags)) continue;
      const f = found.get(e.lemma);
      if (f) f.count++;
      else found.set(e.lemma, { entry: e, token: m[0], seg, idx, count: 1 });
    }
  });
  const weight = (f: Found) => (f.entry.rank || 60000) / Math.sqrt(f.count);
  return [...found.values()].sort((a, b) => weight(a) - weight(b));
}

export function EpisodeWords({
  ep,
  segments,
  zh,
  onClose,
}: {
  ep: Episode;
  segments: Segment[];
  zh: (number | string | null | undefined)[] | undefined;
  onClose: () => void;
}) {
  const t = useT();
  const data = useDict((s) => s.data);
  const level = useStore((s) => s.settings.learnLevel);
  const words = useWords((s) => s.words);
  const list = useMemo(() => (data ? episodeWords(segments, data, level) : []), [data, segments, level]);
  const fresh = list.filter((f) => !words[f.entry.lemma]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setPicked(new Set(fresh.slice(0, 15).map((f) => f.entry.lemma)));
  }, [list.length]);

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const addPicked = () => {
    const add = useWords.getState().add;
    let n = 0;
    for (const f of fresh) {
      if (!picked.has(f.entry.lemma)) continue;
      prefetchClip(ep.id, f.seg.start, f.seg.end);
      add({
        id: f.entry.lemma,
        word: f.token,
        ipa: f.entry.ipa,
        meaning: f.entry.meaning,
        tag: tagLabel(f.entry.tags),
        sentence: f.seg.text,
        sentenceZh: typeof zh?.[f.idx] === "string" ? (zh[f.idx] as string) : undefined,
        episodeId: ep.id,
        episodeTitle: ep.title,
        showTitle: ep.showTitle ?? undefined,
        start: f.seg.start,
        end: f.seg.end,
      });
      n++;
    }
    useStore.getState().notify(t("已加入 {n} 个词到生词本", { n }));
    onClose();
  };

  const addCount = [...picked].filter((id) => !words[id]).length;
  const ready = !!data && list.length > 0;

  return (
    <LearnModal
      title={t("本期生词")}
      onClose={onClose}
      foot={
        ready ? (
          <>
            <button type="button" className="btn" onClick={onClose}>
              {t("取消")}
            </button>
            <button type="button" className="btn primary" disabled={!picked.size} onClick={addPicked}>
              {t("加入 {n} 个词", { n: addCount })}
            </button>
          </>
        ) : undefined
      }
    >
      {!data ? (
        <div className="panel-empty">
          <Loader2 className="spin" size={18} />
        </div>
      ) : !list.length ? (
        <EmptyState title={t("这一期没有超出你水平的词")} note={t("可以在 设置 › 学英语 里调高水平")} />
      ) : (
        <>
          <p className="muted small ew-note">{t("按难度从高到低排列，默认勾选前 15 个还没收藏的词。")}</p>
          <div className="ew-list">
            {list.map((f) => {
              const have = !!words[f.entry.lemma];
              return (
                <label key={f.entry.lemma} className={`ew-item${have ? " have" : ""}`}>
                  <input
                    type="checkbox"
                    checked={have || picked.has(f.entry.lemma)}
                    disabled={have}
                    onChange={() => toggle(f.entry.lemma)}
                  />
                  <span className="ew-w">{f.entry.lemma}</span>
                  {tagLabel(f.entry.tags) && <span className="pill">{tagLabel(f.entry.tags)}</span>}
                  <span className="ew-d">{f.entry.meaning.split("\n")[0]}</span>
                  {f.count > 1 && <span className="muted small ew-n">×{f.count}</span>}
                </label>
              );
            })}
          </div>
        </>
      )}
    </LearnModal>
  );
}

type ShadowPhase = "playing" | "waiting";
interface ShadowPiece {
  start: number;
  end: number;
  text: string;
}
interface ShadowState {
  phase: ShadowPhase;
  piece: ShadowPiece | null;
  waitTotal: number;
  waitUntil: number;
}
const shadowInitial: ShadowState = { phase: "playing", piece: null, waitTotal: 0, waitUntil: 0 };
const useShadow = create<ShadowState>(() => shadowInitial);

let shadowControls: { replay: () => void; skip: () => void } | null = null;

/** 跟读：每句结束后定时停顿（倒计时条 + 重听/下一句）；不做本机 ASR 打分。 */
export function useShadowing(on: boolean, epId: string, segments: Segment[]) {
  useEffect(() => {
    if (!on) return;
    let alive = true;
    let resume: number | undefined;
    let lastEnd = -1;
    useShadow.setState({ ...shadowInitial });

    const play = () => {
      const st = useStore.getState();
      if (st.current?.id === epId && !st.playing) st.player?.play();
    };
    const next = () => {
      useShadow.setState({ phase: "playing", piece: null, waitTotal: 0, waitUntil: 0 });
      play();
    };

    shadowControls = {
      replay: () => {
        const p = useShadow.getState().piece;
        window.clearTimeout(resume);
        if (!p) return;
        lastEnd = -1;
        useShadow.setState({ phase: "playing", piece: null, waitTotal: 0, waitUntil: 0 });
        const st = useStore.getState();
        st.player?.seek(p.start);
        play();
      },
      skip: () => {
        window.clearTimeout(resume);
        next();
      },
    };

    const unsub = useStore.subscribe((s, prev) => {
      if (s.current?.id !== epId) return;
      // 手动续播：结束当前停顿
      if (s.playing && !prev.playing && useShadow.getState().phase === "waiting") {
        window.clearTimeout(resume);
        useShadow.setState({ phase: "playing", piece: null, waitTotal: 0, waitUntil: 0 });
      }
      if (!s.playing || s.time === prev.time) return;
      const seg = segments.find((x) => prev.time < x.end && s.time >= x.end && s.time - x.end < 1.5);
      if (!seg || seg.end === lastEnd) return;
      lastEnd = seg.end;
      s.player?.toggle();
      const gap = Math.min(12, Math.max(1.5, (seg.end - seg.start) * 1.1 + 0.6));
      const ms = Math.round(gap * 1000);
      useShadow.setState({
        phase: "waiting",
        piece: { start: seg.start, end: seg.end, text: seg.text },
        waitTotal: ms,
        waitUntil: Date.now() + ms,
      });
      resume = window.setTimeout(() => {
        if (alive && useShadow.getState().phase === "waiting") next();
      }, ms);
    });

    return () => {
      alive = false;
      shadowControls = null;
      unsub();
      window.clearTimeout(resume);
      useShadow.setState({ ...shadowInitial });
    };
  }, [on, epId, segments]);
}

/** 跟读条：等待倒计时 + 重听原句 / 下一句。 */
export function ShadowBar({ onExit }: { onExit: () => void }) {
  const t = useT();
  const { phase, piece, waitTotal, waitUntil } = useShadow();
  const [waitLeft, setWaitLeft] = useState(0);

  useEffect(() => {
    if (phase !== "waiting" || !waitUntil) {
      setWaitLeft(0);
      return;
    }
    const update = () => setWaitLeft(Math.max(0, waitUntil - Date.now()));
    update();
    const id = window.setInterval(update, 100);
    return () => window.clearInterval(id);
  }, [phase, waitUntil]);

  const waitPct = waitTotal > 0 ? Math.min(100, Math.max(0, (waitLeft / waitTotal) * 100)) : 0;
  const status =
    phase === "waiting"
      ? t("轮到你了，跟着说一遍（{s}s 后继续）", { s: Math.max(1, Math.ceil(waitLeft / 1000)) })
      : t("跟读模式：每句说完会停一下，跟着说一遍");

  return (
    <div className="shadow-bar">
      <div className="shadow-head">
        <Mic size={13} />
        <span className="shadow-status">{status}</span>
        <button type="button" className="btn ghost sm" onClick={onExit}>
          {t("退出")}
        </button>
      </div>
      {piece && phase === "waiting" && (
        <>
          <p className="shadow-line">{piece.text}</p>
          <div className="shadow-wait-bar" aria-hidden>
            <span style={{ width: `${waitPct}%` }} />
          </div>
          <div className="shadow-actions">
            <button type="button" className="btn ghost sm" onClick={() => shadowControls?.replay()}>
              <Volume2 size={13} /> {t("重听原句")}
            </button>
            <button type="button" className="btn ghost sm" onClick={() => shadowControls?.skip()}>
              <SkipForward size={13} /> {t("下一句")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const norm = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z0-9']+/g) ?? [];

function compare(original: string, typed: string): { word: string; ok: boolean }[] {
  const a = original.match(/\S+/g) ?? [];
  const an = a.map((w) => norm(w).join(""));
  const b = norm(typed);
  const dp = Array.from({ length: an.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = an.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = an[i] && an[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { word: string; ok: boolean }[] = [];
  let i = 0;
  let j = 0;
  while (i < an.length) {
    if (!an[i]) {
      out.push({ word: a[i], ok: true });
      i++;
      continue;
    }
    if (j < b.length && an[i] === b[j]) {
      out.push({ word: a[i], ok: true });
      i++;
      j++;
    } else if (j < b.length && dp[i][j + 1] >= dp[i + 1][j]) j++;
    else {
      out.push({ word: a[i], ok: false });
      i++;
    }
  }
  return out;
}

export function Dictation({
  ep,
  segments,
  from,
  onClose,
}: {
  ep: Episode;
  segments: Segment[];
  from: number;
  onClose: () => void;
}) {
  const t = useT();
  const usable = useMemo(
    () => segments.map((_, i) => i).filter((i) => (segments[i].text.match(/\S+/g)?.length ?? 0) >= 3),
    [segments],
  );
  const startAt = Math.max(0, usable.findIndex((i) => i >= from));
  const [k, setK] = useState(startAt < 0 ? 0 : startAt);
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<{ word: string; ok: boolean }[] | null>(null);
  const [score, setScore] = useState({ right: 0, total: 0 });
  const input = useRef<HTMLTextAreaElement>(null);
  const seg = segments[usable[k]];

  const play = useCallback(() => {
    if (seg) void playClip(ep, seg.start, seg.end, seg.text);
  }, [ep, seg]);

  useEffect(() => {
    setTyped("");
    setResult(null);
    play();
    input.current?.focus();
  }, [k]);

  useEffect(() => () => stopClip(), []);

  if (!seg) {
    return (
      <LearnModal title={t("听写练习")} onClose={onClose}>
        <EmptyState title={t("这一期没有适合听写的句子")} />
      </LearnModal>
    );
  }

  const check = () => {
    const r = compare(seg.text, typed);
    setResult(r);
    setScore((s) => ({ right: s.right + r.filter((x) => x.ok).length, total: s.total + r.length }));
  };
  const next = () => setK((x) => Math.min(usable.length - 1, x + 1));

  return (
    <LearnModal title={t("听写练习")} onClose={onClose}>
      <div className="dict">
        <div className="dict-top">
          <span className="muted small">
            {t("第 {n} 句", { n: k + 1 })} · {clock(seg.start)}
          </span>
          {score.total > 0 && (
            <span className="muted small">{t("正确率 {pct}%", { pct: Math.round((score.right / score.total) * 100) })}</span>
          )}
        </div>
        <button type="button" className="btn play dict-play" onClick={play}>
          <Play size={13} className="fill-ico" />
          {t("再听一遍")}
        </button>
        <textarea
          ref={input}
          className="dict-input"
          rows={3}
          spellCheck={false}
          value={typed}
          placeholder={t("听到什么就写什么，按 Enter 检查")}
          disabled={!!result}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!result) check();
            }
          }}
        />
        {result && (
          <div className="dict-result">
            <p className="dict-ans">
              {result.map((w, i) => (
                <span key={i} className={w.ok ? "" : "miss"}>
                  {w.word}{" "}
                </span>
              ))}
            </p>
            <p className="muted small">
              {t("听出 {ok}/{total} 个词", { ok: result.filter((x) => x.ok).length, total: result.length })}
            </p>
          </div>
        )}
        <div className="modal-foot">
          <button
            type="button"
            className="btn ghost"
            onClick={() => setResult(compare(seg.text, ""))}
            disabled={!!result}
          >
            {t("看答案")}
          </button>
          <span className="spacer" />
          {result ? (
            <button type="button" className="btn primary" onClick={next} disabled={k >= usable.length - 1} autoFocus>
              {t("下一句")}
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={check} disabled={!typed.trim()}>
              {t("检查")}
            </button>
          )}
        </div>
      </div>
    </LearnModal>
  );
}

