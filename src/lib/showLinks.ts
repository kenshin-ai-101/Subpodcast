/**
 * [INPUT]: picks.PICKS
 * [OUTPUT]: HOME_SHOW_FEED、homeShow、showLinks、subscribeUrl
 * [POS]: 主创节目与站外订阅链接（发现横幅 / 节目页 / 单集订阅条）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { PICKS, type Pick } from "./picks";

export interface ShowLinks {
  youtube?: string;
  bilibili?: string;
}

export const HOME_SHOW_FEED = "https://www.youtube.com/@nexttokentv";
const NEXTTOKEN_YT = "https://www.youtube.com/@nexttokentv";
const NEXTTOKEN_BILI = "https://space.bilibili.com/3745066753461159";

const BY_FEED: Record<string, ShowLinks> = {
  [HOME_SHOW_FEED]: { youtube: NEXTTOKEN_YT, bilibili: NEXTTOKEN_BILI },
  "https://rss.qiaomu.ai/sources/nexttoken": { youtube: NEXTTOKEN_YT, bilibili: NEXTTOKEN_BILI },
  "https://anchor.fm/s/116d068f0/podcast/rss": { youtube: NEXTTOKEN_YT, bilibili: NEXTTOKEN_BILI },
};

/** 按完整 feed URL 或已知片段匹配（小宇宙 / Anchor / 乔木 同源）。 */
export function showLinks(feedUrl?: string): ShowLinks {
  if (!feedUrl) return {};
  if (BY_FEED[feedUrl]) return BY_FEED[feedUrl]!;
  const u = feedUrl.toLowerCase();
  if (
    u.includes("116d068f0")
    || u.includes("6a9956fafbb9512fc83ddbb5")
    || u.includes("nexttokentv")
    || u.includes("sources/nexttoken")
  ) {
    return { youtube: NEXTTOKEN_YT, bilibili: NEXTTOKEN_BILI };
  }
  if (u.includes("lexfridman.com") || u.includes("youtube.com/@lexfridman")) {
    return { youtube: "https://www.youtube.com/@lexfridman" };
  }
  return {};
}

/** 音频订阅也可能有 YouTube 双形态（打开单集时触发一次 refresh 配对 videoId）。 */
export function mayHaveYoutubeTwin(feedUrl?: string, title?: string): boolean {
  if (showLinks(feedUrl).youtube) return true;
  const u = (feedUrl ?? "").toLowerCase();
  const t = (title ?? "").toLowerCase();
  return (
    t.includes("词元之外")
    || t.includes("next token")
    || t.includes("lex fridman")
    || t.includes("dwarkesh")
    || t.includes("huberman")
    || t.includes("joe rogan")
    || u.includes("dwarkesh")
    || u.includes("huberman")
    || u.includes("joerogan")
  );
}

export const homeShow = (): Pick | undefined =>
  PICKS.find((p) => p.input === HOME_SHOW_FEED || p.id === "nexttoken");

export const subscribeUrl = (channel: string) => `${channel}?sub_confirmation=1`;
