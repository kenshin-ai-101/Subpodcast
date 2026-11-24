/**
 * [INPUT]: words / clip / sfx / api.exportAnki·saveText·getEpisode；LearnStats；LearnModal
 * [OUTPUT]: WordsView、exportWords、openWord、useDueCount、remindReview
 * [POS]: 生词本列表（统计热力）/ 词详情（原声与统一朗读）/ 回想·拼写复习 / Anki·CSV
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import confetti from "canvas-confetti";
import {
  ArrowUpRight,
  BookMarked,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Search,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import { api, errText, type AnkiNote } from "../lib/api";
import { ask } from "../lib/confirm";
import { clipKey, playClip, prefetchClip, prepareClip, speak, stopClip, toggleClip } from "../lib/clip";
import { clock } from "../lib/format";
import { resolveLocale, tNow, useT } from "../lib/i18n";
import { playSoon } from "../lib/playback";
import { doneSound, keySound, rightSound, wrongSound } from "../lib/sfx";
import { Rating, intervals, isMastered, reviewQueue, toCsv, useWords, type Grade, type Word } from "../lib/words";
import { seekSoon, useStore } from "../store";
import { ClipIcon, ClipLabel, EmptyState, Meaning, dueLabel, fmtWait, useLearnOn } from "./Learn";
import { LearnModal } from "./LearnModal";
import { LearnStats } from "./LearnStats";

type Filter = "due" | "all" | "mastered";
type Mode = "recall" | "spell";

const MODE_KEY = "subpodcast-review-mode";
const SINGLE_SHOW = "单独打开";

const useWordDetail = create<{ id: string | null }>(() => ({ id: null }));

/** 打开词详情；若不在生词本页则先跳转。 */
export function openWord(id: string) {
  useWordDetail.setState({ id });
  if (useStore.getState().view.kind !== "words") useStore.getState().go({ kind: "words" });
}

const sourceOf = (w: Word) =>
  [w.showTitle && w.showTitle !== SINGLE_SHOW ? w.showTitle : "", w.episodeTitle].filter(Boolean).join(" · ");

async function playWord(w: Word, toggle = false) {
  // fallbackText：无剪辑时 TTS 也挂同一 key，按钮才能变成「暂停」并停掉
  await (toggle ? toggleClip : playClip)({ id: w.episodeId }, w.start, w.end, w.sentence);
}

/** 打开来源单集，从该句前一秒起播。 */
async function openSource(w: Pick<Word, "episodeId" | "start">) {
  stopClip();
  const s = useStore.getState();
  const at = Math.max(0, w.start - 1);
  if (s.current?.id === w.episodeId && s.player) {
    s.player.seek(at);
    s.player.play();
  } else {
    const ep = await api.getEpisode(w.episodeId).catch(() => null);
    if (!ep) {
      s.notify(tNow("这一集已经不在了"));
      return;
    }
    s.load({ ...ep, progress: at });
    seekSoon(at);
    playSoon(ep.id);
  }
  useWordDetail.setState({ id: null });
  s.go({ kind: "episode", id: w.episodeId });
}

const wordRe = (w: string, flags = "i") =>
  new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, flags);

function Marked({ sentence, word }: { sentence: string; word: string }) {
  const parts = sentence.split(new RegExp(`(${wordRe(word).source})`, "i"));
  return (
    <>
      {parts.map((p, k) => (k % 2 ? <mark key={k}>{p}</mark> : p))}
    </>
  );
}

function ExportButtons({ words }: { words: Word[] }) {
  const t = useT();
  return (
    <>
      <button type="button" className="btn sm" onClick={() => void exportWords("anki", words)}>
        <Download size={13} />
        {t("导出 Anki")}
      </button>
      <button type="button" className="btn sm ghost" onClick={() => void exportWords("csv", words)}>
        CSV
      </button>
    </>
  );
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let exporting = false;

/** 选路径后写出 Anki 包或 CSV。 */
export async function exportWords(kind: "anki" | "csv", words: Word[]) {
  if (exporting || !words.length) return;
  const notify = useStore.getState().notify;
  const name = tNow("声译生词本");
  const path = await saveDialog({
    defaultPath: `${name}.${kind === "anki" ? "apkg" : "csv"}`,
    filters: [kind === "anki" ? { name: "Anki", extensions: ["apkg"] } : { name: "CSV", extensions: ["csv"] }],
  }).catch(() => null);
  if (!path) return;
  exporting = true;
  try {
    const file = path.split(/[\\/]/).pop() ?? "";
    if (kind === "csv") {
      await api.saveText(
        path,
        toCsv(words, [
          tNow("单词"),
          tNow("音标"),
          tNow("释义"),
          tNow("在这句里"),
          tNow("原句"),
          tNow("译文"),
          tNow("节目"),
          tNow("单集"),
          tNow("时间"),
          tNow("加入日期"),
        ]),
      );
    } else {
      const clips = new Map<string, string | null>();
      let done = 0;
      const todo = [...words];
      notify(tNow("正在准备 {n} 个词的原声…", { n: words.length }));
      await Promise.all(
        [0, 1, 2].map(async () => {
          for (let w = todo.shift(); w; w = todo.shift()) {
            clips.set(w.id, await prepareClip(w.episodeId, w.start, w.end));
            if (++done % 10 === 0 && done < words.length) {
              notify(tNow("正在准备原声 {done}/{total}…", { done, total: words.length }));
            }
          }
        }),
      );
      const notes: AnkiNote[] = words.map((w) => ({
        id: w.id,
        word: esc(w.id),
        ipa: esc(w.ipa),
        meaning: esc(w.meaning).replace(/\n/g, "<br>"),
        context: esc(w.ctx ?? ""),
        sentence: esc(w.sentence).replace(wordRe(esc(w.word)), (m) => `<b>${m}</b>`),
        translation: esc(w.sentenceZh ?? ""),
        source: esc([w.showTitle, w.episodeTitle, clock(w.start)].filter(Boolean).join(" · ")),
        tags: ["subpodcast", w.tag].filter(Boolean).map((x) => x.replace(/\s+/g, "_")).join(" "),
        clip: clips.get(w.id) ?? null,
      }));
      const withAudio = await api.exportAnki(path, name, tNow("声译单词"), notes);
      notify(
        withAudio < words.length
          ? tNow("已导出 {n} 个词（{audio} 个带原声）：{file}", { n: words.length, audio: withAudio, file })
          : tNow("已导出 {n} 个词：{file}", { n: words.length, file }),
      );
      void revealItemInDir(path).catch(() => {});
      return;
    }
    notify(tNow("已导出 {n} 个词：{file}", { n: words.length, file }));
    void revealItemInDir(path).catch(() => {});
  } catch (e) {
    notify(tNow("导出失败：{msg}", { msg: errText(e) }));
  } finally {
    exporting = false;
  }
}

const GRADES: [Grade, string, string][] = [
  [Rating.Again, "again", "忘了"],
  [Rating.Hard, "hard", "困难"],
  [Rating.Good, "good", "记得"],
  [Rating.Easy, "easy", "简单"],
];

const readMode = (): Mode => {
  try {
    return localStorage.getItem(MODE_KEY) === "spell" ? "spell" : "recall";
  } catch {
    return "recall";
  }
};

const normLetter = (x: string) => x.toLowerCase().replace(/[’‘]/g, "'");

/** 最长公共子序列掩码：标出多打 / 漏打的字母。 */
function lcsMask(a: string, b: string): [boolean[], boolean[]] {
  const A = normLetter(a);
  const B = normLetter(b);
  const L = Array.from({ length: A.length + 1 }, () => new Array<number>(B.length + 1).fill(0));
  for (let x = A.length - 1; x >= 0; x--)
    for (let y = B.length - 1; y >= 0; y--)
      L[x][y] = A[x] === B[y] ? L[x + 1][y + 1] + 1 : Math.max(L[x + 1][y], L[x][y + 1]);
  const ma = new Array<boolean>(A.length).fill(false);
  const mb = new Array<boolean>(B.length).fill(false);
  for (let x = 0, y = 0; x < A.length && y < B.length; ) {
    if (A[x] === B[y]) {
      ma[x++] = true;
      mb[y++] = true;
    } else if (L[x + 1][y] >= L[x][y + 1]) x++;
    else y++;
  }
  return [ma, mb];
}

function Diff({ typed, answer }: { typed: string; answer: string }) {
  const [mt, ma] = lcsMask(typed, answer);
  return (
    <>
      <span className="sp-typed">
        {[...typed].map((c, k) => (
          <span key={k} className={mt[k] ? "" : "x"}>
            {c}
          </span>
        ))}
      </span>
      <span className="sp-arrow">→</span>
      <span className="sp-ans">
        {[...answer].map((c, k) => (
          <span key={k} className={ma[k] ? "" : "x"}>
            {c}
          </span>
        ))}
      </span>
    </>
  );
}

function Letters({ typed, answer }: { typed: string; answer: string }) {
  const cells = [];
  for (let k = 0; k < Math.max(answer.length, typed.length); k++) {
    const c = typed[k];
    const cls =
      c == null ? (k === typed.length ? "cur" : "") : normLetter(c) === normLetter(answer[k] ?? "") ? "ok" : "bad";
    cells.push(
      <span key={k} className={`sp-c ${cls}`}>
        {c ?? ""}
      </span>,
    );
  }
  return <span className="sp-row">{cells}</span>;
}

let fire: confetti.CreateTypes | null = null;
const CONFETTI = ["#e8582a", "#f2a679", "#f2d091", "#5d8c7b", "#3a6df0"];

function confettiAt(opts: confetti.Options) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!fire) {
    const c = document.createElement("canvas");
    c.className = "confetti";
    document.body.appendChild(c);
    fire = confetti.create(c, { resize: true, useWorker: false });
  }
  void fire({ colors: CONFETTI, shapes: ["square", "circle"], scalar: 0.9, ...opts });
}

function burst(el: Element | null) {
  const r = el?.getBoundingClientRect();
  const origin = r
    ? { x: (r.left + r.width / 2) / window.innerWidth, y: (r.top + r.height / 2) / window.innerHeight }
    : { x: 0.5, y: 0.5 };
  confettiAt({ particleCount: 60, spread: 70, startVelocity: 30, ticks: 140, origin });
}

function celebrate() {
  window.setTimeout(() => confettiAt({ particleCount: 60, angle: 60, spread: 100, origin: { x: 0, y: 0.7 }, ticks: 260 }), 150);
  window.setTimeout(() => confettiAt({ particleCount: 60, angle: 120, spread: 100, origin: { x: 1, y: 0.7 }, ticks: 260 }), 300);
}

function Spell({
  w,
  onCheck,
  onExit,
}: {
  w: Word;
  onCheck: (r: { ok: boolean; typed: string; hints: number }) => void;
  onExit: () => void;
}) {
  const t = useT();
  const [typed, setTyped] = useState("");
  const [hints, setHints] = useState(0);
  const [shake, setShake] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const row = useRef<HTMLSpanElement>(null);
  const answer = w.word;

  const finish = (v: string) => {
    const ok = normLetter(v) === normLetter(answer);
    if (ok) {
      rightSound();
      burst(row.current);
    } else wrongSound();
    onCheck({ ok, typed: v, hints });
  };

  const change = (raw: string) => {
    const v = raw.replace(/\s/g, "");
    if (v.length > typed.length) {
      const k = v.length - 1;
      if (normLetter(v[k]) === normLetter(answer[k] ?? "")) keySound();
      else {
        wrongSound();
        setShake((n) => n + 1);
      }
    }
    setTyped(v);
    if (normLetter(v) === normLetter(answer)) finish(v);
  };

  const hint = () => {
    let k = 0;
    while (k < typed.length && normLetter(typed[k]) === normLetter(answer[k])) k++;
    if (k >= answer.length) return;
    setTyped(answer.slice(0, k + 1));
    setHints((h) => h + 1);
    input.current?.focus();
  };

  return (
    <div className="sp" onClick={() => input.current?.focus()}>
      <span ref={row} key={shake} className={shake ? "sp-shake" : ""}>
        <Letters typed={typed} answer={answer} />
      </span>
      <input
        ref={input}
        className="sp-in"
        autoFocus
        value={typed}
        maxLength={answer.length + 3}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        aria-label={t("拼写这个词")}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finish(typed);
          } else if (e.key === "Tab") {
            e.preventDefault();
            hint();
          } else if (e.key === " ") {
            e.preventDefault();
            void playWord(w);
          } else if (e.key === "Escape") onExit();
        }}
      />
      <p className="sp-help">
        {t("{n} 个字母", { n: answer.length })} · <span className="kbd">Tab</span> {t("提示一个字母")} ·{" "}
        <span className="kbd">␣</span> {t("重听")} · <span className="kbd">↵</span> {t("检查")}
      </p>
    </div>
  );
}

function Review({ queue, onDone }: { queue: Word[]; onDone: () => void }) {
  const t = useT();
  const [list, setList] = useState<Word[]>(() => [...queue]);
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [mode, setModeState] = useState<Mode>(readMode);
  const [spelled, setSpelled] = useState<{ ok: boolean; typed: string; hints: number } | null>(null);

  const setMode = (m: Mode) => {
    setModeState(m);
    setFlipped(false);
    setSpelled(null);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* ignore */
    }
  };

  const suggest: Grade = spelled ? (spelled.ok ? (spelled.hints ? Rating.Hard : Rating.Good) : Rating.Again) : Rating.Good;
  const w = list[i];
  const gaps = useMemo(() => (w ? intervals(useWords.getState().words[w.id] ?? w) : null), [w, flipped]);

  useEffect(() => {
    if (w) void playWord(w);
    for (const n of list.slice(i + 1, i + 4)) prefetchClip(n.episodeId, n.start, n.end);
    return () => stopClip();
  }, [i]);

  useEffect(() => {
    if (flipped && w) speak(w.id);
  }, [flipped]);

  const rate = useCallback(
    (g: Grade) => {
      if (!w) return;
      useWords.getState().rate(w.id, g);
      if (g === Rating.Again) setList((prev) => [...prev, w]);
      setFlipped(false);
      setSpelled(null);
      setI((x) => x + 1);
    },
    [w],
  );

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      if (mode === "spell" && !flipped && e.key !== "Escape" && !e.metaKey && !e.ctrlKey) {
        document.querySelector<HTMLInputElement>(".sp-in")?.focus();
        return;
      }
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (!flipped) setFlipped(true);
        else rate(suggest);
      } else if (flipped && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        rate(Number(e.key) as Grade);
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        e.stopPropagation();
        if (w) void playWord(w);
      } else if (flipped && e.key.toLowerCase() === "w") {
        e.preventDefault();
        e.stopPropagation();
        if (w) speak(w.id);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDone();
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [flipped, rate, w, onDone, suggest, mode]);

  const finished = !w && list.length > 0;
  useEffect(() => {
    if (finished) {
      doneSound();
      celebrate();
    }
  }, [finished]);

  if (!w) {
    return (
      <div className="page review-page">
        <EmptyState
          art={
            <span className="wb-empty-ic done">
              <Check size={28} />
            </span>
          }
          title={t("今天的复习完成了")}
          note={t("复习了 {n} 个词，明天再来。", { n: new Set(list.map((x) => x.id)).size })}
        >
          <button type="button" className="btn primary" onClick={onDone}>
            {t("回到生词本")}
          </button>
        </EmptyState>
      </div>
    );
  }

  const blank = w.sentence.replace(wordRe(w.word), " _____ ");

  return (
    <div className="page review-page">
      <div className="rv-top">
        <button type="button" className="icon-btn sm" onClick={onDone} title={t("结束复习（Esc）")} aria-label={t("结束复习")}>
          <X size={16} />
        </button>
        <span className="rv-meter">
          <i style={{ width: `${(i / list.length) * 100}%` }} />
        </span>
        <span className="rv-num">
          {i + 1} / {list.length}
        </span>
        <div className="seg-control" role="radiogroup" aria-label={t("复习方式")}>
          {(
            [
              ["recall", t("回想")],
              ["spell", t("拼写")],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={mode === m ? "on" : ""}
              onClick={() => setMode(m)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="rv-card">
        {flipped ? (
          <button
            type="button"
            className="rv-src rv-src-link"
            onClick={() => void openSource(w)}
            title={t("打开这一集，从这句开始播放")}
          >
            <span className="clamp1">{sourceOf(w)}</span>
            <span className="wd-at">
              {clock(w.start)}
              <ArrowUpRight size={12} />
            </span>
          </button>
        ) : (
          <span className="rv-src clamp1">
            {sourceOf(w)} · {clock(w.start)}
          </span>
        )}
        {flipped ? (
          <>
            {spelled &&
              (spelled.ok ? (
                <p className="sp-result ok">
                  <span className="sp-tick">
                    <Check size={16} strokeWidth={3} />
                  </span>
                  {spelled.hints ? t("拼对了（用了 {n} 次提示）", { n: spelled.hints }) : t("拼对了！")}
                </p>
              ) : (
                <p className="sp-result bad">
                  {spelled.typed ? <Diff typed={spelled.typed} answer={w.word} /> : t("没拼出来")}
                </p>
              ))}
            <p className="rv-word">
              {w.id}
              <button
                type="button"
                className="icon-btn sm rv-say"
                title={t("读单词（W）")}
                aria-label={t("读单词")}
                onClick={() => speak(w.id)}
              >
                <Volume2 size={16} />
              </button>
            </p>
            {w.ipa && <p className="rv-ipa">/{w.ipa}/</p>}
            <div className="rv-def">
              <Meaning text={w.meaning} />
            </div>
            {w.ctx && (
              <p className="rv-ctx">
                <span className="wc-ctx-h">{t("在这句里")}</span>
                {w.ctx}
              </p>
            )}
            <p className="rv-sent">
              <Marked sentence={w.sentence} word={w.word} />
              {w.sentenceZh && <span className="rv-zh">{w.sentenceZh}</span>}
            </p>
          </>
        ) : (
          <>
            <p className="rv-q">{mode === "spell" ? t("听原句，拼出空着的词") : t("这句话里空着的是哪个词？")}</p>
            <p className="rv-sent front">{blank}</p>
            {mode === "spell" && (
              <>
                <p className="sp-mean">{w.ctx || w.meaning.split("\n")[0]}</p>
                <Spell
                  key={`${i}-${w.id}`}
                  w={w}
                  onExit={onDone}
                  onCheck={(r) => {
                    setSpelled(r);
                    setFlipped(true);
                  }}
                />
              </>
            )}
          </>
        )}
        <button type="button" className="btn sm play rv-listen" onClick={() => void playWord(w, true)}>
          <ClipLabel k={clipKey(w.episodeId, w.start, w.end)} label={t("再听原句")} />
          <span className="kbd">R</span>
        </button>
        {flipped ? (
          <div className="rv-rating">
            <p className="rv-rate-q">{t("记得怎么样？选一个，决定下次什么时候再考")}</p>
            <div className="rv-rate">
              {GRADES.map(([g, cls, label], ki) => (
                <button
                  key={g}
                  type="button"
                  className={`btn ${cls}${g === suggest ? " suggested" : ""}`}
                  onClick={() => rate(g)}
                  title={t("按 {n}", { n: ki + 1 })}
                >
                  <span className="t">{t(label)}</span>
                  <span className="s">{gaps ? t("{wait}后再考", { wait: fmtWait(gaps[g]) }) : ""}</span>
                </button>
              ))}
            </div>
            <p className="rv-keys">
              {t("键盘 1–4 选择，空格选「{label}」", { label: t(GRADES.find(([g]) => g === suggest)![2]) })}
            </p>
          </div>
        ) : mode === "spell" ? (
          <button
            type="button"
            className="btn ghost rv-show"
            onClick={() => {
              setSpelled({ ok: false, typed: "", hints: 0 });
              setFlipped(true);
            }}
          >
            {t("不会，看答案")}
          </button>
        ) : (
          <button type="button" className="btn primary rv-show" onClick={() => setFlipped(true)}>
            {t("显示答案")}
            <span className="kbd">␣</span>
          </button>
        )}
      </div>
    </div>
  );
}

function WordRow({ w, now }: { w: Word; now: number }) {
  const t = useT();
  const due = dueLabel(w, now);
  const open = () => useWordDetail.setState({ id: w.id });
  return (
    <div
      className="wb-item"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) open();
      }}
    >
      <div className="wb-main">
        <div className="wb-l1">
          <span className="wb-w">{w.id}</span>
          {w.ipa && <span className="wb-ipa">/{w.ipa}/</span>}
          {w.tag && <span className="pill">{t(w.tag)}</span>}
        </div>
        <p className="wb-d">{w.ctx || w.meaning.split("\n")[0]}</p>
        <p className="wb-src">
          <button
            type="button"
            className="ts-link"
            onClick={(e) => {
              e.stopPropagation();
              void playWord(w, true);
            }}
            title={t("播放原句")}
          >
            <ClipIcon k={clipKey(w.episodeId, w.start, w.end)} size={10} />
            {clock(w.start)}
          </button>
          <span className="clamp1">{sourceOf(w)}</span>
        </p>
      </div>
      <span className={`due ${due.now ? "now" : ""}`}>{due.text}</span>
      <ChevronRight size={16} className="wb-go" />
    </div>
  );
}

function WordDetail({ id, list, onClose }: { id: string; list: Word[]; onClose: () => void }) {
  const t = useT();
  const uiLang = useStore((s) => s.settings.uiLang);
  const w = useWords((s) => s.words[id]);
  const idx = list.findIndex((x) => x.id === id);
  const step = useCallback(
    (d: number) => {
      const n = list[idx + d];
      if (n) {
        stopClip();
        useWordDetail.setState({ id: n.id });
      }
    },
    [list, idx],
  );

  useEffect(() => {
    for (const n of [list[idx], list[idx + 1], list[idx - 1]]) if (n) prefetchClip(n.episodeId, n.start, n.end);
  }, [id]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select, button")) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      } else if (e.key === " " && w) {
        e.preventDefault();
        void playWord(w, true);
      } else if (e.key.toLowerCase() === "w" && w) {
        e.preventDefault();
        speak(w.id);
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [step, w]);

  if (!w) return null;
  const due = dueLabel(w, Date.now());
  const k = clipKey(w.episodeId, w.start, w.end);

  const remove = async () => {
    if (!(await ask(t("从生词本删除「{word}」？复习记录会一起删除。", { word: w.id })))) return;
    const next = list[idx + 1] ?? list[idx - 1];
    stopClip();
    useWords.getState().remove(w.id);
    useWordDetail.setState({ id: next && next.id !== w.id ? next.id : null });
  };

  return (
    <LearnModal
      title={w.id}
      onClose={onClose}
      head={
        <div className="wd-nav">
          <button
            type="button"
            className="icon-btn sm"
            disabled={idx <= 0}
            onClick={() => step(-1)}
            title={t("上一个（←）")}
            aria-label={t("上一个")}
          >
            <ChevronLeft size={16} />
          </button>
          <span className="wd-num">{idx >= 0 ? `${idx + 1} / ${list.length}` : ""}</span>
          <button
            type="button"
            className="icon-btn sm"
            disabled={idx < 0 || idx >= list.length - 1}
            onClick={() => step(1)}
            title={t("下一个（→）")}
            aria-label={t("下一个")}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      }
    >
      <div className="wd">
        <div className="wd-head">
          <span className="wd-word">{w.id}</span>
          <button
            type="button"
            className="icon-btn sm rv-say"
            title={t("读单词（W）")}
            aria-label={t("读单词")}
            onClick={() => speak(w.id)}
          >
            <Volume2 size={16} />
          </button>
          {w.tag && <span className="pill">{t(w.tag)}</span>}
        </div>
        {w.ipa && <p className="wc-ipa">/{w.ipa}/</p>}
        {w.meaning ? <Meaning text={w.meaning} /> : <p className="wc-none muted small">{t("词典里没有这个词")}</p>}
        {w.ctx && (
          <div className="wc-ctx">
            <span className="wc-ctx-h">{t("在这句里")}</span>
            {w.ctx}
          </div>
        )}
        <div className="wd-ex">
          <span className="wd-h">{t("原句")}</span>
          <p className="wd-sent">
            <Marked sentence={w.sentence} word={w.word} />
          </p>
          {w.sentenceZh && <p className="wd-zh">{w.sentenceZh}</p>}
          <div className="wd-ex-foot">
            <button type="button" className="btn sm play" onClick={() => void playWord(w, true)}>
              <ClipLabel k={k} label={t("听原声")} />
              <span className="kbd">␣</span>
            </button>
            <button
              type="button"
              className="wd-src"
              onClick={() => void openSource(w)}
              title={t("打开这一集，从这句开始播放")}
            >
              <span className="clamp1">{sourceOf(w)}</span>
              <span className="wd-at">
                {clock(w.start)}
                <ArrowUpRight size={13} />
              </span>
            </button>
          </div>
        </div>
        <div className="wd-foot">
          <span className="muted small">
            {w.card.reps ? t("复习 {n} 次", { n: w.card.reps }) : t("还没复习过")}
            {w.card.lapses > 0 && <> · {t("忘记 {n} 次", { n: w.card.lapses })}</>}
            {" · "}
            {w.card.state === 0
              ? t("新词")
              : due.now
                ? t("今天要复习")
                : t("{wait}后复习", { wait: fmtWait(w.card.due - Date.now()) })}
            {" · "}
            {t("{date} 加入", { date: new Date(w.added).toLocaleDateString(resolveLocale(uiLang)) })}
          </span>
          <button type="button" className="btn sm ghost danger" onClick={() => void remove()}>
            <Trash2 size={13} />
            {t("删除")}
          </button>
        </div>
      </div>
    </LearnModal>
  );
}

export function WordsView() {
  const t = useT();
  useLearnOn();
  const { words, loaded, day, newToday } = useWords(
    useShallow((s) => ({ words: s.words, loaded: s.loaded, day: s.day, newToday: s.newToday })),
  );
  const dailyNew = useStore((s) => s.settings.learnDaily);
  const on = useStore((s) => s.settings.learnOn);
  const set = useStore((s) => s.set);
  const detail = useWordDetail((s) => s.id);
  const [filter, setFilter] = useState<Filter>("due");
  const [query, setQuery] = useState("");
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => {
    void useWords.getState().load();
    return () => {
      stopClip();
      useWordDetail.setState({ id: null });
    };
  }, []);

  const now = Date.now();
  const all = useMemo(() => Object.values(words).sort((a, b) => b.added - a.added), [words]);
  const queue = useMemo(
    () => reviewQueue({ words, day, newToday }, dailyNew),
    [words, day, newToday, dailyNew, reviewing],
  );
  const mastered = all.filter(isMastered);

  useEffect(() => {
    for (const w of queue.slice(0, 4)) prefetchClip(w.episodeId, w.start, w.end);
  }, [queue]);

  const q = query.trim().toLowerCase();
  const listed = filter === "due" ? queue : filter === "mastered" ? mastered : all;
  const shown = q
    ? listed.filter((w) =>
        [w.id, w.word, w.meaning, w.ctx ?? "", w.sentence, w.episodeTitle].some((x) => x.toLowerCase().includes(q)),
      )
    : listed;
  const detailList = detail && shown.some((w) => w.id === detail) ? shown : all;
  const closeDetail = useCallback(() => {
    stopClip();
    useWordDetail.setState({ id: null });
  }, []);

  if (reviewing) return <Review queue={queue} onDone={() => setReviewing(false)} />;

  return (
    <div className="page words-page">
      <div className="wb-head">
        <h1 className="page-title">{t("生词本")}</h1>
        {all.length > 0 && <span className="muted wb-count">{t("{n} 个词", { n: all.length })}</span>}
        <div className="wb-acts">
          {all.length > 0 && <ExportButtons words={all} />}
          <button type="button" className="btn sm primary" disabled={!queue.length} onClick={() => setReviewing(true)}>
            {queue.length ? t("复习 {n} 个", { n: queue.length }) : t("今天复习完了")}
          </button>
        </div>
      </div>
      {!on && (
        <p className="wb-off muted small">
          {t("英语学习模式已关闭，生词本仍然保留。")}{" "}
          <button
            type="button"
            className="link-btn small"
            onClick={() => set({ settingsOpen: true, settingsSection: "learn" })}
          >
            {t("去打开")}
          </button>
        </p>
      )}
      {!loaded ? null : !all.length ? (
        <EmptyState
          art={
            <span className="wb-empty-ic">
              <BookMarked size={28} />
            </span>
          }
          title={t("生词本还是空的")}
          note={t("在英文节目的字幕里点一个单词，再点「加入生词本」。")}
        />
      ) : (
        <>
          <LearnStats onOpen={(id) => useWordDetail.setState({ id })} />
          <div className="wb-bar">
            <div className="chips left">
              {(
                [
                  ["due", t("待复习"), queue.length],
                  ["all", t("全部"), all.length],
                  ["mastered", t("已掌握"), mastered.length],
                ] as const
              ).map(([k, label, n]) => (
                <button
                  key={k}
                  type="button"
                  className={`chip ${filter === k ? "on" : ""}`}
                  onClick={() => setFilter(k)}
                >
                  {label}
                  <span className="n">{n}</span>
                </button>
              ))}
            </div>
            {all.length > 6 && (
              <label className="wb-search">
                <Search size={13} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("搜索单词、释义或例句")}
                  aria-label={t("搜索生词本")}
                />
              </label>
            )}
          </div>
          {!shown.length ? (
            <p className="muted small wb-none">
              {q
                ? t("没有找到「{q}」", { q: query.trim() })
                : filter === "due"
                  ? t("今天没有要复习的词了。")
                  : t("还没有掌握的词。连续答对，间隔超过 3 周就算掌握。")}
            </p>
          ) : (
            <div className="wb-list">
              {shown.map((w) => (
                <WordRow key={w.id} w={w} now={now} />
              ))}
            </div>
          )}
        </>
      )}
      {detail && <WordDetail id={detail} list={detailList} onClose={closeDetail} />}
    </div>
  );
}

/** 侧栏角标：今日待复习数。 */
export function useDueCount(): number {
  const on = useStore((s) => s.settings.learnOn);
  const dailyNew = useStore((s) => s.settings.learnDaily);
  const { words, day, newToday } = useWords(
    useShallow((s) => ({ words: s.words, day: s.day, newToday: s.newToday })),
  );
  useEffect(() => {
    if (on) void useWords.getState().load();
  }, [on]);
  return useMemo(
    () => (on ? reviewQueue({ words, day, newToday }, dailyNew).length : 0),
    [on, words, day, newToday, dailyNew],
  );
}

/** 启动后每日一次：有待复习则 toast。 */
export async function remindReview() {
  const s = useStore.getState().settings;
  if (!s.learnOn || !s.learnRemind) return;
  const key = "subpodcast-learn-reminded";
  const d = new Date().toLocaleDateString("sv");
  try {
    if (localStorage.getItem(key) === d) return;
  } catch {
    /* 隐私模式仍提醒 */
  }
  await useWords.getState().load();
  const w = useWords.getState();
  const n = reviewQueue(w, s.learnDaily).length;
  if (!n) return;
  try {
    localStorage.setItem(key, d);
  } catch {
    /* ignore */
  }
  useStore.getState().notify(tNow("生词本里有 {n} 个词等你复习", { n }));
}
