# rss.qiaomu.ai integration notes (research, 2026-11-16)

- Server code: `~/Documents/ChatGPT/qiaomu-clipper/integration/qmreader/unified/server.js`
  - `GET https://rss.qiaomu.ai/api/sources` → `{sources:[{id,name,category,siteUrl,description,entryCount,...}]}`; 37 have `category: "podcast"`.
  - `GET /api/entries?source=<id>&limit=N` → entries `{id,title,titleZh,link,published,summary,audio:{url,type}}`.
  - `GET /api/entry/<id>` → full entry incl. `content` (HTML; for `*-zh` sources this is the Chinese 精读 rewrite).
- Chinese deep-read sites (one per show; static, built by e.g. `~/Documents/ChatGPT/lex/tools/build.py`):
  lex, allin, nopriors, cogrev, trainingdata, unsupervised, zhangxiaojun, 42zhangjing, latetalk, crossing, aialchemy, 35huan, zhixing, mianji  (`https://<id>.qiaomu.ai`)
  - `/data/episodes.json` → `{updated, episodes:[{n,t,s(slug),d,y(YouTube id),zh(title),guest,tr(ot|asr|kg),au,r,ds(zh blurb)}]}`
  - `/ep/<slug>/index.md` → Chinese 精读 markdown; `/transcripts/<slug>.txt` → original-language transcript (plain text, header lines first; may lack timestamps).
  - `/feed.xml` → RSS of latest 20 精读 with audio enclosures.
- Plan: a "精选频道" source type in SubCast that reads `episodes.json`, maps each episode to an Episode (audio from the official feed / YouTube id `y`), shows `ds`/`zh` as bilingual title+blurb, adds a 「精读」 tab rendering index.md, and uses transcripts txt as the original transcript (time-spread if untimed).
