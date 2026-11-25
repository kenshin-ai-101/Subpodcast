/**
 * [INPUT]: 依赖 net、model、roxmltree；小宇宙页 __NEXT_DATA__；qiaomu 精读源；curated_video；iTunes lookup 单集
 * [OUTPUT]: 解析任意订阅输入为 Show+Episodes（源有多少入多少）；YouTube twin / curated fill + video_duration 预填；search_podcasts=YouTube 频道∪Apple；LIST_EPISODES_CAP
 * [POS]: 订阅归一层——xyz RSS 被 ACL 时走 iTunes≤200 + 精读合并；目录搜索与 SubCast 同序（频道优先）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use crate::curated_video;
use crate::model::{now_ms, short_hash, Episode, Show};
use crate::net;
use crate::qiaomu;
use crate::shared;
use anyhow::{anyhow, Result};
use regex::Regex;
use roxmltree::Document;

/// 列表/预览一次返回上限（入库不截断；侧栏数量走 COUNT(*)）。
pub const LIST_EPISODES_CAP: i64 = 10_000;

#[derive(Clone)]
pub struct Resolved {
    pub show: Show,
    pub episodes: Vec<Episode>,
    /// 目录可能被截断（小宇宙网页 SSR 仅最近十余集）。刷新时只 upsert、不删旧集。
    pub catalog_partial: bool,
    /// curated_video::fill 已权威检查（可清库内陈旧方图 video_id）。
    pub videos_checked: bool,
}

impl Resolved {
    pub fn full(show: Show, episodes: Vec<Episode>) -> Self {
        Self {
            show,
            episodes,
            catalog_partial: false,
            videos_checked: false,
        }
    }

    pub fn partial(show: Show, episodes: Vec<Episode>) -> Self {
        Self {
            show,
            episodes,
            catalog_partial: true,
            videos_checked: false,
        }
    }
}

/// 把用户粘贴的链接或搜索词解析成可订阅源。
pub async fn resolve(input: &str) -> Result<Resolved> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err(anyhow!("请输入链接或播客名"));
    }

    if let Some(id) = qiaomu::rss_source_id(raw) {
        return Ok(attach_curated_videos(qiaomu::rss_channel(&id).await?).await);
    }
    if let Some(id) = qiaomu::site_id(raw) {
        return Ok(attach_curated_videos(qiaomu::channel(&id).await?).await);
    }
    // 词元之外等：优先精读，再用 iTunes/xyz 补目录（精读常是子集）
    if let Some(id) = qiaomu_preferred_source(raw, "") {
        let r = qiaomu::open_curated(id).await?;
        return Ok(attach_curated_videos(expand_thin_catalog(r, raw, "").await).await);
    }

    if let Some(id) = apple_id(raw) {
        let feed = itunes_feed_url(&id).await?;
        return fetch_rss(&feed, "podcast").await;
    }

    if let Some(pid) = xiaoyuzhou_podcast_id(raw) {
        return xiaoyuzhou_show(&pid).await;
    }

    if is_youtube(raw) {
        let channel_id = youtube_channel_id(raw).await?;
        let feed = format!("https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}");
        return fetch_rss(&feed, "youtube").await;
    }

    if raw.starts_with("http://") || raw.starts_with("https://") {
        let kind = if is_xyzfm(raw) { "xiaoyuzhou" } else { "podcast" };
        return fetch_rss(raw, kind).await;
    }

    Err(anyhow!("无法识别：请粘贴 YouTube / Apple Podcasts / 小宇宙 / RSS 链接"))
}

/// 目录搜索：YouTube 频道优先，再拼 Apple Podcasts；任一源失败时仍返回另一源（两边都失败才报错）。
/// 与 SubCast 对齐，供 Discover / MCP `search_podcasts` / `find_show` 共用。
pub async fn search_podcasts(term: &str, country: &str) -> Result<Vec<Show>> {
    let (yt, pods) = tokio::join!(search_youtube_channels(term), search_apple_podcasts(term, country));
    let mut out = Vec::new();
    // 精读目录命中时置顶。
    if let Some((feed, title)) = qiaomu::curated_feed_for_query(term) {
        out.push(Show {
            id: short_hash(&feed, 16),
            kind: "qiaomu".into(),
            title,
            author: Some("乔木精读".into()),
            cover: None,
            feed_url: feed,
            link: None,
            description: Some("乔木精读 · 中文标题与精读长文".into()),
            updated_at: now_ms(),
            episode_count: 0,
        });
    }
    match yt {
        Ok(list) => out.extend(list),
        Err(e) if pods.as_ref().map(|p| p.is_empty()).unwrap_or(true) && out.is_empty() => return Err(e),
        Err(_) => {}
    }
    match pods {
        Ok(list) => {
            for s in list {
                if out.iter().any(|x| x.feed_url == s.feed_url) {
                    continue;
                }
                out.push(s);
            }
        }
        Err(e) if out.is_empty() => return Err(e),
        Err(_) => {}
    }
    Ok(out)
}

async fn search_apple_podcasts(term: &str, country: &str) -> Result<Vec<Show>> {
    let q = urlencoding::encode(term);
    let cc = if country.is_empty() { "US" } else { country };
    let url = format!(
        "https://itunes.apple.com/search?media=podcast&entity=podcast&limit=25&country={cc}&term={q}"
    );
    let body = net::get_text(&url).await?;
    let v: serde_json::Value = serde_json::from_str(&body)?;
    let mut out = Vec::new();
    for item in v["results"].as_array().into_iter().flatten() {
        let feed = item["feedUrl"].as_str().unwrap_or("");
        if feed.is_empty() {
            continue;
        }
        let kind = if is_xyzfm(feed) { "xiaoyuzhou" } else { "podcast" };
        out.push(Show {
            id: short_hash(feed, 16),
            kind: kind.into(),
            title: item["collectionName"].as_str().unwrap_or("Untitled").into(),
            author: item["artistName"].as_str().map(str::to_string),
            cover: item["artworkUrl600"]
                .as_str()
                .or(item["artworkUrl100"].as_str())
                .map(str::to_string),
            feed_url: feed.into(),
            link: item["collectionViewUrl"].as_str().map(str::to_string),
            description: None,
            updated_at: now_ms(),
            episode_count: 0,
        });
    }
    Ok(out)
}

/// YouTube 频道搜索页（频道筛选）里读 ytInitialData，最多 3 条。
async fn search_youtube_channels(term: &str) -> Result<Vec<Show>> {
    const MAX: usize = 3;
    let mut found = Vec::new();
    for attempt in 0..3 {
        let url = format!(
            "https://www.youtube.com/results?search_query={}&sp=EgIQAg%253D%253D",
            urlencoding::encode(term)
        );
        let html = net::get_text(&url).await?;
        if let Some(caps) = Regex::new(r"var ytInitialData = (\{.*?\});</script>")
            .ok()
            .and_then(|re| re.captures(&html))
        {
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&caps[1]) {
                collect_youtube_channels(&data, &mut found, MAX);
            }
        }
        if !found.is_empty() || attempt == 2 {
            break;
        }
    }
    Ok(found)
}

fn collect_youtube_channels(v: &serde_json::Value, out: &mut Vec<Show>, max: usize) {
    if out.len() >= max {
        return;
    }
    match v {
        serde_json::Value::Object(m) => {
            if let Some(c) = m.get("channelRenderer") {
                if let (Some(id), Some(title)) = (c["channelId"].as_str(), c["title"]["simpleText"].as_str()) {
                    if id.starts_with("UC") && id.len() == 24 {
                        let cover = c["thumbnail"]["thumbnails"]
                            .as_array()
                            .and_then(|t| t.last())
                            .and_then(|t| t["url"].as_str())
                            .map(|u| {
                                if u.starts_with("//") {
                                    format!("https:{u}")
                                } else {
                                    u.to_string()
                                }
                            });
                        let handle = c["subscriberCountText"]["simpleText"]
                            .as_str()
                            .filter(|h| h.starts_with('@'))
                            .unwrap_or("YouTube");
                        let feed = format!("https://www.youtube.com/feeds/videos.xml?channel_id={id}");
                        out.push(Show {
                            id: short_hash(&feed, 16),
                            kind: "youtube".into(),
                            title: title.into(),
                            author: Some(handle.into()),
                            cover,
                            feed_url: feed,
                            link: Some(format!("https://www.youtube.com/channel/{id}")),
                            description: Some("YouTube 频道".into()),
                            updated_at: now_ms(),
                            episode_count: 0,
                        });
                    }
                }
                return;
            }
            for x in m.values() {
                collect_youtube_channels(x, out, max);
            }
        }
        serde_json::Value::Array(a) => {
            for x in a {
                collect_youtube_channels(x, out, max);
            }
        }
        _ => {}
    }
}

/// 无标题时的刷新入口；有节目标题时请用 `refresh_with_title`。
#[allow(dead_code)]
pub async fn refresh(feed_url: &str, kind: &str) -> Result<Resolved> {
    refresh_with_title(feed_url, kind, "").await
}

/// 刷新时带上已存节目标题，便于 iTunes / 精读命中（slug 无 hex 时尤其关键）。
pub async fn refresh_with_title(feed_url: &str, kind: &str, title: &str) -> Result<Resolved> {
    if kind == "qiaomu" || qiaomu::site_id(feed_url).is_some() || qiaomu::rss_source_id(feed_url).is_some()
    {
        let mut resolved = if let Some(id) = qiaomu::rss_source_id(feed_url) {
            qiaomu::rss_channel(&id).await?
        } else if let Some(id) = qiaomu::site_id(feed_url) {
            qiaomu::channel(&id).await?
        } else {
            return fetch_rss(feed_url, kind).await;
        };
        // 精读站常是子集：用小宇宙/iTunes 补全目录，保留精读 deep
        resolved = expand_thin_catalog(resolved, feed_url, title).await;
        return Ok(attach_curated_videos(resolved).await);
    }
    // 小宇宙 / xyzfm：RSS∥节目页∥iTunes∥精读，取最完整合并。
    if kind == "xiaoyuzhou" || is_xyzfm(feed_url) {
        if let Some(pid) = xiaoyuzhou_podcast_id(feed_url) {
            return xiaoyuzhou_show(&pid).await;
        }
        // slug 无 hex：标题/slug 走统一富化
        return xyz_slug_or_title(feed_url, title).await;
    }
    fetch_rss(feed_url, kind).await
}

async fn fetch_rss(feed_url: &str, kind_hint: &str) -> Result<Resolved> {
    // feed.xyzfm.space 常被 IP ACL 302 到 200 HTML；改走节目页 / iTunes / 精读。
    if is_xyzfm(feed_url) {
        if let Some(pid) = xiaoyuzhou_podcast_id(feed_url) {
            return xiaoyuzhou_show(&pid).await;
        }
        return xyz_slug_or_title(feed_url, "").await;
    }
    let xml = net::get_text(feed_url).await?;
    if looks_like_html(&xml) {
        return Err(anyhow!(
            "源返回了网页而非 RSS（链接可能已失效或被 CDN 拦截）"
        ));
    }
    let (mut show, episodes) = parse_feed(&xml, feed_url)?;
    if kind_hint == "youtube" || feed_url.contains("youtube.com/feeds") {
        show.kind = "youtube".into();
    } else if kind_hint == "xiaoyuzhou" {
        show.kind = "xiaoyuzhou".into();
    } else if show.kind.is_empty() || show.kind == "podcast" {
        show.kind = kind_hint.into();
    }
    // Apple/Anchor 常滞后于小宇宙；若节目主页挂了小宇宙链接，用其补全单集。
    let resolved = prefer_xiaoyuzhou_if_richer(Resolved::full(show, episodes)).await;
    // 音频播客 ↔ YouTube 双形态：硬编码 twin 或精读 curated fill。
    Ok(attach_all_video_twins(resolved).await)
}

fn parse_feed(xml: &str, feed_url: &str) -> Result<(Show, Vec<Episode>)> {
    // 防御：CDN 403 页常以 <!DOCTYPE 开头，roxmltree 会报 invalid name token at 1:2
    if looks_like_html(xml) {
        return Err(anyhow!("RSS 解析失败: 源返回了网页而非 XML"));
    }
    let doc = Document::parse(xml).map_err(|e| anyhow!("RSS 解析失败: {e}"))?;
    let root = doc.root_element();

    // Atom (YouTube)
    if root.has_tag_name("feed") {
        return parse_atom(&doc, feed_url);
    }

    let channel = root
        .descendants()
        .find(|n| n.has_tag_name("channel"))
        .ok_or_else(|| anyhow!("RSS 缺少 channel"))?;

    let title = text_child(channel, "title").unwrap_or_else(|| "未命名节目".into());
    let show_id = short_hash(feed_url, 16);
    let cover = attr_ns(channel, "image", "href")
        .or_else(|| {
            channel
                .children()
                .find(|n| n.has_tag_name("image"))
                .and_then(|img| text_child(img, "url"))
        });

    let mut episodes = Vec::new();
    for item in channel.children().filter(|n| n.has_tag_name("item")) {
        let guid = text_child(item, "guid")
            .or_else(|| text_child(item, "link"))
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let ep_title = text_child(item, "title").unwrap_or_else(|| "未命名单集".into());
        let enclosure = item.children().find(|n| n.has_tag_name("enclosure"));
        let audio_url = enclosure
            .and_then(|e| e.attribute("url").map(str::to_string))
            .map(|u| shared::canonical_audio_url(&u));
        let (transcript_url, transcript_type) = podcast_transcript(item);
        let link = text_child(item, "link");
        let notes = text_child(item, "description")
            .or_else(|| text_ns(item, "summary"))
            .or_else(|| text_ns(item, "encoded"));
        let video_id = audio_url
            .as_deref()
            .and_then(youtube_id_from_url)
            .or_else(|| link.as_deref().and_then(youtube_id_from_url))
            .or_else(|| notes.as_deref().and_then(youtube_id_from_url));

        episodes.push(Episode {
            id: short_hash(&format!("{show_id}|{guid}"), 20),
            show_id: show_id.clone(),
            guid,
            title: ep_title,
            published: text_child(item, "pubDate").and_then(|d| parse_rfc2822(&d)),
            duration: text_ns(item, "duration").and_then(|d| parse_duration(&d)),
            audio_url,
            video_id,
            link,
            cover: attr_ns(item, "image", "href").or_else(|| cover.clone()),
            notes,
            transcript_url,
            transcript_type,
            deep: false,
            progress: 0.0,
            has_transcript: false,
            show_title: Some(title.clone()),
        });
    }

    let show = Show {
        id: show_id,
        kind: "podcast".into(),
        title,
        author: text_ns(channel, "author").or_else(|| text_child(channel, "managingEditor")),
        cover,
        feed_url: feed_url.into(),
        link: text_child(channel, "link"),
        description: text_child(channel, "description"),
        updated_at: now_ms(),
        episode_count: 0,
    };
    Ok((show, episodes))
}

fn parse_atom(doc: &Document, feed_url: &str) -> Result<(Show, Vec<Episode>)> {
    let feed = doc.root_element();
    let title = text_child(feed, "title").unwrap_or_else(|| "YouTube".into());
    let show_id = short_hash(feed_url, 16);
    let author = feed
        .children()
        .find(|n| n.has_tag_name("author"))
        .and_then(|a| text_child(a, "name"));
    let mut episodes = Vec::new();
    for entry in feed.children().filter(|n| n.has_tag_name("entry")) {
        let video_id = entry
            .children()
            .find(|n| n.has_tag_name("videoId"))
            .and_then(|n| n.text().map(str::to_string))
            .or_else(|| {
                entry
                    .children()
                    .find(|n| n.has_tag_name("id"))
                    .and_then(|n| n.text())
                    .and_then(|id| id.rsplit(':').next().map(str::to_string))
            });
        let guid = video_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let ep_title = text_child(entry, "title").unwrap_or_else(|| "视频".into());
        let published = text_child(entry, "published")
            .or_else(|| text_child(entry, "updated"))
            .and_then(|d| chrono::DateTime::parse_from_rfc3339(&d).ok().map(|t| t.timestamp()));
        let link = entry
            .children()
            .find(|n| n.has_tag_name("link") && n.attribute("rel") != Some("self"))
            .and_then(|n| n.attribute("href").map(str::to_string));
        let cover = video_id
            .as_ref()
            .map(|id| format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"));

        episodes.push(Episode {
            id: short_hash(&format!("{show_id}|{guid}"), 20),
            show_id: show_id.clone(),
            guid,
            title: ep_title,
            published,
            duration: None,
            audio_url: None,
            video_id,
            link,
            cover,
            notes: text_child(entry, "media:description").or_else(|| text_child(entry, "content")),
            transcript_url: None,
            transcript_type: None,
            deep: false,
            progress: 0.0,
            has_transcript: false,
            show_title: Some(title.clone()),
        });
    }
    let show = Show {
        id: show_id,
        kind: "youtube".into(),
        title,
        author,
        cover: episodes.first().and_then(|e| e.cover.clone()),
        feed_url: feed_url.into(),
        link: None,
        description: None,
        updated_at: now_ms(),
        episode_count: 0,
    };
    Ok((show, episodes))
}

async fn xiaoyuzhou_show(pid: &str) -> Result<Resolved> {
    let page = format!("https://www.xiaoyuzhoufm.com/podcast/{pid}");
    // RSS（全量）与节目页并行；ACL 时不耽误 SSR。
    let (rss, page_res) = tokio::join!(xyz_rss_resolved(pid, &page), net::get_text(&page));
    if let Some(r) = rss {
        return Ok(attach_all_video_twins(enrich_xyz_catalog(r, pid).await).await);
    }

    let html = page_res?;
    if let Ok(r) = xiaoyuzhou_from_next_data(&html, &page) {
        if !r.episodes.is_empty() {
            return Ok(attach_all_video_twins(enrich_xyz_catalog(r, pid).await).await);
        }
    }
    // 页面空壳：仍可用 iTunes / 精读
    let title = Regex::new(r"<title>([^<]+)</title>")
        .ok()
        .and_then(|re| re.captures(&html))
        .map(|c| c[1].replace(" - 小宇宙", "").trim().to_string())
        .unwrap_or_else(|| "小宇宙节目".into());
    let shell = Resolved::partial(
        Show {
            id: short_hash(&page, 16),
            kind: "xiaoyuzhou".into(),
            title: title.clone(),
            author: None,
            cover: None,
            feed_url: page.clone(),
            link: Some(page),
            description: None,
            updated_at: now_ms(),
            episode_count: 0,
        },
        vec![],
    );
    Ok(attach_all_video_twins(enrich_xyz_catalog(shell, pid).await).await)
}

/// slug 版 xyz（无 hex）或仅有标题：iTunes 单集目录 + 精读合并。
async fn xyz_slug_or_title(feed_url: &str, title: &str) -> Result<Resolved> {
    let slug = xyzfm_slug(feed_url).unwrap_or_default();
    let curated_id = qiaomu_preferred_source(feed_url, title)
        .or_else(|| qiaomu_preferred_source(&slug, title));
    let curated = match curated_id {
        Some(id) => qiaomu::open_curated(id).await.ok(),
        None => None,
    };
    let title_hint = if !title.is_empty() {
        title.to_string()
    } else {
        curated
            .as_ref()
            .map(|c| c.show.title.clone())
            .unwrap_or_default()
    };
    let itunes = if title_hint.is_empty() {
        None
    } else {
        itunes_episode_catalog(&title_hint, feed_url).await
    };
    // 旧路径：iTunes 给出的另一条 slug RSS（出口不同时偶通）
    let slug_rss = if itunes.is_none() && !title_hint.is_empty() {
        xyz_itunes_slug_rss(&title_hint, feed_url).await
    } else {
        None
    };

    let mut resolved = match (itunes.or(slug_rss), curated) {
        (Some(base), Some(c)) => merge_enrichment(base, c),
        (Some(base), None) => base,
        (None, Some(c)) => c,
        (None, None) => {
            return Err(anyhow!(
                "小宇宙 RSS 暂时无法访问，请改用节目主页链接（xiaoyuzhoufm.com/podcast/…）或确认网络"
            ));
        }
    };
    if let Some(pid) = resolved
        .episodes
        .iter()
        .find_map(|e| e.audio_url.as_deref().and_then(xiaoyuzhou_podcast_id))
    {
        resolved.show.feed_url = format!("https://www.xiaoyuzhoufm.com/podcast/{pid}");
        resolved.show.link = Some(resolved.show.feed_url.clone());
        resolved.show.kind = "xiaoyuzhou".into();
    }
    Ok(attach_all_video_twins(resolved).await)
}

/// SSR/RSS 半量时：iTunes≤200 单集 + 乔木精读合并；catalog_partial 如实标记。
async fn enrich_xyz_catalog(mut base: Resolved, pid: &str) -> Resolved {
    let title = base.show.title.clone();
    let page = base.show.feed_url.clone();
    let need_more = base.catalog_partial
        || base.episodes.is_empty()
        || (base.show.episode_count > 0
            && (base.episodes.len() as i64) < base.show.episode_count);

    if need_more {
        if let Some(itunes) = itunes_episode_catalog(&title, &page).await {
            base = merge_enrichment(base, itunes);
        } else if let Some(slug_rss) = xyz_itunes_slug_rss(&title, &page).await {
            base = merge_enrichment(base, slug_rss);
        }
    }

    if let Some(id) = qiaomu_preferred_source(&format!("podcast/{pid}"), &title)
        .or_else(|| qiaomu_preferred_source(pid, &title))
    {
        if let Ok(curated) = qiaomu::open_curated(id).await {
            base = merge_enrichment(base, curated);
        }
    }

    let declared = base.show.episode_count.max(base.episodes.len() as i64);
    base.show.episode_count = declared;
    base.catalog_partial = declared > base.episodes.len() as i64;
    base
}

/// 精读子集 → 用 iTunes / 音频里的 xyz pid 补目录，保留 deep 与精读订阅身份。
async fn expand_thin_catalog(mut curated: Resolved, feed_url: &str, title: &str) -> Resolved {
    let keep = curated.show.clone();
    let t = if title.is_empty() {
        keep.title.as_str()
    } else {
        title
    };
    if let Some(itunes) = itunes_episode_catalog(t, feed_url).await {
        if itunes.episodes.len() > curated.episodes.len() {
            curated = merge_enrichment(itunes, curated);
        }
    }
    if let Some(pid) = curated
        .episodes
        .iter()
        .find_map(|e| e.audio_url.as_deref().and_then(xiaoyuzhou_podcast_id))
    {
        // 仅 SSR/RSS，避免再进 enrich 递归打精读
        let page = format!("https://www.xiaoyuzhoufm.com/podcast/{pid}");
        if let Some(rss) = xyz_rss_resolved(&pid, &page).await {
            if rss.episodes.len() > curated.episodes.len() {
                curated = merge_enrichment(rss, curated);
            }
        } else if let Ok(html) = net::get_text(&page).await {
            if let Ok(ssr) = xiaoyuzhou_from_next_data(&html, &page) {
                if let Some(itunes) = itunes_episode_catalog(&ssr.show.title, &page).await {
                    curated = merge_enrichment(itunes, curated);
                } else if ssr.episodes.len() > curated.episodes.len() {
                    curated = merge_enrichment(ssr, curated);
                } else {
                    curated.show.episode_count = curated
                        .show
                        .episode_count
                        .max(ssr.show.episode_count)
                        .max(curated.episodes.len() as i64);
                }
            }
        }
    }
    // 目录可以变大，但 kind/feed 仍指精读站，下次刷新还走 channel/rss_channel
    curated.show.kind = keep.kind;
    curated.show.feed_url = keep.feed_url;
    curated.show.link = keep.link.or(curated.show.link);
    curated.show.author = keep.author.or(curated.show.author);
    curated.show.title = keep.title;
    let n = curated.episodes.len() as i64;
    curated.show.episode_count = curated.show.episode_count.max(n);
    curated.catalog_partial = curated.show.episode_count > n;
    curated
}

/// 以 richer 为目录底座，把 enrichment 的 deep / video / 精读笔记叠上去；按 guid 与标题键对齐。
fn merge_enrichment(richer: Resolved, enrichment: Resolved) -> Resolved {
    use std::collections::HashMap;
    let declared = richer
        .show
        .episode_count
        .max(enrichment.show.episode_count)
        .max(richer.episodes.len() as i64)
        .max(enrichment.episodes.len() as i64);
    let mut by_guid: HashMap<String, Episode> = HashMap::new();
    let mut by_key: HashMap<String, String> = HashMap::new();
    for e in richer.episodes {
        by_key.insert(episode_dedupe_key(&e.title), e.guid.clone());
        by_guid.insert(e.guid.clone(), e);
    }
    for e in enrichment.episodes {
        let guid = if by_guid.contains_key(&e.guid) {
            e.guid.clone()
        } else if let Some(g) = by_key.get(&episode_dedupe_key(&e.title)) {
            g.clone()
        } else {
            e.guid.clone()
        };
        match by_guid.get_mut(&guid) {
            Some(old) => {
                if e.deep {
                    old.deep = true;
                    if e.notes.is_some() {
                        old.notes = e.notes.clone();
                    }
                    if e.link.is_some() {
                        old.link = e.link.clone();
                    }
                    if e.transcript_type.is_some() {
                        old.transcript_type = e.transcript_type.clone();
                        old.transcript_url = e.transcript_url.clone();
                    }
                }
                if old.audio_url.is_none() {
                    old.audio_url = e.audio_url.clone();
                }
                if old.video_id.as_ref().map(|s| s.is_empty()).unwrap_or(true) {
                    old.video_id = e.video_id.clone();
                }
                if old.cover.is_none() {
                    old.cover = e.cover.clone();
                }
            }
            None => {
                by_key.insert(episode_dedupe_key(&e.title), guid.clone());
                by_guid.insert(guid, e);
            }
        }
    }
    let mut episodes: Vec<_> = by_guid.into_values().collect();
    episodes.sort_by(|a, b| b.published.cmp(&a.published));
    let mut show = richer.show;
    if show.cover.is_none() {
        show.cover = enrichment.show.cover;
    }
    if show.description.is_none() {
        show.description = enrichment.show.description;
    }
    // 精读源保留 kind=qiaomu；小宇宙底座保持 xiaoyuzhou
    if enrichment.show.kind == "qiaomu" && show.kind == "qiaomu" {
        show.kind = "qiaomu".into();
        show.author = enrichment.show.author.or(show.author);
    }
    show.episode_count = declared;
    let partial = declared > episodes.len() as i64;
    if partial {
        Resolved::partial(show, episodes)
    } else {
        Resolved::full(show, episodes)
    }
}

/// feed.xyzfm.space/{pid}；ACL 常回 200 HTML，设置无代理时再试系统/环境代理。
async fn xyz_rss_resolved(pid: &str, page: &str) -> Option<Resolved> {
    let feed = format!("https://feed.xyzfm.space/{pid}");
    xyz_fetch_rss_url(&feed, page).await
}

async fn xyz_fetch_rss_url(feed: &str, page: &str) -> Option<Resolved> {
    if let Ok(xml) = net::get_text(feed).await {
        if let Some(r) = xyz_parse_rss_body(feed, page, &xml).await {
            return Some(r);
        }
    }
    if net::proxy().is_empty() {
        let p = net::effective_proxy();
        if !p.is_empty() {
            if let Ok(xml) = net::get_text_via_proxy(feed, &p).await {
                if let Some(r) = xyz_parse_rss_body(feed, page, &xml).await {
                    return Some(r);
                }
            }
        }
    }
    None
}

async fn xyz_parse_rss_body(feed: &str, page: &str, xml: &str) -> Option<Resolved> {
    if looks_like_html(xml) {
        return None;
    }
    let (mut show, episodes) = parse_feed(xml, feed).ok()?;
    if episodes.is_empty() {
        return None;
    }
    show.kind = "xiaoyuzhou".into();
    show.feed_url = page.into();
    show.link = Some(page.into());
    show.episode_count = episodes.len() as i64;
    Some(Resolved::full(show, episodes))
}

/// iTunes 常挂 slug 版 xyz RSS（如 feed.xyzfm.space/cv4bkgpuglwp）；ACL 出口不同时或可通。
async fn xyz_itunes_slug_rss(title: &str, page: &str) -> Option<Resolved> {
    let item = itunes_search_match(title, page).await?;
    let feed = item["feedUrl"].as_str()?;
    if !is_xyzfm(feed) || xiaoyuzhou_podcast_id(feed).is_some() {
        return None;
    }
    xyz_fetch_rss_url(feed, page).await
}

/// iTunes lookup 单集（最多 200）：xyz RSS 被 ACL 时的主目录来源；带可播 episodeUrl。
async fn itunes_episode_catalog(title: &str, feed_hint: &str) -> Option<Resolved> {
    let item = itunes_search_match(title, feed_hint).await?;
    let cid = item["collectionId"].as_i64().or_else(|| {
        item["collectionId"]
            .as_str()
            .and_then(|s| s.parse().ok())
    })?;
    let track_count = item["trackCount"].as_i64().unwrap_or(0);
    let feed = item["feedUrl"].as_str().unwrap_or(feed_hint).to_string();
    let show_title = item["collectionName"]
        .as_str()
        .unwrap_or(title)
        .to_string();
    let author = item["artistName"].as_str().map(str::to_string);
    let cover = item["artworkUrl600"]
        .as_str()
        .or_else(|| item["artworkUrl100"].as_str())
        .map(str::to_string);

    let url = format!(
        "https://itunes.apple.com/lookup?id={cid}&entity=podcastEpisode&limit=200&country=CN"
    );
    let body = net::get_text(&url).await.ok()?;
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    let show_id = short_hash(&feed, 16);
    let mut episodes = Vec::new();
    for e in v["results"].as_array().into_iter().flatten() {
        let kind = e["kind"].as_str().unwrap_or("");
        if kind != "podcast-episode" {
            continue;
        }
        let audio = e["episodeUrl"]
            .as_str()
            .or_else(|| e["previewUrl"].as_str())
            .filter(|u| !u.is_empty())
            .map(shared::canonical_audio_url);
        let Some(raw_guid) = e["episodeGuid"]
            .as_str()
            .map(str::to_string)
            .filter(|g| !g.is_empty())
            .or_else(|| e["trackId"].as_i64().map(|id| id.to_string()))
        else {
            continue;
        };
        // xyz guid 偶带 .html；与精读 / SSR eid 对齐
        let guid = raw_guid
            .strip_suffix(".html")
            .or_else(|| raw_guid.strip_suffix(".htm"))
            .unwrap_or(&raw_guid)
            .to_string();
        let title = e["trackName"].as_str().unwrap_or("未命名单集").to_string();
        let published = e["releaseDate"].as_str().and_then(parse_any_date);
        let duration = e["trackTimeMillis"].as_f64().map(|ms| ms / 1000.0);
        let link = e["trackViewUrl"].as_str().map(str::to_string);
        let ep_cover = e["artworkUrl600"]
            .as_str()
            .or_else(|| e["artworkUrl160"].as_str())
            .map(str::to_string);
        let notes = e["description"]
            .as_str()
            .or_else(|| e["shortDescription"].as_str())
            .map(str::to_string);
        episodes.push(Episode {
            id: short_hash(&format!("{show_id}|{guid}"), 20),
            show_id: show_id.clone(),
            guid,
            title,
            published,
            duration,
            audio_url: audio,
            video_id: None,
            link,
            cover: ep_cover,
            notes,
            transcript_url: None,
            transcript_type: None,
            deep: false,
            progress: 0.0,
            has_transcript: false,
            show_title: Some(show_title.clone()),
        });
    }
    if episodes.is_empty() {
        return None;
    }
    episodes.sort_by(|a, b| b.published.cmp(&a.published));
    let declared = track_count.max(episodes.len() as i64);
    let show = Show {
        id: show_id,
        kind: if is_xyzfm(&feed) {
            "xiaoyuzhou".into()
        } else {
            "podcast".into()
        },
        title: show_title,
        author,
        cover,
        feed_url: feed.clone(),
        link: Some(feed),
        description: None,
        updated_at: now_ms(),
        episode_count: declared,
    };
    Some(if declared > episodes.len() as i64 {
        Resolved::partial(show, episodes)
    } else {
        Resolved::full(show, episodes)
    })
}

/// 按标题搜 iTunes，优先 feed 与 hint 对得上的小宇宙源。
async fn itunes_search_match(title: &str, feed_hint: &str) -> Option<serde_json::Value> {
    let t = title.trim();
    if t.is_empty() {
        return None;
    }
    let q = urlencoding::encode(t);
    let url = format!(
        "https://itunes.apple.com/search?media=podcast&entity=podcast&limit=8&country=CN&term={q}"
    );
    let body = net::get_text(&url).await.ok()?;
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    let hint = feed_hint.to_lowercase();
    let hint_slug = xyzfm_slug(feed_hint).unwrap_or_default().to_lowercase();
    let hint_pid = xiaoyuzhou_podcast_id(feed_hint).unwrap_or_default();
    let mut fallback_xyz = None;
    let mut fallback_title = None;
    let norm_t: String = t
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase();
    for item in v["results"].as_array().into_iter().flatten() {
        let feed = item["feedUrl"].as_str().unwrap_or("").to_lowercase();
        let name = item["collectionName"].as_str().unwrap_or("");
        let name_n: String = name
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()
            .to_lowercase();
        if !feed.is_empty() {
            if (!hint.is_empty() && (feed == hint || hint.contains(&feed) || feed.contains(&hint)))
                || (!hint_slug.is_empty() && feed.contains(&hint_slug))
                || (!hint_pid.is_empty() && feed.contains(&hint_pid))
            {
                return Some(item.clone());
            }
            if is_xyzfm(&feed) && fallback_xyz.is_none() && (name_n.contains(&norm_t) || norm_t.contains(&name_n) || name_n == norm_t) {
                fallback_xyz = Some(item.clone());
            }
        }
        if fallback_title.is_none()
            && !norm_t.is_empty()
            && (name_n == norm_t || name_n.starts_with(&norm_t) || norm_t.starts_with(&name_n))
        {
            fallback_title = Some(item.clone());
        }
    }
    fallback_xyz.or(fallback_title)
}

fn xiaoyuzhou_from_next_data(html: &str, page: &str) -> Result<Resolved> {
    let caps = Regex::new(r#"(?s)<script id="__NEXT_DATA__"[^>]*>(.*?)</script>"#)
        .ok()
        .and_then(|re| re.captures(html))
        .ok_or_else(|| anyhow!("小宇宙页面无 __NEXT_DATA__"))?;
    let v: serde_json::Value = serde_json::from_str(&caps[1])?;
    let p = &v["props"]["pageProps"]["podcast"];
    let pid = p["pid"].as_str().ok_or_else(|| anyhow!("小宇宙节目缺少 pid"))?;
    let feed_url = format!("https://www.xiaoyuzhoufm.com/podcast/{pid}");
    let show_id = short_hash(&feed_url, 16);
    let episodes = p["episodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| xyz_episode(e, &show_id))
        .collect::<Vec<_>>();
    let declared = p["episodeCount"].as_i64().unwrap_or(episodes.len() as i64);
    let partial = declared > episodes.len() as i64;
    let show = Show {
        id: show_id,
        kind: "xiaoyuzhou".into(),
        title: p["title"].as_str().unwrap_or("小宇宙节目").into(),
        author: p["author"].as_str().map(str::to_string),
        cover: p["image"]["middlePicUrl"]
            .as_str()
            .or_else(|| p["image"]["picUrl"].as_str())
            .map(str::to_string),
        feed_url: feed_url.clone(),
        link: Some(page.into()),
        description: p["description"].as_str().map(str::to_string),
        updated_at: now_ms(),
        episode_count: declared,
    };
    Ok(if partial {
        Resolved::partial(show, episodes)
    } else {
        Resolved::full(show, episodes)
    })
}

fn xyz_episode(e: &serde_json::Value, show_id: &str) -> Option<Episode> {
    let eid = e["eid"].as_str()?;
    let audio = e["enclosure"]["url"]
        .as_str()
        .or_else(|| e["media"]["source"]["url"].as_str())
        .map(shared::canonical_audio_url);
    Some(Episode {
        id: short_hash(&format!("{show_id}|{eid}"), 20),
        show_id: show_id.into(),
        guid: eid.into(),
        title: e["title"].as_str().unwrap_or("未命名单集").into(),
        published: e["pubDate"]
            .as_str()
            .and_then(parse_any_date)
            .or_else(|| {
                e["pubDate"].as_i64().map(|n| {
                    if n > 10_000_000_000 {
                        n / 1000
                    } else {
                        n
                    }
                })
            }),
        duration: e["duration"].as_f64(),
        audio_url: audio,
        video_id: None,
        link: Some(format!("https://www.xiaoyuzhoufm.com/episode/{eid}")),
        cover: e["image"]["picUrl"].as_str().map(str::to_string),
        notes: e["shownotes"]
            .as_str()
            .or_else(|| e["description"].as_str())
            .map(str::to_string),
        transcript_url: None,
        transcript_type: None,
        deep: false,
        progress: 0.0,
        has_transcript: false,
        show_title: e["podcast"]["title"].as_str().map(str::to_string),
    })
}

/// Apple/Anchor 分发常慢一拍；节目站若挂了小宇宙，以其为更完整目录。
async fn prefer_xiaoyuzhou_if_richer(mut resolved: Resolved) -> Resolved {
    if resolved.show.kind == "youtube" || resolved.show.kind == "xiaoyuzhou" {
        return resolved;
    }
    let Some(pid) = discover_xiaoyuzhou_pid(&resolved).await else {
        return resolved;
    };
    let Ok(xyz) = xiaoyuzhou_show(&pid).await else {
        return resolved;
    };
    if xyz.episodes.is_empty() {
        return resolved;
    }
    let show_id = resolved.show.id.clone();
    let rss_n = resolved.episodes.len();
    let xyz_n = xyz.episodes.len();
    if xyz_n < rss_n {
        return resolved;
    }
    let mut merged = merge_episodes(resolved.episodes, xyz.episodes);
    rebind_episodes(&mut merged, &show_id);
    resolved.episodes = merged;
    resolved.catalog_partial = xyz.catalog_partial;
    resolved.show.kind = "xiaoyuzhou".into();
    resolved.show.feed_url = format!("https://www.xiaoyuzhoufm.com/podcast/{pid}");
    resolved.show.link = Some(resolved.show.feed_url.clone());
    resolved.show.episode_count = xyz.show.episode_count.max(resolved.episodes.len() as i64);
    if resolved.show.cover.is_none() {
        resolved.show.cover = xyz.show.cover;
    }
    if resolved.show.description.is_none() {
        resolved.show.description = xyz.show.description;
    }
    resolved
}

async fn discover_xiaoyuzhou_pid(resolved: &Resolved) -> Option<String> {
    for blob in [
        resolved.show.description.as_deref(),
        resolved.show.link.as_deref(),
        Some(resolved.show.feed_url.as_str()),
    ]
    .into_iter()
    .flatten()
    {
        // 描述/链接里的显式节目 URL 才可信；整页 HTML 另走 preferred_xyz_pid
        if blob.len() < 500 {
            if let Some(pid) = xiaoyuzhou_podcast_id(blob) {
                return Some(pid);
            }
        }
    }
    let link = resolved.show.link.as_deref()?;
    if !(link.starts_with("http://") || link.starts_with("https://")) {
        return None;
    }
    if link.contains("anchor.fm")
        || link.contains("podcasts.apple.com")
        || link.contains("spotify.com")
        || is_xyzfm(link)
    {
        return None;
    }
    // 站点根路径常夹带主持人个人节目；/weekly 订阅区更干净
    if let Some(weekly) = site_weekly_url(link) {
        if let Ok(html) = net::get_text(&weekly).await {
            if let Some(pid) = preferred_xyz_pid(&html) {
                return Some(pid);
            }
        }
    }
    let html = net::get_text(link).await.ok()?;
    preferred_xyz_pid(&html)
}

fn site_weekly_url(link: &str) -> Option<String> {
    let u = reqwest::Url::parse(link).ok()?;
    let path = u.path().trim_end_matches('/');
    if path.is_empty() || path == "/" {
        return Some(format!("{}://{}/weekly", u.scheme(), u.host_str()?));
    }
    None
}

/// 优先 data-listen-platform=xiaoyuzhou；否则仅当页面只出现一个节目 pid。
fn preferred_xyz_pid(html: &str) -> Option<String> {
    if let Some(pid) = Regex::new(
        r#"data-listen-platform="xiaoyuzhou"[^>]*href="[^"]*?/podcast/([a-f0-9]+)""#,
    )
    .ok()
    .and_then(|re| re.captures(html))
    .map(|c| c[1].to_string())
    {
        return Some(pid);
    }
    let mut uniq = std::collections::BTreeSet::new();
    if let Some(re) = Regex::new(r"xiaoyuzhoufm\.com/podcast/([a-f0-9]+)").ok() {
        for c in re.captures_iter(html) {
            uniq.insert(c[1].to_string());
        }
    }
    if uniq.len() == 1 {
        return uniq.into_iter().next();
    }
    None
}

/// 同一期的稳定键（#010 / EP010 / 第10期 → `#10`）；跨源合并与库内去重共用。
pub fn episode_dedupe_key(title: &str) -> String {
    static EP_NUM_RE: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
        Regex::new(r"(?i)(?:^|[\s\[\(【（|·\-—:])(?:#|ep\.?|第)\s*0*(\d+)(?:[\s\]\)】）|·\-—:：期]|$)")
            .expect("ep num regex")
    });
    // #010 / EP010 / Ep 10 / 第10期 → 同一期；要求词边界，避免误匹配 Deep 1 / Step 1
    if let Some(c) = EP_NUM_RE.captures(title) {
        return format!("#{}", &c[1]);
    }
    title
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase()
}

/// 已知节目：小宇宙 SSR 只有约 15 集，切乔木精读拿全量（guid 对齐 xyz eid）。
pub fn qiaomu_preferred_source(feed_or_input: &str, title: &str) -> Option<&'static str> {
    let u = feed_or_input.to_lowercase();
    let t = title.to_lowercase();
    // (id, 路径/pid/slug 标记…)
    const MARKERS: &[(&str, &[&str])] = &[
        (
            "nexttoken",
            &[
                "116d068f0",
                "6a9956fafbb9512fc83ddbb5",
                "nexttokentv",
                "sources/nexttoken",
                "词元之外",
                "next token",
            ],
        ),
        (
            "zhangxiaojun",
            &[
                "626b46ea9cbbf0451cf5a962",
                "dk4yh3pkpjp3",
                "zhangxiaojun",
                "张小珺",
            ],
        ),
        (
            "latetalk",
            &["latetalk", "晚点聊"],
        ),
        (
            "zhixing",
            &[
                "zhixing",
                "知行小酒馆",
                "j8yp8gxkmgqr",
                "6013f9f58e2f7ee375cf4216",
            ],
        ),
        ("42zhangjing", &["42zhangjing", "42章经"]),
        ("crossing", &["十字路口crossing", "十字路口"]),
        ("aialchemy", &["aialchemy", "ai炼金术"]),
        ("35huan", &["35huan", "三五环"]),
        ("mianji", &["mianji", "面基"]),
        ("bannatie", &["bannatie", "半拿铁"]),
    ];
    for (id, keys) in MARKERS {
        if keys.iter().any(|k| u.contains(k) || t.contains(k)) {
            return Some(*id);
        }
    }
    None
}

/// `https://feed.xyzfm.space/dk4yh3pkpjp3` → `dk4yh3pkpjp3`（非 hex 短链）。
fn xyzfm_slug(url: &str) -> Option<String> {
    let cap = Regex::new(r"feed\.xyzfm\.space/([A-Za-z0-9_-]+)")
        .ok()?
        .captures(url)?;
    let slug = cap[1].to_string();
    // 24 位 hex 已由 xiaoyuzhou_podcast_id 处理
    if slug.len() == 24 && slug.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(slug)
}

/// 先硬编码 twin，再对精读源做 curated 宽屏配对。
async fn attach_all_video_twins(resolved: Resolved) -> Resolved {
    let after = attach_youtube_twins(resolved).await;
    let mut after = attach_curated_videos(after).await;
    // twin / curated 挂上 video_id 后补时长（Atom 常无；≤15s best-effort）
    crate::video_duration::prefill_missing(&mut after.episodes, None).await;
    after
}

/// 精读源：方图过滤 + 邻集 16:9 + audio_only；权威检查后置 `videos_checked`。
async fn attach_curated_videos(mut resolved: Resolved) -> Resolved {
    let source = qiaomu::rss_source_id(&resolved.show.feed_url)
        .or_else(|| qiaomu::site_id(&resolved.show.feed_url))
        .or_else(|| {
            qiaomu_preferred_source(&resolved.show.feed_url, &resolved.show.title)
                .map(|s| s.to_string())
        });
    let Some(source) = source else {
        return resolved;
    };
    if curated_video::is_audio_only(&source) {
        for ep in &mut resolved.episodes {
            ep.video_id = None;
        }
        resolved.videos_checked = true;
        return resolved;
    }
    let checked =
        curated_video::fill(&source, &resolved.show.title, &mut resolved.episodes).await;
    resolved.videos_checked = checked;
    resolved
}

/// 音频源常无 videoId；对照 YouTube 频道按期号/标题配对，单集页才能切「视频/仅音频」。
fn youtube_twin_handle(feed_url: &str, title: &str) -> Option<&'static str> {
    let u = feed_url.to_lowercase();
    let t = title.to_lowercase();
    if qiaomu_preferred_source(feed_url, title) == Some("nexttoken")
        || u.contains("116d068f0")
        || u.contains("6a9956fafbb9512fc83ddbb5")
        || u.contains("nexttokentv")
        || u.contains("rss.qiaomu.ai/sources/nexttoken")
        || t.contains("词元之外")
        || t.contains("next token")
    {
        return Some("https://www.youtube.com/@nexttokentv");
    }
    if u.contains("lexfridman.com/feed") || t.contains("lex fridman") {
        return Some("https://www.youtube.com/@lexfridman");
    }
    if u.contains("dwarkesh") || t.contains("dwarkesh") {
        return Some("https://www.youtube.com/@DwarkeshPatel");
    }
    if t.contains("huberman lab") || u.contains("huberman") {
        return Some("https://www.youtube.com/@hubermanlab");
    }
    if t.contains("joe rogan") || u.contains("joerogan") {
        return Some("https://www.youtube.com/@joerogan");
    }
    None
}

async fn attach_youtube_twins(mut resolved: Resolved) -> Resolved {
    if resolved.show.kind == "youtube" {
        return resolved;
    }
    let have = resolved
        .episodes
        .iter()
        .filter(|e| e.video_id.as_ref().is_some_and(|v| !v.is_empty()))
        .count();
    if have * 2 >= resolved.episodes.len().max(1) {
        return resolved;
    }
    let Some(handle) = youtube_twin_handle(&resolved.show.feed_url, &resolved.show.title) else {
        return resolved;
    };
    let Ok(channel_id) = youtube_channel_id(handle).await else {
        return resolved;
    };
    let yt_feed = format!("https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}");
    let Ok(xml) = net::get_text(&yt_feed).await else {
        return resolved;
    };
    let Ok((_, yt_eps)) = parse_feed(&xml, &yt_feed) else {
        return resolved;
    };
    use std::collections::HashMap;
    let mut by_key: HashMap<String, String> = HashMap::new();
    for e in yt_eps {
        let Some(vid) = e.video_id.filter(|v| !v.is_empty()) else {
            continue;
        };
        by_key.entry(episode_dedupe_key(&e.title)).or_insert(vid);
    }
    for ep in &mut resolved.episodes {
        if ep.video_id.as_ref().is_some_and(|v| !v.is_empty()) {
            continue;
        }
        let key = episode_dedupe_key(&ep.title);
        if let Some(vid) = by_key.get(&key) {
            ep.video_id = Some(vid.clone());
            // 列表统一用 16:9 封面，避免方图被拉扁后显得乱
            ep.cover = Some(format!("https://i.ytimg.com/vi/{vid}/hqdefault.jpg"));
        }
    }
    resolved
}

/// 开集补救：库里尚无 videoId 时，按节目标题与 YouTube 频道配对一期。
pub async fn fill_youtube_twin(ep: &Episode, feed_url: &str, show_title: &str) -> Option<String> {
    if ep.video_id.as_ref().is_some_and(|v| !v.is_empty()) {
        return ep.video_id.clone();
    }
    // 精读源走 curated 打分 + 宽屏过滤（单集切片）
    if let Some(source) = qiaomu::rss_source_id(feed_url)
        .or_else(|| qiaomu::site_id(feed_url))
        .or_else(|| qiaomu_preferred_source(feed_url, show_title).map(|s| s.to_string()))
    {
        if curated_video::is_audio_only(&source) {
            return None;
        }
        let mut one = [ep.clone()];
        let _ = curated_video::fill(&source, show_title, &mut one).await;
        return one[0]
            .video_id
            .clone()
            .filter(|v| !v.is_empty());
    }
    let handle = youtube_twin_handle(feed_url, show_title)
        .or_else(|| youtube_twin_handle(feed_url, &ep.title))?;
    let channel_id = youtube_channel_id(handle).await.ok()?;
    let yt_feed = format!("https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}");
    let xml = net::get_text(&yt_feed).await.ok()?;
    let (_, yt_eps) = parse_feed(&xml, &yt_feed).ok()?;
    let key = episode_dedupe_key(&ep.title);
    yt_eps.into_iter().find_map(|e| {
        (episode_dedupe_key(&e.title) == key)
            .then_some(e.video_id)
            .flatten()
            .filter(|v| !v.is_empty())
    })
}

fn merge_episodes(rss: Vec<Episode>, xyz: Vec<Episode>) -> Vec<Episode> {
    use std::collections::HashMap;
    let mut map: HashMap<String, Episode> = HashMap::new();
    for e in rss {
        map.insert(episode_dedupe_key(&e.title), e);
    }
    for e in xyz {
        let k = episode_dedupe_key(&e.title);
        match map.get_mut(&k) {
            Some(old) => {
                // 小宇宙通常更新更快且带音频；保留已有精读 / 视频标记
                let progress = old.progress;
                let deep = old.deep;
                let video = old.video_id.clone();
                let notes = old.notes.clone();
                let tr_t = old.transcript_type.clone();
                let tr_u = old.transcript_url.clone();
                let link = old.link.clone();
                if e.audio_url.is_some() {
                    *old = e;
                } else if old.audio_url.is_none() {
                    *old = e;
                }
                old.progress = progress;
                old.deep = deep || old.deep;
                if old.video_id.as_ref().map(|s| s.is_empty()).unwrap_or(true) {
                    old.video_id = video;
                }
                if old.notes.is_none() {
                    old.notes = notes;
                }
                if old.transcript_type.is_none() {
                    old.transcript_type = tr_t;
                    old.transcript_url = tr_u;
                }
                if old.link.is_none() {
                    old.link = link;
                }
            }
            None => {
                map.insert(k, e);
            }
        }
    }
    let mut out: Vec<_> = map.into_values().collect();
    out.sort_by(|a, b| b.published.cmp(&a.published));
    out
}

pub fn rebind_episodes(eps: &mut [Episode], show_id: &str) {
    for e in eps {
        e.show_id = show_id.to_string();
        e.id = short_hash(&format!("{show_id}|{}", e.guid), 20);
    }
}

async fn itunes_feed_url(id: &str) -> Result<String> {
    let url = format!("https://itunes.apple.com/lookup?id={id}&entity=podcast");
    let body = net::get_text(&url).await?;
    let v: serde_json::Value = serde_json::from_str(&body)?;
    v["results"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|r| r["feedUrl"].as_str())
        .map(str::to_string)
        .ok_or_else(|| anyhow!("找不到 Apple Podcasts 的 RSS"))
}

async fn youtube_channel_id(input: &str) -> Result<String> {
    static RE_UC: once_cell::sync::Lazy<Regex> =
        once_cell::sync::Lazy::new(|| Regex::new(r"UC[\w-]{22}").unwrap());
    if let Some(c) = RE_UC.find(input) {
        return Ok(c.as_str().to_string());
    }
    let url = if input.starts_with("http") {
        input.to_string()
    } else if input.starts_with('@') {
        format!("https://www.youtube.com/{input}")
    } else {
        format!("https://www.youtube.com/@{input}")
    };
    let html = net::get_text(&url).await?;
    // 页面里会混入推荐频道的 UC…，优先元数据里的本频道 ID
    for pat in [
        r#""externalId":"(UC[\w-]{22})""#,
        r#""channelId":"(UC[\w-]{22})""#,
        r#"youtube\.com/channel/(UC[\w-]{22})"#,
        r#"channel_id=(UC[\w-]{22})"#,
    ] {
        if let Some(id) = Regex::new(pat)
            .ok()
            .and_then(|re| re.captures(&html))
            .map(|c| c[1].to_string())
        {
            return Ok(id);
        }
    }
    RE_UC
        .find(&html)
        .map(|m| m.as_str().to_string())
        .ok_or_else(|| anyhow!("无法解析 YouTube 频道 ID"))
}

fn apple_id(s: &str) -> Option<String> {
    let trimmed = s.trim();
    if trimmed.chars().all(|c| c.is_ascii_digit()) && trimmed.len() >= 6 {
        return Some(trimmed.to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    if !lower.contains("podcasts.apple.com") && !lower.contains("itunes.apple.com") {
        return None;
    }
    static APPLE_ID_RE: once_cell::sync::Lazy<Regex> =
        once_cell::sync::Lazy::new(|| Regex::new(r"id(\d{6,})").expect("apple id regex"));
    APPLE_ID_RE.captures(trimmed).map(|c| c[1].to_string())
}

/// 从节目页 / 音频 CDN / xyz RSS 等文本里抠 24 位 hex 节目 id。
pub fn xiaoyuzhou_podcast_id(s: &str) -> Option<String> {
    const PATS: &[&str] = &[
        r"xiaoyuzhoufm\.com/podcast/([a-f0-9]{24})",
        r"feed\.xyzfm\.space/([a-f0-9]{24})",
        r"dts-api\.xiaoyuzhoufm\.com/track/([a-f0-9]{24})",
        r"media\.xyzcdn\.net/([a-f0-9]{24})/",
        r"/podcast/([a-f0-9]{24})",
    ];
    for pat in PATS {
        if let Some(id) = Regex::new(pat)
            .ok()
            .and_then(|re| re.captures(s))
            .map(|c| c[1].to_string())
        {
            return Some(id);
        }
    }
    None
}

fn looks_like_html(body: &str) -> bool {
    let t = body.trim_start_matches('\u{feff}').trim_start();
    let head: String = t.chars().take(64).collect::<String>().to_ascii_lowercase();
    head.starts_with("<!doctype")
        || head.starts_with("<html")
        || head.starts_with("<head")
        || head.starts_with("<body")
}

fn is_youtube(s: &str) -> bool {
    s.contains("youtube.com") || s.contains("youtu.be") || s.starts_with('@')
}

pub fn is_xyzfm(s: &str) -> bool {
    s.contains("feed.xyzfm.space") || s.contains("xyzfm.space/")
}

pub fn youtube_id_from_url_pub(url: &str) -> Option<String> {
    youtube_id_from_url(url)
}

fn youtube_id_from_url(url: &str) -> Option<String> {
    Regex::new(r"(?:v=|youtu\.be/|shorts/)([\w-]{11})")
        .ok()?
        .captures(url)
        .map(|c| c[1].to_string())
}

fn podcast_transcript(item: roxmltree::Node) -> (Option<String>, Option<String>) {
    for n in item.descendants() {
        if n.tag_name().name() == "transcript" {
            let url = n.attribute("url").map(str::to_string);
            let kind = n.attribute("type").map(str::to_string);
            if url.is_some() {
                return (url, kind);
            }
        }
    }
    (None, None)
}

fn text_child(node: roxmltree::Node, name: &str) -> Option<String> {
    node.children()
        .find(|n| n.has_tag_name(name))
        .and_then(node_text)
}

fn node_text(n: roxmltree::Node) -> Option<String> {
    if let Some(t) = n.text() {
        let s = t.trim();
        return (!s.is_empty()).then(|| s.to_string());
    }
    let mut acc = String::new();
    for c in n.children() {
        if let Some(t) = c.text() {
            acc.push_str(t);
        }
    }
    let s = acc.trim();
    (!s.is_empty()).then(|| s.to_string())
}

fn text_ns(node: roxmltree::Node, local: &str) -> Option<String> {
    node.descendants()
        .find(|n| n.tag_name().name() == local && n.is_element())
        .and_then(node_text)
}

fn attr_ns(node: roxmltree::Node, local: &str, attr: &str) -> Option<String> {
    node.descendants()
        .find(|n| n.tag_name().name() == local)
        .and_then(|n| n.attribute(attr).map(str::to_string))
}

fn parse_duration(s: &str) -> Option<f64> {
    let parts: Vec<f64> = s
        .split(':')
        .map(|p| p.trim().parse().ok())
        .collect::<Option<Vec<_>>>()?;
    match parts.as_slice() {
        [h, m, sec] => Some(h * 3600.0 + m * 60.0 + sec),
        [m, sec] => Some(m * 60.0 + sec),
        [sec] => Some(*sec),
        _ => None,
    }
}

fn parse_rfc2822(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc2822(s)
        .ok()
        .map(|t| t.timestamp())
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(s, "%a, %d %b %Y %H:%M:%S %Z")
                .ok()
                .map(|t| t.and_utc().timestamp())
        })
}

fn parse_any_date(s: &str) -> Option<i64> {
    parse_rfc2822(s).or_else(|| {
        chrono::DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|t| t.timestamp())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youtube_channel_results_from_yt_initial_data() {
        let data: serde_json::Value = serde_json::from_str(
            r#"{"contents":[{"itemSectionRenderer":{"contents":[
            {"channelRenderer":{"channelId":"UC33VP_gIBzCVcEvaGKBocZA","title":{"simpleText":"罗永浩的十字路口"},"subscriberCountText":{"simpleText":"@罗永浩的十字路口"},"thumbnail":{"thumbnails":[{"url":"//yt3.ggpht.com/a=s88"},{"url":"//yt3.ggpht.com/a=s176"}]}}},
            {"channelRenderer":{"channelId":"UC3Ilesza14SKQBwCTCmhj4w","title":{"simpleText":"二号"},"thumbnail":{"thumbnails":[]}}},
            {"channelRenderer":{"channelId":"UCvtFgYy1WF1sJvgcAAj1VIw","title":{"simpleText":"三号"}}},
            {"channelRenderer":{"channelId":"UCA6enTYxSFdTtUsHFZOFmZg","title":{"simpleText":"四号"}}}]}}]}"#,
        )
        .unwrap();
        let mut out = Vec::new();
        collect_youtube_channels(&data, &mut out, 3);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].kind, "youtube");
        assert_eq!(out[0].author.as_deref(), Some("@罗永浩的十字路口"));
        assert!(out[0].feed_url.contains("channel_id=UC33VP_gIBzCVcEvaGKBocZA"));
        assert!(out[0].cover.as_deref().unwrap().starts_with("https://"));
    }

    #[test]
    fn parse_basic_rss() {
        let xml = r#"<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
            xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>Demo</title>
            <item><title>Ep1</title><guid>g1</guid>
            <enclosure url="https://a.com/a.mp3" type="audio/mpeg"/>
            <podcast:transcript url="https://a.com/t.vtt" type="text/vtt"/>
            </item></channel></rss>"#;
        let (show, eps) = parse_feed(xml, "https://a.com/feed.xml").unwrap();
        assert_eq!(show.title, "Demo");
        assert_eq!(eps.len(), 1);
        assert_eq!(eps[0].transcript_type.as_deref(), Some("text/vtt"));
    }

    #[test]
    fn prefers_platform_xyz_pid() {
        let html = r#"<a href="https://www.xiaoyuzhoufm.com/podcast/aaaaaaaaaaaaaaaaaaaaaaaa">x</a>
            <a data-listen-platform="xiaoyuzhou" href="https://www.xiaoyuzhoufm.com/podcast/6a9956fafbb9512fc83ddbb5">小宇宙</a>"#;
        assert_eq!(
            preferred_xyz_pid(html).as_deref(),
            Some("6a9956fafbb9512fc83ddbb5")
        );
    }

    #[test]
    fn next_data_marks_partial_when_count_exceeds_list() {
        let html = r#"<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"podcast":{
            "pid":"5e4ee557418a84a0466737b7","title":"忽左忽右","episodeCount":657,
            "episodes":[{"eid":"aaaaaaaaaaaaaaaaaaaaaaaa","title":"一集",
              "enclosure":{"url":"https://media.xyzcdn.net/5e4ee557418a84a0466737b7/x.m4a"}}]
        }}}}</script>"#;
        let r = xiaoyuzhou_from_next_data(html, "https://www.xiaoyuzhoufm.com/podcast/5e4ee557418a84a0466737b7")
            .unwrap();
        assert!(r.catalog_partial);
        assert_eq!(r.show.episode_count, 657);
        assert_eq!(r.episodes.len(), 1);
    }

    #[test]
    fn xiaoyuzhou_pid_from_audio_and_feeds() {
        assert_eq!(
            xiaoyuzhou_podcast_id(
                "https://dts-api.xiaoyuzhoufm.com/track/626b46ea9cbbf0451cf5a962/6afd12c6a4a79edf137afd61/media.xyzcdn.net/x.m4a"
            )
            .as_deref(),
            Some("626b46ea9cbbf0451cf5a962")
        );
        assert_eq!(
            xiaoyuzhou_podcast_id("https://feed.xyzfm.space/626b46ea9cbbf0451cf5a962").as_deref(),
            Some("626b46ea9cbbf0451cf5a962")
        );
        assert!(xiaoyuzhou_podcast_id("https://feed.xyzfm.space/dk4yh3pkpjp3").is_none());
        assert!(looks_like_html("<!DOCTYPE html><html>403</html>"));
        assert!(looks_like_html(
            "\u{feff}<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\"><html>"
        ));
        assert!(!looks_like_html(r#"<?xml version="1.0"?><rss><channel/>"#));
        let err = parse_feed(
            "<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\"><html><title>403</title></html>",
            "https://feed.xyzfm.space/626b46ea9cbbf0451cf5a962",
        )
        .unwrap_err()
        .to_string();
        assert!(
            err.contains("网页而非 XML") || err.contains("网页而非 RSS"),
            "got: {err}"
        );
        assert!(!err.contains("invalid name token"));
    }

    #[test]
    #[ignore = "需要网络：xyzfm ACL 下仍能经节目页拉到忽左忽右"]
    fn live_xyzfm_falls_back_to_page() {
        // 不用词元之外：会被 qiaomu_preferred_source 切走乔木源
        let r = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_rss(
                "https://feed.xyzfm.space/5e4ee557418a84a0466737b7",
                "xiaoyuzhou",
            ))
            .expect("xyzfm → page");
        assert_eq!(r.show.kind, "xiaoyuzhou");
        assert!(
            !r.episodes.is_empty(),
            "expected episodes from __NEXT_DATA__, got 0"
        );
        assert!(
            r.show.feed_url.contains("xiaoyuzhoufm.com/podcast/"),
            "feed_url should be page, got {}",
            r.show.feed_url
        );
    }

    #[test]
    #[ignore = "需要网络：验证 Anchor 滞后源经小宇宙补全到 ≥10 期"]
    fn live_next_token_enrich() {
        let r = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(fetch_rss(
                "https://anchor.fm/s/116d068f0/podcast/rss",
                "podcast",
            ))
            .expect("fetch");
        eprintln!(
            "kind={} feed={} n={}",
            r.show.kind,
            r.show.feed_url,
            r.episodes.len()
        );
        for e in r.episodes.iter().take(3) {
            eprintln!(
                "- {} audio={} video={:?}",
                e.title,
                e.audio_url.is_some(),
                e.video_id
            );
        }
        assert!(
            r.episodes.len() >= 10,
            "expected ≥10 after 小宇宙 enrich, got {}",
            r.episodes.len()
        );
        assert!(r.episodes.iter().any(|e| e.title.contains("#010")));
        let with_vid = r
            .episodes
            .iter()
            .filter(|e| e.video_id.as_ref().is_some_and(|v| !v.is_empty()))
            .count();
        assert!(
            with_vid >= 3,
            "expected YouTube twin videoId on Next Token, got {with_vid}"
        );
    }

    #[test]
    fn twin_handle_for_next_token() {
        assert!(youtube_twin_handle("https://anchor.fm/s/116d068f0/podcast/rss", "x").is_some());
        assert!(youtube_twin_handle("https://x.com/feed", "Next Token｜词元之外").is_some());
        assert!(youtube_twin_handle("https://lexfridman.com/feed/podcast/", "Lex").is_some());
        assert_eq!(
            qiaomu_preferred_source("https://anchor.fm/s/116d068f0/podcast/rss", ""),
            Some("nexttoken")
        );
        assert_eq!(
            qiaomu_preferred_source("https://www.xiaoyuzhoufm.com/podcast/6a9956fafbb9512fc83ddbb5", ""),
            Some("nexttoken")
        );
        assert_eq!(
            qiaomu_preferred_source("https://feed.xyzfm.space/dk4yh3pkpjp3", ""),
            Some("zhangxiaojun")
        );
        assert_eq!(
            qiaomu_preferred_source("", "张小珺Jùn｜商业访谈录"),
            Some("zhangxiaojun")
        );
        assert_eq!(
            xyzfm_slug("https://feed.xyzfm.space/dk4yh3pkpjp3").as_deref(),
            Some("dk4yh3pkpjp3")
        );
        assert!(xyzfm_slug("https://feed.xyzfm.space/626b46ea9cbbf0451cf5a962").is_none());
    }

    #[tokio::test]
    #[ignore = "需要网络：xyz slug 经 iTunes 拉满张小珺"]
    async fn live_zhang_slug_itunes_full() {
        let r = refresh_with_title(
            "https://feed.xyzfm.space/dk4yh3pkpjp3",
            "xiaoyuzhou",
            "张小珺Jùn｜商业访谈录",
        )
        .await
        .expect("refresh");
        eprintln!("zhang n={} partial={}", r.episodes.len(), r.catalog_partial);
        assert!(
            r.episodes.len() >= 150,
            "expected ≥150 via iTunes/精读, got {}",
            r.episodes.len()
        );
        assert!(r.episodes.iter().any(|e| e.audio_url.is_some()));
    }

    #[tokio::test]
    #[ignore = "需要网络：知行精读子集经 iTunes 扩到约 200"]
    async fn live_zhixing_expand_via_itunes() {
        let r = refresh_with_title("https://zhixing.qiaomu.ai/", "qiaomu", "知行小酒馆")
            .await
            .expect("refresh");
        eprintln!(
            "zhixing n={} declared={} partial={}",
            r.episodes.len(),
            r.show.episode_count,
            r.catalog_partial
        );
        assert!(
            r.episodes.len() >= 100,
            "expected iTunes expand ≥100, got {}",
            r.episodes.len()
        );
    }

    #[test]
    fn merge_enrichment_keeps_deep_and_grows_catalog() {
        let base = Resolved::partial(
            Show {
                id: "s".into(),
                kind: "xiaoyuzhou".into(),
                title: "T".into(),
                author: None,
                cover: None,
                feed_url: "https://www.xiaoyuzhoufm.com/podcast/abc".into(),
                link: None,
                description: None,
                updated_at: 0,
                episode_count: 100,
            },
            vec![Episode {
                guid: "e1".into(),
                title: "#1 a".into(),
                audio_url: Some("https://a/1.m4a".into()),
                ..Default::default()
            }],
        );
        let enrich = Resolved::full(
            Show {
                id: "q".into(),
                kind: "qiaomu".into(),
                title: "T".into(),
                author: Some("乔木精读".into()),
                cover: None,
                feed_url: "https://t.qiaomu.ai/".into(),
                link: None,
                description: None,
                updated_at: 0,
                episode_count: 2,
            },
            vec![
                Episode {
                    guid: "e1".into(),
                    title: "#1 a".into(),
                    deep: true,
                    notes: Some("精读".into()),
                    ..Default::default()
                },
                Episode {
                    guid: "e2".into(),
                    title: "#2 b".into(),
                    audio_url: Some("https://a/2.m4a".into()),
                    deep: true,
                    ..Default::default()
                },
            ],
        );
        let m = merge_enrichment(base, enrich);
        assert_eq!(m.episodes.len(), 2);
        let e1 = m.episodes.iter().find(|e| e.guid == "e1").unwrap();
        assert!(e1.deep);
        assert_eq!(e1.notes.as_deref(), Some("精读"));
        assert!(e1.audio_url.is_some());
        assert!(m.catalog_partial);
        assert_eq!(m.show.episode_count, 100);
    }

    #[test]
    fn dedupe_key_strips_leading_zeros() {
        assert_eq!(episode_dedupe_key("#010 黄仁勋"), episode_dedupe_key("#10 hello"));
        assert_eq!(episode_dedupe_key("#010 黄仁勋"), episode_dedupe_key("EP010 黄仁勋辞职"));
        assert_eq!(episode_dedupe_key("Ep 9 foo"), episode_dedupe_key("#009 bar"));
    }

    #[test]
    fn merge_keeps_newer_episode_numbers() {
        let rss = vec![Episode {
            guid: "a".into(),
            title: "#009 old".into(),
            ..Default::default()
        }];
        let xyz = vec![
            Episode {
                guid: "b".into(),
                title: "#010 new".into(),
                audio_url: Some("https://a/x.mp3".into()),
                ..Default::default()
            },
            Episode {
                guid: "c".into(),
                title: "#009 better".into(),
                audio_url: Some("https://a/y.mp3".into()),
                ..Default::default()
            },
        ];
        let m = merge_episodes(rss, xyz);
        assert_eq!(m.len(), 2);
        assert!(m.iter().any(|e| e.title.contains("#010")));
        assert!(m.iter().any(|e| e.title.contains("better") && e.audio_url.is_some()));
    }

    #[test]
    fn twin_handle_does_not_hijack_other_qiaomu_shows() {
        assert_eq!(
            youtube_twin_handle("https://rss.qiaomu.ai/sources/nexttoken", "词元之外"),
            Some("https://www.youtube.com/@nexttokentv")
        );
        assert_eq!(
            youtube_twin_handle("https://rss.qiaomu.ai/sources/zhangxiaojun", "张小珺商业访谈录"),
            None
        );
        assert_eq!(
            youtube_twin_handle("https://rss.qiaomu.ai/sources/latetalk", "晚点聊"),
            None
        );
    }

    #[test]
    fn dedupe_key_ignores_embedded_ep_words() {
        assert_eq!(episode_dedupe_key("#009 hello"), "#9");
        assert_eq!(episode_dedupe_key("EP010 访谈"), "#10");
        assert_eq!(episode_dedupe_key("第 12 期 对话"), "#12");
        assert_ne!(episode_dedupe_key("Deep 1: Scaling"), "#1");
        assert_ne!(episode_dedupe_key("Step 1 to AGI"), "#1");
        assert_ne!(episode_dedupe_key("Sleep 2 hours"), "#2");
        assert_ne!(
            episode_dedupe_key("Deep 1: Scaling"),
            episode_dedupe_key("Step 1 to AGI")
        );
    }

    #[test]
    fn apple_id_requires_apple_domain_or_digits() {
        assert_eq!(
            apple_id("https://podcasts.apple.com/us/podcast/lex/id1434243584"),
            Some("1434243584".into())
        );
        assert_eq!(apple_id("1434243584"), Some("1434243584".into()));
        assert_eq!(apple_id("https://example.com/feed/id1234567.xml"), None);
    }
}
