/**
 * [INPUT]: feeds.sameFeed；节目标题短名
 * [OUTPUT]: DEEP_PICKS、deepPickFor、alreadySubscribedDeep、shortName
 * [POS]: 原版节目 → 乔木精读入口映射；与 Discover picks 分离
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { sameFeed } from "./feeds";

export interface DeepPick {
  id: string;
  title: string;
  /** 用于匹配原版节目标题的短名。 */
  names: string[];
  input: string;
}

/** 与搜索 curated 同源的精读入口；MVP 不做精读 UI，ShowView 仍可提示订阅精读源。 */
export const DEEP_PICKS: DeepPick[] = [
  { id: "lex", title: "Lex Fridman Podcast", names: ["lex fridman", "lex"], input: "https://lex.qiaomu.ai" },
  { id: "nopriors", title: "No Priors", names: ["no priors"], input: "https://nopriors.qiaomu.ai" },
  { id: "allin", title: "All-In Podcast", names: ["all-in", "all in podcast"], input: "https://allin.qiaomu.ai" },
  { id: "cogrev", title: "The Cognitive Revolution", names: ["cognitive revolution"], input: "https://cogrev.qiaomu.ai" },
  { id: "nexttoken", title: "Next Token｜词元之外", names: ["next token", "词元之外"], input: "https://rss.qiaomu.ai/sources/nexttoken" },
  { id: "bannatie", title: "半拿铁", names: ["半拿铁"], input: "https://rss.qiaomu.ai/sources/bannatie" },
  { id: "latentspace", title: "Latent Space", names: ["latent space"], input: "https://rss.qiaomu.ai/sources/latentspace" },
  { id: "acquired", title: "Acquired", names: ["acquired"], input: "https://rss.qiaomu.ai/sources/podscribe-acquired" },
  { id: "pivot", title: "Pivot", names: ["pivot"], input: "https://rss.qiaomu.ai/sources/podscribe-pivot" },
  {
    id: "freakonomics",
    title: "Freakonomics Radio",
    names: ["freakonomics"],
    input: "https://rss.qiaomu.ai/sources/podscribe-freakonomics-radio",
  },
  {
    id: "iltb",
    title: "Invest Like the Best",
    names: ["invest like the best"],
    input: "https://rss.qiaomu.ai/sources/podscribe-invest-like-the-best",
  },
  {
    id: "doac",
    title: "The Diary Of A CEO",
    names: ["diary of a ceo", "the diary of a ceo"],
    input: "https://rss.qiaomu.ai/sources/podscribe-the-diary-of-a-ceo-with-steven-bartlett",
  },
];

export function shortName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[（(].*$/, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 原版节目是否有对应乔木精读源。 */
export function deepPickFor(showTitle: string): DeepPick | undefined {
  const key = shortName(showTitle);
  if (!key) return undefined;
  return DEEP_PICKS.find((p) => p.names.some((n) => key.includes(n) || n.includes(key)));
}

export function alreadySubscribedDeep(feedUrl: string, shows: { feedUrl: string }[]): boolean {
  return shows.some((s) => sameFeed(s.feedUrl, feedUrl));
}
