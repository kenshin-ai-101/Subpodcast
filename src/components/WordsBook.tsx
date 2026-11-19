/**
 * [INPUT]: words / clip / api.exportAnki/saveText；plugin-dialog
 * [OUTPUT]: WordsView、exportWords、useDueCount、remindReview
 * [POS]: 英语学习 · 生词本与 FSRS 复习
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { BookMarked, Check, Download, Trash2, Volume2, X } from "lucide-react";
import { api, errText, type AnkiNote } from "../lib/api";
import { clipKey, playClip, prefetchClip, prepareClip, speak, stopClip } from "../lib/clip";
import { clock } from "../lib/format";
import { Rating, intervals, isMastered, reviewQueue, toCsv, useWords, type Grade, type Word } from "../lib/words";
import { useStore } from "../store";
import { ClipIcon, EmptyState, Meaning, dueLabel, fmtWait, useLearnOn } from "./Learn";

type Filter = "due" | "all" | "mastered";

async function playWord(w: Word) {
  if (!(await playClip({ id: w.episodeId }, w.start, w.end))) speak(w.sentence);
}

function ExportButtons({ words }: { words: Word[] }) {
  return (
    <>
      <button type="button" className="btn sm" onClick={() => void exportWords("anki", words)}>
        <Download size={13} />
        导出 Anki
      </button>
      <button type="button" className="btn sm ghost" onClick={() => void exportWords("csv", words)}>
        CSV
      </button>
    </>
  );
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const wordRe = (w: string, flags = "i") =>
  new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, flags);

let exporting = false;

/** 选路径后写出 Anki 包或 CSV。 */
export async function exportWords(kind: "anki" | "csv", words: Word[]) {
  if (exporting || !words.length) return;
  const notify = useStore.getState().notify;
  const name = "声译生词本";
  const path = await saveDialog({
    defaultPath: `${name}.${kind === "anki" ? "apkg" : "csv"}`,
    filters: [kind === "anki" ? { name: "Anki", extensions: ["apkg"] } : { name: "CSV", extensions: ["csv"] }],
  }).catch(() => null);
  if (!path) return;
  exporting = true;
  try {
    if (kind === "csv") {
      await api.saveText(
        path,
        toCsv(words, ["单词", "音标", "释义", "在这句里", "原句", "译文", "节目", "单集", "时间", "加入日期"]),
      );
    } else {
      const clips = new Map<string, string | null>();
      let done = 0;
      const todo = [...words];
      notify(`正在准备 ${words.length} 个词的原声…`);
      await Promise.all(
        [0, 1, 2].map(async () => {
          for (let w = todo.shift(); w; w = todo.shift()) {
            clips.set(w.id, await prepareClip(w.episodeId, w.start, w.end));
            if (++done % 10 === 0 && done < words.length) notify(`正在准备原声 ${done}/${words.length}…`);
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
      const withAudio = await api.exportAnki(path, name, "声译单词", notes);
      notify(
        withAudio < words.length
          ? `已导出 ${words.length} 个词（${withAudio} 个带原声）：${path.split(/[\\/]/).pop() ?? ""}`
          : `已导出 ${words.length} 个词：${path.split(/[\\/]/).pop() ?? ""}`,
      );
      void revealItemInDir(path).catch(() => {});
      return;
    }
    notify(`已导出 ${words.length} 个词：${path.split(/[\\/]/).pop() ?? ""}`);
    void revealItemInDir(path).catch(() => {});
  } catch (e) {
    notify(`导出失败：${errText(e)}`);
  } finally {
    exporting = false;
  }
}

const GRADES: [Grade, string, string][] = [
  [Rating.Again, "again", "忘了"],
  [Rating.Hard, "", "困难"],
  [Rating.Good, "good", "记得"],
  [Rating.Easy, "", "简单"],
];

function Review({ queue, onDone }: { queue: Word[]; onDone: () => void }) {
  const [list] = useState(queue);
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const w = list[i];
  const gaps = useMemo(() => (w ? intervals(useWords.getState().words[w.id] ?? w) : null), [w, flipped]);

  useEffect(() => {
    if (w) void playWord(w);
    for (const n of list.slice(i + 1, i + 4)) prefetchClip(n.episodeId, n.start, n.end);
    return () => stopClip();
  }, [i]);

  useEffect(() => {
    if (flipped && w) speak(w.id, 0.85);
  }, [flipped]);

  const rate = useCallback(
    (g: Grade) => {
      if (!w) return;
      useWords.getState().rate(w.id, g);
      if (g === Rating.Again) list.push(w);
      setFlipped(false);
      setI((x) => x + 1);
    },
    [w, list],
  );

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (!flipped) setFlipped(true);
        else rate(Rating.Good);
      } else if (flipped && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        rate(Number(e.key) as Grade);
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        if (w) void playWord(w);
      } else if (flipped && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (w) speak(w.id, 0.85);
      } else if (e.key === "Escape") onDone();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [flipped, rate, w, onDone]);

  if (!w) {
    return (
      <div className="page review-page">
        <EmptyState
          art={
            <span className="wb-empty-ic done">
              <Check size={28} />
            </span>
          }
          title="今天的复习完成了"
          note={`复习了 ${new Set(list.map((x) => x.id)).size} 个词，明天再来。`}
        >
          <button type="button" className="btn primary" onClick={onDone}>
            回到生词本
          </button>
        </EmptyState>
      </div>
    );
  }

  const blank = w.sentence.replace(
    new RegExp(`\\b${w.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
    " _____ ",
  );
  const marked = w.sentence.split(
    new RegExp(`(\\b${w.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b)`, "i"),
  );

  return (
    <div className="page review-page">
      <div className="rv-top">
        <button type="button" className="icon-btn sm" onClick={onDone} title="结束复习（Esc）" aria-label="结束复习">
          <X size={16} />
        </button>
        <span className="rv-meter">
          <i style={{ width: `${(i / list.length) * 100}%` }} />
        </span>
        <span className="rv-num">
          {i + 1} / {list.length}
        </span>
      </div>
      <div className="rv-card">
        <span className="rv-src clamp1">
          {w.showTitle ? `${w.showTitle} · ` : ""}
          {clock(w.start)}
        </span>
        {flipped ? (
          <>
            <p className="rv-word">
              {w.id}
              <button
                type="button"
                className="icon-btn sm rv-say"
                title="读单词（W）"
                aria-label="读单词"
                onClick={() => speak(w.id, 0.85)}
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
                <span className="wc-ctx-h">在这句里</span>
                {w.ctx}
              </p>
            )}
            <p className="rv-sent">
              {marked.map((p, ki) => (ki % 2 ? <mark key={ki}>{p}</mark> : p))}
              {w.sentenceZh && <span className="rv-zh">{w.sentenceZh}</span>}
            </p>
          </>
        ) : (
          <>
            <p className="rv-q">这句话里空着的是哪个词？</p>
            <p className="rv-sent front">{blank}</p>
          </>
        )}
        <button type="button" className="btn sm play rv-listen" onClick={() => void playWord(w)}>
          <ClipIcon k={clipKey(w.episodeId, w.start, w.end)} />
          再听原句
          <span className="kbd">R</span>
        </button>
        {flipped ? (
          <div className="rv-rate">
            {GRADES.map(([g, cls, label], ki) => (
              <button key={g} type="button" className={`btn ${cls}`} onClick={() => rate(g)}>
                <span className="t">{label}</span>
                <span className="s">
                  <span className="kbd">{ki + 1}</span>
                  {gaps ? fmtWait(gaps[g]) : ""}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <button type="button" className="btn primary rv-show" onClick={() => setFlipped(true)}>
            显示答案
            <span className="kbd">␣</span>
          </button>
        )}
      </div>
    </div>
  );
}

export function WordsView() {
  useLearnOn();
  const { words, loaded, day, newToday } = useWords(
    useShallow((s) => ({ words: s.words, loaded: s.loaded, day: s.day, newToday: s.newToday })),
  );
  const dailyNew = useStore((s) => s.settings.learnDaily);
  const on = useStore((s) => s.settings.learnOn);
  const set = useStore((s) => s.set);
  const [filter, setFilter] = useState<Filter>("due");
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => {
    void useWords.getState().load();
    return () => stopClip();
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

  const shown = filter === "due" ? queue : filter === "mastered" ? mastered : all;

  if (reviewing) return <Review queue={queue} onDone={() => setReviewing(false)} />;

  return (
    <div className="page words-page">
      <div className="wb-head">
        <h1 className="page-title">生词本</h1>
        {all.length > 0 && <span className="muted wb-count">{all.length} 个词</span>}
        <div className="wb-acts">
          {all.length > 0 && <ExportButtons words={all} />}
          <button type="button" className="btn sm primary" disabled={!queue.length} onClick={() => setReviewing(true)}>
            {queue.length ? `复习 ${queue.length} 个` : "今天复习完了"}
          </button>
        </div>
      </div>
      {!on && (
        <p className="wb-off muted small">
          英语学习模式已关闭，生词本仍然保留。{" "}
          <button
            type="button"
            className="link-btn small"
            onClick={() => set({ settingsOpen: true, settingsSection: "learn" })}
          >
            去打开
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
          title="生词本还是空的"
          note="在英文节目的字幕里点一个单词，再点「加入生词本」。"
        />
      ) : (
        <>
          <div className="chips left">
            {(
              [
                ["due", "待复习", queue.length],
                ["all", "全部", all.length],
                ["mastered", "已掌握", mastered.length],
              ] as const
            ).map(([k, label, n]) => (
              <button key={k} type="button" className={`chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>
                {label}
                <span className="n">{n}</span>
              </button>
            ))}
          </div>
          {!shown.length ? (
            <p className="muted small wb-none">
              {filter === "due"
                ? "今天没有要复习的词了。"
                : "还没有掌握的词。连续答对，间隔超过 3 周就算掌握。"}
            </p>
          ) : (
            <div className="wb-list">
              {shown.map((w) => {
                const due = dueLabel(w, now);
                return (
                  <div key={w.id} className="wb-item">
                    <div className="wb-main">
                      <div className="wb-l1">
                        <span className="wb-w">{w.id}</span>
                        {w.ipa && <span className="wb-ipa">/{w.ipa}/</span>}
                        {w.tag && <span className="pill">{w.tag}</span>}
                      </div>
                      <p className="wb-d">{w.ctx || w.meaning.split("\n")[0]}</p>
                      <p className="wb-src">
                        <span className="clamp1">{w.showTitle || w.episodeTitle}</span>
                        <button
                          type="button"
                          className="ts-link"
                          onClick={() => void playWord(w)}
                          title="播放原句"
                        >
                          <ClipIcon k={clipKey(w.episodeId, w.start, w.end)} size={10} />
                          {clock(w.start)}
                        </button>
                      </p>
                    </div>
                    <span className={`due ${due.now ? "now" : ""}`}>{due.text}</span>
                    <button
                      type="button"
                      className="icon-btn sm wb-del"
                      title="从生词本删除"
                      aria-label="从生词本删除"
                      onClick={() => useWords.getState().remove(w.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
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
  useStore.getState().notify(`生词本里有 ${n} 个词等你复习`);
}
