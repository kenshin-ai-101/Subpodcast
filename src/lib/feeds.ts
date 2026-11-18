/**
 * [INPUT]: 无外部依赖
 * [OUTPUT]: looksLikeLink、sameFeed — 订阅入口共用判定
 * [POS]: 与 AddDialog / TopBar / ImportPanel 共享的链接与 feed 归一
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const looksLikeLink = (t: string) =>
  /^(https?:\/\/|@)|youtube\.com|youtu\.be|xiaoyuzhoufm\.com|feed\.xyzfm\.space|podcasts\.apple\.com|\.(xml|rss)\b/i.test(
    t.trim(),
  );

const norm = (u: string) =>
  u
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();

export const sameFeed = (a: string, b: string) => norm(a) === norm(b);
