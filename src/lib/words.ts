/**
 * [INPUT]: api.getBlob/setBlob；ts-fsrs
 * [OUTPUT]: useWords、reviewQueue、isMastered、toCsv、Rating、add/update/remove/rate
 * [POS]: 生词本 FSRS 调度；blob key ["learn","words"]
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

interface Book {
  v: 1;
  words: Record<string, Word>;
  day: string;
  newToday: number;
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

interface WordsState extends Book {
  loaded: boolean;
  load(): Promise<void>;
  add(w: Omit<Word, "added" | "card">): void;
  update(id: string, patch: Partial<Word>): void;
  remove(id: string): void;
  rate(id: string, grade: Grade): void;
}

let saveTimer: number | undefined;
function persist() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const { v, words, day, newToday } = useWords.getState();
    void api.setBlob(BLOB[0], BLOB[1], JSON.stringify({ v, words, day, newToday })).catch(() => {});
  }, 300);
}
window.addEventListener("beforeunload", () => {
  if (!saveTimer) return;
  window.clearTimeout(saveTimer);
  const { v, words, day, newToday } = useWords.getState();
  void api.setBlob(BLOB[0], BLOB[1], JSON.stringify({ v, words, day, newToday }));
});

export const useWords = create<WordsState>((set, get) => ({
  v: 1,
  words: {},
  day: today(),
  newToday: 0,
  loaded: false,
  async load() {
    if (get().loaded) return;
    try {
      const raw = await api.getBlob(BLOB[0], BLOB[1]);
      const b = raw ? (JSON.parse(raw) as Book) : null;
      set({
        loaded: true,
        words: b?.words ?? {},
        day: b?.day ?? today(),
        newToday: b?.newToday ?? 0,
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
    set((s) => ({
      words: { ...s.words, [id]: { ...w, card: toSaved(next) } },
      day: d,
      newToday: (s.day === d ? s.newToday : 0) + (wasNew ? 1 : 0),
    }));
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
