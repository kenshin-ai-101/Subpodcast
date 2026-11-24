# rss.qiaomu.ai 接入协议说明

本文件记录 Subpodcast 接入 `rss.qiaomu.ai` 与 `*.qiaomu.ai` 精读站的公开接口约定（实现见 `src-tauri/src/qiaomu.rs`）。

## 1. RSS / 改写聚合接口（`https://rss.qiaomu.ai`）

- `GET /api/sources`：返回源列表 `{ sources: [{ id, name, category, siteUrl, description, entryCount, ... }] }`。
- `GET /api/entries?source=<id>&limit=N`：分页返回条目 `{ id, title, titleZh, link, published, summary, audio: { url, type }, rewriteReady }`。
- `GET /api/entry/<id>`：返回单集详情，含 `rewrite.bodyHtml`（中文精读 HTML，前端渲染前必须经 DOMPurify 清洗）。

## 2. 单节目静态精读站（`https://<id>.qiaomu.ai`）

- 支持站点：`lex`、`allin`、`nopriors`、`cogrev`、`trainingdata`、`unsupervised`、`zhangxiaojun`、`42zhangjing`、`latetalk`、`crossing`、`aialchemy`、`35huan`、`zhixing`、`mianji`。
- `/data/episodes.json`：`{ updated, episodes: [{ n, t, s(slug), d, y(YouTube id), zh(title), guest, tr, au, r, ds }] }`。
- `/ep/<slug>/index.md`：中文精读 Markdown；`/transcripts/<slug>.txt`：原语言文稿。
- `/feed.xml`：最新 20 期含音频 enclosure 的 RSS。
