/**
 * [INPUT]: api.Show/Episode、picks
 * [OUTPUT]: recommend — 按话题重合度排序未订阅精选
 * [POS]: 首页侧栏「为你推荐」
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { Episode, Show } from "./api";
import { PICKS, isSubscribed, type Pick, type Topic } from "./picks";

export interface Recommendation {
  pick: Pick;
  because?: string;
}

const shortName = (t: string) => t.split(/[|｜:：]/)[0]!.trim().toLowerCase();

function pickFor(title: string, feedUrl?: string): Pick | undefined {
  const s = shortName(title);
  return PICKS.find(
    (p) =>
      (feedUrl &&
        p.input.toLowerCase().includes(feedUrl.toLowerCase().replace(/^https?:\/\//, ""))) ||
      p.title === title ||
      shortName(p.title) === s ||
      p.by === title ||
      p.channel === title,
  );
}

export function recommend(
  o: { shows: Show[]; recent: Episode[]; favorites: Episode[] },
  limit = 8,
): Recommendation[] {
  const weight = new Map<string, number>();
  const add = (title: string | undefined | null, w: number) => {
    if (title) weight.set(title, (weight.get(title) ?? 0) + w);
  };
  o.shows.forEach((s) => add(s.title, 1));
  o.recent.filter((e) => e.progress > 60).slice(0, 30).forEach((e) => add(e.showTitle, 2));
  o.favorites.forEach((e) => add(e.showTitle, 2));

  const topics = new Map<Topic, number>();
  const sources: { title: string; w: number; topics: Topic[] }[] = [];
  for (const [title, w] of weight) {
    const p = pickFor(title, o.shows.find((s) => s.title === title)?.feedUrl);
    if (!p) continue;
    sources.push({ title, w, topics: p.topics });
    for (const tp of p.topics) topics.set(tp, (topics.get(tp) ?? 0) + w);
  }

  const candidates = PICKS.filter((p) => !isSubscribed(p, o.shows));
  if (!topics.size) return candidates.slice(0, limit).map((pick) => ({ pick }));

  const used = new Map<string, number>();
  return candidates
    .map((pick) => ({
      pick,
      score: pick.topics.reduce((n, tp) => n + (topics.get(tp) ?? 0), 0),
    }))
    .filter((r) => r.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ pick }) => {
      const because = sources
        .map((src) => ({ src, shared: src.topics.filter((tp) => pick.topics.includes(tp)).length }))
        .filter((x) => x.shared > 0)
        .sort(
          (a, b) =>
            b.shared - a.shared ||
            (used.get(a.src.title) ?? 0) - (used.get(b.src.title) ?? 0) ||
            b.src.w - a.src.w,
        )[0]?.src.title;
      if (because) used.set(because, (used.get(because) ?? 0) + 1);
      return { pick, because };
    });
}