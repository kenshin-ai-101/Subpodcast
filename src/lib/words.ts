/**
 * [INPUT]: api.getBlob/setBlob；ts-fsrs
 * [OUTPUT]: useWords、reviewQueue、isMastered、toCsv、dayOf、DayLog、Rating、add/update/remove/rate/know
 * [POS]: 生词本 FSRS 调度 + 日学习日志；blob key ["learn","words"]
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { create } from "zustand";
import { createEmptyCard, fsrs, Rating, State, type Card, type Grade } from "ts-fsrs";
import { api } from "./api";

export interface SavedCard {
  due: number;
  stability: number;
  difficulty: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: State;
  last_review?: number;
}

export interface Word {
  /** 词头，小写。 */
  id: string;
  /** 句中原形。 */
  word: string;
  ipa: string;
  meaning: string;
  /** 句内义（模型），可选。 */
  ctx?: string;
  /** 最易考级标签（tagLabel）。 */
  tag: string;
  sentence: string;
  sentenceZh?: string;
  episodeId: string;
  episodeTitle: string;
  showTitle?: string;
  start: number;
  end: number;
  added: number;
  card: SavedCard;
}

/** 一日复习：次数、忘了次数、涉及词 id。 */
export interface DayLog {
  r: number;
  a: number;
  ids: string[];
}

interface Book {
  v: 1;
  words: Record<string, Word>;
  day: string;
  newToday: number;
  log?: Record<string, DayLog>;
  /** 听者标为「已认识」的词头 → 时间戳。 */
  known?: Record<string, number>;
}

const BLOB = ["learn", "words"] as const;
const scheduler = fsrs({ enable_fuzz: true });
/** 复习间隔 ≥ 此天数且已进入 Review：算掌握。 */
const MASTERED_DAYS = 21;

const toSaved = (c: Card): SavedCard => ({
  due: +c.due,
  stability: c.stability,
  difficulty: c.difficulty,
  scheduled_days: c.scheduled_days,
  learning_steps: c.learning_steps,
  reps: c.reps,
  lapses: c.lapses,
  state: c.state,
  last_review: c.last_review ? +c.last_review : undefined,
});
const toCard = (s: SavedCard): Card => ({
  ...s,
  due: new Date(s.due),
  last_review: s.last_review ? new Date(s.last_review) : undefined,
});
const today = () => new Date().toLocaleDateString("sv");
export const dayOf = (ms: number) => new Date(ms).toLocaleDateString("sv");

interface WordsState extends Book {
  log: Record<string, DayLog>;
  known: Record<string, number>;
  loaded: boolean;
  load(): Promise<void>;
  add(w: Omit<Word, "added" | "card">): void;
  update(id: string, patch: Partial<Word>): void;
  remove(id: string): void;
  rate(id: string, grade: Grade): void;
  know(ids: string[]): void;
  unknow(id: string): void;
  clearKnown(): void;
}

let saveTimer: number | undefined;
const snapshot = () => {
  const { v, words, day, newToday, log, known } = useWords.getState();
  return JSON.stringify({ v, words, day, newToday, log, known });
};
function persist() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void api.setBlob(BLOB[0], BLOB[1], snapshot()).catch(() => {});
  }, 300);
}
window.addEventListener("beforeunload", () => {
  if (!saveTimer) return;
  window.clearTimeout(saveTimer);
  void api.setBlob(BLOB[0], BLOB[1], snapshot());
});

/** 无 log 的旧本：用各词 last_review 回填日学习记录。 */
function backfill(words: Record<string, Word>): Record<string, DayLog> {
  const log: Record<string, DayLog> = {};
  for (const w of Object.values(words)) {
    if (!w.card.last_review) continue;
    const d = (log[dayOf(w.card.last_review)] ??= { r: 0, a: 0, ids: [] });
    d.r++;
    d.ids.push(w.id);
  }
  return log;
}

export const useWords = create<WordsState>((set, get) => ({
  v: 1,
  words: {},
  day: today(),
  newToday: 0,
  log: {},
  known: {},
  loaded: false,
  async load() {
    if (get().loaded) return;
    try {
      const raw = await api.getBlob(BLOB[0], BLOB[1]);
      const b = raw ? (JSON.parse(raw) as Book) : null;
      const words = b?.words ?? {};
      set({
        loaded: true,
        words,
        day: b?.day ?? today(),
        newToday: b?.newToday ?? 0,
        log: b?.log ?? backfill(words),
        known: b?.known ?? {},
      });
    } catch {
      set({ loaded: true });
    }
  },
  add(w) {
    if (get().words[w.id]) return;
    set((s) => ({
      words: {
        ...s.words,
        [w.id]: { ...w, added: Date.now(), card: toSaved(createEmptyCard(new Date())) },
      },
    }));
    persist();
  },
  know(ids) {
    if (!ids.length) return;
    const now = Date.now();
    set((s) => ({ known: { ...s.known, ...Object.fromEntries(ids.map((id) => [id, now])) } }));
    persist();
  },
  unknow(id) {
    const { [id]: _, ...rest } = get().known;
    set({ known: rest });
    persist();
  },
  clearKnown() {
    set({ known: {} });
    persist();
  },
  update(id, patch) {
    const w = get().words[id];
    if (!w) return;
    set((s) => ({ words: { ...s.words, [id]: { ...w, ...patch } } }));
    persist();
  },
  remove(id) {
    const { [id]: _, ...rest } = get().words;
    set({ words: rest });
    persist();
  },
  rate(id, grade) {
    const w = get().words[id];
    if (!w) return;
    const wasNew = w.card.state === State.New;
    let next: Card;
    try {
      next = scheduler.next(toCard(w.card), new Date(), grade).card;
    } catch {
      next = scheduler.next(createEmptyCard(new Date()), new Date(), grade).card;
    }
    const d = today();
    set((s) => {
      const was = s.log[d] ?? { r: 0, a: 0, ids: [] };
      const entry = {
        r: was.r + 1,
        a: was.a + (grade === Rating.Again ? 1 : 0),
        ids: was.ids.includes(id) ? was.ids : [...was.ids, id],
      };
      return {
        words: { ...s.words, [id]: { ...w, card: toSaved(next) } },
        day: d,
        newToday: (s.day === d ? s.newToday : 0) + (wasNew ? 1 : 0),
        log: { ...s.log, [d]: entry },
      };
    });
    persist();
  },
}));

export const isMastered = (w: Word) =>
  w.card.state === State.Review && w.card.scheduled_days >= MASTERED_DAYS;
export const isDue = (w: Word, now = Date.now()) => w.card.state !== State.New && w.card.due <= now;

/** 今日复习：到期词 + 未达每日上限的新词（先入先学）。 */
export function reviewQueue(
  book: Pick<Book, "words" | "day" | "newToday">,
  dailyNew: number,
  now = Date.now(),
): Word[] {
  const all = Object.values(book.words);
  const due = all.filter((w) => isDue(w, now)).sort((a, b) => a.card.due - b.card.due);
  const left = Math.max(0, dailyNew - (book.day === today() ? book.newToday : 0));
  const fresh = all
    .filter((w) => w.card.state === State.New)
    .sort((a, b) => a.added - b.added)
    .slice(0, left);
  return [...due, ...fresh];
}

/** 各评分按钮对应的下次间隔（ms）。 */
export function intervals(w: Word): Record<Grade, number> {
  let p;
  try {
    p = scheduler.repeat(toCard(w.card), new Date());
  } catch {
    p = scheduler.repeat(createEmptyCard(new Date()), new Date());
  }
  const now = Date.now();
  return {
    [Rating.Again]: +p[Rating.Again].card.due - now,
    [Rating.Hard]: +p[Rating.Hard].card.due - now,
    [Rating.Good]: +p[Rating.Good].card.due - now,
    [Rating.Easy]: +p[Rating.Easy].card.due - now,
  } as Record<Grade, number>;
}

export { Rating, type Grade };

const at = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCsv(words: Word[], header: string[]): string {
  const rows = words.map((w) => [
    w.word,
    w.ipa,
    w.meaning.replace(/\n/g, " "),
    w.ctx ?? "",
    w.sentence,
    w.sentenceZh ?? "",
    w.showTitle ?? "",
    w.episodeTitle,
    at(w.start),
    new Date(w.added).toLocaleDateString("sv"),
  ]);
  return "\uFEFF" + [header, ...rows].map((r) => r.map((c) => csvCell(String(c))).join(",")).join("\n") + "\n";
}
