/**
 * [INPUT]: 无外部依赖（纯文本模糊匹配）
 * [OUTPUT]: fuzzyScore、filterFuzzy（多词模糊匹配 + 相关性排序）
 * [POS]: 侧边栏订阅区等轻量本地模糊检索
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().trim();
}

const WORD_SEP = /[\s\-_|｜:：/.,，。·、()（）【】[\]「」"'`]/;

function tokenScore(token: string, candidate: string): number {
  const t = normalize(token);
  const c = normalize(candidate);
  if (!t || !c) return -1;
  if (c === t) return 1000;
  if (c.startsWith(t)) return 800 - Math.min(80, (c.length - t.length) * 0.5);

  const subIdx = c.indexOf(t);
  if (subIdx >= 0) {
    const boundary = subIdx === 0 || WORD_SEP.test(c[subIdx - 1]!);
    return 500 + (boundary ? 80 : 0) - Math.min(120, subIdx * 1.2);
  }

  // 子序列模糊匹配（支持首字母缩写与跨词跳字，如 "lfp" → "Lex Fridman Podcast"、"张访" → "张小珺｜商业访谈录"）
  let ti = 0;
  let firstIdx = -1;
  let lastIdx = -1;
  let consecutive = 0;
  let wordStarts = 0;

  for (let ci = 0; ci < c.length && ti < t.length; ci++) {
    if (c[ci] !== t[ti]) continue;
    if (firstIdx < 0) firstIdx = ci;
    if (lastIdx >= 0 && ci === lastIdx + 1) consecutive++;
    if (ci === 0 || WORD_SEP.test(c[ci - 1]!)) wordStarts++;
    lastIdx = ci;
    ti++;
  }

  if (ti < t.length) return -1;
  const span = lastIdx - firstIdx + 1 - t.length;
  return Math.max(1, 200 + consecutive * 18 + wordStarts * 25 - span * 2 - firstIdx * 0.5);
}

/**
 * 计算查询词对一组候选字段的模糊匹配得分（-1 表示未命中，0 表示空查询）。
 * 支持空格分隔的多词 AND 查询、前缀/子串优先、以及首字母/跳字子序列匹配。
 */
export function fuzzyScore(
  query: string,
  candidates: readonly (string | null | undefined)[],
): number {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;

  const fields = candidates.filter((x): x is string => Boolean(x && x.trim()));
  if (!fields.length) return -1;

  let total = 0;
  for (const tok of tokens) {
    let best = -1;
    for (let i = 0; i < fields.length; i++) {
      const s = tokenScore(tok, fields[i]!);
      if (s < 0) continue;
      // 靠前字段（如主标题/展示名）给予轻微加权，优先于作者/链接命中
      const weighted = s + Math.max(0, 12 - i * 4);
      if (weighted > best) best = weighted;
    }
    if (best < 0) return -1;
    total += best;
  }
  return total;
}

/** 对列表按模糊匹配过滤并按相关度降序排列（空查询返回原顺序）。 */
export function filterFuzzy<T>(
  items: readonly T[],
  query: string,
  getFields: (item: T) => readonly (string | null | undefined)[],
): T[] {
  const q = normalize(query);
  if (!q) return [...items];

  const scored: { item: T; score: number; index: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const score = fuzzyScore(q, getFields(item));
    if (score >= 0) scored.push({ item, score, index: i });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((x) => x.item);
}
