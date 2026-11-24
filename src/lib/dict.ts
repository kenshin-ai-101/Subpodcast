/**
 * [INPUT]: fetch /dict/en.json；settings.LearnLevel
 * [OUTPUT]: loadDict / lookup / isNew / WORD_RE / looksEnglish / LEVELS / tagLabel / useDict
 * [POS]: 离线 ECDICT；学英语标词与词卡释义
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { create } from "zustand";
import { tNow } from "./i18n";
import type { LearnLevel } from "./settings";

/** [音标, 释义, tag bits, 词频 rank（0 = 未知）] */
type Raw = [string, string, number, number];
interface Data {
  v: number;
  tags: string[];
  words: Record<string, Raw>;
  forms: Record<string, string>;
}

export interface Entry {
  lemma: string;
  ipa: string;
  meaning: string;
  tags: number;
  rank: number;
}

const TAGS = ["zk", "gk", "cet4", "cet6", "ky", "toefl", "ielts", "gre"] as const;
const bit = (t: (typeof TAGS)[number]) => 1 << TAGS.indexOf(t);

/** 该水平默认已掌握：本级及以下词表。 */
const KNOWN: Record<LearnLevel, number> = {
  cet4: bit("zk") | bit("gk") | bit("cet4"),
  cet6: bit("zk") | bit("gk") | bit("cet4") | bit("cet6"),
  ky: bit("zk") | bit("gk") | bit("cet4") | bit("cet6") | bit("ky"),
  ielts: bit("zk") | bit("gk") | bit("cet4") | bit("cet6") | bit("ky") | bit("toefl") | bit("ielts"),
};
/** 词频低于此 rank 的一律当已知。 */
const KNOWN_RANK: Record<LearnLevel, number> = { cet4: 3000, cet6: 5000, ky: 6000, ielts: 8000 };
/** 无标签词：落在此区间才当生词。 */
const UNTAGGED_FROM: Record<LearnLevel, number> = { cet4: 6000, cet6: 9000, ky: 10000, ielts: 14000 };
const UNTAGGED_TO = 20000;

export const LEVELS: [LearnLevel, string][] = [
  ["cet4", "四级"],
  ["cet6", "六级"],
  ["ky", "考研"],
  ["ielts", "雅思"],
];

const LABELS: [number, string][] = [
  [bit("zk"), "中考"],
  [bit("gk"), "高考"],
  [bit("cet4"), "四级"],
  [bit("cet6"), "六级"],
  [bit("ky"), "考研"],
  [bit("toefl"), "托福"],
  [bit("ielts"), "雅思"],
  [bit("gre"), "GRE"],
];

/** 词所属最易考级标签，无则空串。 */
export function tagLabel(tags: number): string {
  for (const [b, label] of LABELS) if (tags & b) return tNow(label);
  return "";
}

interface DictState {
  data: Data | null;
  loading: boolean;
  failed: boolean;
}
export const useDict = create<DictState>(() => ({ data: null, loading: false, failed: false }));

let pending: Promise<Data | null> | null = null;

/** 词典只拉一次；后续调用共用同一 promise。 */
export function loadDict(): Promise<Data | null> {
  const s = useDict.getState();
  if (s.data) return Promise.resolve(s.data);
  if (pending) return pending;
  useDict.setState({ loading: true, failed: false });
  pending = fetch("/dict/en.json")
    .then((r) => (r.ok ? (r.json() as Promise<Data>) : Promise.reject(new Error(String(r.status)))))
    .then((data) => {
      useDict.setState({ data, loading: false });
      return data;
    })
    .catch(() => {
      pending = null;
      useDict.setState({ loading: false, failed: true });
      return null;
    });
  return pending;
}

/** 归一化后的词头：小写、撇号、屈折折叠。 */
export function lemmaOf(data: Data, token: string): string | null {
  let w = token.toLowerCase().replace(/[’‘]/g, "'").replace(/^'+|'+$/g, "");
  if (w.endsWith("'s")) w = w.slice(0, -2);
  if (data.words[w]) return w;
  const f = data.forms[w];
  if (f && data.words[f]) return f;
  return null;
}

export function lookup(data: Data, token: string): Entry | null {
  const lemma = lemmaOf(data, token);
  if (!lemma) return null;
  const [ipa, meaning, tags, rank] = data.words[lemma];
  return { lemma, ipa, meaning, tags, rank };
}

/** 是否超过听众水平、值得标出。 */
export function isNew(e: Entry, level: LearnLevel): boolean {
  if (e.rank > 0 && e.rank <= KNOWN_RANK[level]) return false;
  if (e.tags) return (e.tags & KNOWN[level]) === 0;
  return e.rank > UNTAGGED_FROM[level] && e.rank <= UNTAGGED_TO;
}

/** 英文行里的词 token 与偏移。 */
export const WORD_RE = /[A-Za-z][A-Za-z'’-]*[A-Za-z]|[A-Za-z]/g;

/** 缺语言码时粗判是否英文稿。 */
export function looksEnglish(language: string | undefined, sample: string): boolean {
  if (language) return /^en\b|^en-|^en$/i.test(language);
  const letters = sample.replace(/[^A-Za-z一-鿿]/g, "");
  return letters.length > 0 && (letters.match(/[A-Za-z]/g)?.length ?? 0) / letters.length > 0.8;
}
