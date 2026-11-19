/**
 * [INPUT]: 依赖 net、model、roxmltree；小宇宙页 __NEXT_DATA__；qiaomu 精读源
 * [OUTPUT]: 解析任意订阅输入为 Show+Episodes；YouTube twin 回填；iTunes 搜索
 * [POS]: 订阅归一层——YT / Apple / 小宇宙 / RSS 全部变成同一模型；词元之类双形态开集即可官方字幕
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use crate::model::{now_ms, short_hash, Episode, Show};
use crate::net;
use crate::qiaomu;
use crate::shared;
use anyhow::{anyhow, Result};
use regex::Regex;
use roxmltree::Document;

/// 与 SubCast 对齐：单档最多保留最近 300 期。
pub const MAX_EPISODES: usize = qiaomu::MAX_EPISODES;

pub struct Resolved {
    pub show: Show,
    pub episodes: Vec<Episode>,
}

/// 把用户粘贴的链接或搜索词解析成可订阅源。
pub async fn resolve(input: &str) -> Result<Resolved> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err(anyhow!("请输入链接或播客名"));
    }

    if let Some(id) = qiaomu::rss_source_id(raw) {
        return qiaomu::rss_channel(&id).await;
    }
    if let Some(id) = qiaomu::site_id(raw) {
        return qiaomu::channel(&id).await;
    }
    // 词元之外：Anchor / 小宇宙入口统一切乔木源（带 videoId，开集直接官方字幕）
    if let Some(id) = qiaomu_preferred_source(raw, "") {
        return qiaomu::rss_channel(id).await;
    }

    if let Some(id) = apple_id(raw) {
        let feed = itunes_feed_url(&id).await?;
        return fetch_rss(&feed, "podcast").await;
    }

    if let Some(pid) = xiaoyuzhou_podcast_id(raw) {
        if let Some(id) = qiaomu_preferred_source(&format!("podcast/{pid}"), "") {
            return qiaomu::rss_channel(id).await;
        }
        return xiaoyuzhou_show(&pid).await;
    }

    if is_youtube(raw) {
        let channel_id = youtube_channel_id(raw).await?;
        let feed = format!("https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}");
        return fetch_rss(&feed, "youtube").await;
    }

    if raw.starts_with("http://") || raw.starts_with("https://") {
        if let Some(id) = qiaomu_preferred_source(raw, "") {
            return qiaomu::rss_channel(id).await;
        }
        let kind = if is_xyzfm(raw) { "xiaoyuzhou" } else { "podcast" };
        return fetch_rss(raw, kind).await;
    }

    Err(anyhow!("无法识别：请粘贴 YouTube / Apple Podcasts / 小宇宙 / RSS 链接"))
}

pub async fn search_podcasts(term: &str, country: &str) -> Result<Vec<Show>> {
    let q = urlencoding::encode(term);
    let cc = if country.is_empty() { "US" } else { country };
    let url = format!(
        "https://itunes.apple.com/search?media=podcast&entity=podcast&limit=25&country={cc}&term={q}"
    );
    let body = net::get_text(&url).await?;
    let v: serde_json::Value = serde_json::from_str(&body)?;
    let mut out = Vec::new();
    // 精读目录命中时置顶（SubCast Discover 默认走乔木精读，而非 iTunes 英文原版）。
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
    for item in v["results"].as_array().into_iter().flatten() {
        let feed = item["feedUrl"].as_str().unwrap_or("");
        if feed.is_empty() {
            continue;
        }
        if out.iter().any(|s| s.feed_url == feed) {
            continue;
        }
        let kind = if is_xyzfm(feed) { "xiaoyuzhou" } else { "podcast" };
        out.push(Show {
            id: short_hash(feed, 16),
            kind: kind.into(),
            title: item["collectionName"].as_str().unwrap_or("Untitled").into(),
            author: item["artistName"].as_str().map(str::to_string),
            cover: item["artworkUrl600"].as_str().or(item["artworkUrl100"].as_str()).map(str::to_string),
            feed_url: feed.into(),
            link: item["collectionViewUrl"].as_str().map(str::to_string),
            description: None,
            updated_at: now_ms(),
            episode_count: 0,
        });
    }
    Ok(out)
}

pub async fn refresh(feed_url: &str, kind: &str) -> Result<Resolved> {
    if kind == "qiaomu" || qiaomu::site_id(feed_url).is_some() || qiaomu::rss_source_id(feed_url).is_some()
    {
        if let Some(id) = qiaomu::rss_source_id(feed_url) {
            return qiaomu::rss_channel(&id).await;
        }
        if let Some(id) = qiaomu::site_id(feed_url) {
            return qiaomu::channel(&id).await;
        }
    }
    // 已订阅源保持原 feed（避免 guid/id 漂移丢进度）；缺 videoId 由 fetch_official 里 fill_youtube_twin 补
    if kind == "xiaoyuzhou" {
        if let Some(pid) = xiaoyuzhou_podcast_id(feed_url) {
            return xiaoyuzhou_show(&pid).await;
        }
    }
    fetch_rss(feed_url, kind).await
}

async fn fetch_rss(feed_url: &str, kind_hint: &str) -> Result<Resolved> {
    let xml = net::get_text(feed_url).await?;
    let (mut show, episodes) = parse_feed(&xml, feed_url)?;
    if kind_hint == "youtube" || feed_url.contains("youtube.com/feeds") {
        show.kind = "youtube".into();
    } else if is_xyzfm(feed_url) || kind_hint == "xiaoyuzhou" {
        show.kind = "xiaoyuzhou".into();
    } else if show.kind.is_empty() || show.kind == "podcast" {
        show.kind = kind_hint.into();
    }
    // Apple/Anchor 常滞后于小宇宙；若节目主页挂了小宇宙链接，用其补全单集。
    let resolved = prefer_xiaoyuzhou_if_richer(Resolved { show, episodes }).await;
    // 音频播客 ↔ YouTube 双形态：按标题把 videoId 填上，单集页才有「视频/仅音频」。
    Ok(attach_youtube_twins(resolved).await)
}

fn parse_feed(xml: &str, feed_url: &str) -> Result<(Show, Vec<Episode>)> {
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
    for item in channel.children().filter(|n| n.has_tag_name("item")).take(MAX_EPISODES) {
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
    for entry in feed.children().filter(|n| n.has_tag_name("entry")).take(MAX_EPISODES) {
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
    if let Some(id) = qiaomu_preferred_source(&format!("podcast/{pid}"), "") {
        return qiaomu::rss_channel(id).await;
    }
    let page = format!("https://www.xiaoyuzhoufm.com/podcast/{pid}");
    let html = net::get_text(&page).await?;
    if let Ok(r) = xiaoyuzhou_from_next_data(&html, &page) {
        if !r.episodes.is_empty() {
            return Ok(attach_youtube_twins(r).await);
        }
    }
    // 短链 slug 的 xyz RSS 偶可用；hex pid 通常 404，失败则至少保住节目壳。
    let feed = format!("https://feed.xyzfm.space/{pid}");
    if let Ok(xml) = net::get_text(&feed).await {
        if let Ok((mut show, episodes)) = parse_feed(&xml, &feed) {
            show.kind = "xiaoyuzhou".into();
            show.feed_url = page.clone();
            show.link = Some(page);
            return Ok(attach_youtube_twins(Resolved { show, episodes }).await);
        }
    }
    let title = Regex::new(r"<title>([^<]+)</title>")
        .ok()
        .and_then(|re| re.captures(&html))
        .map(|c| c[1].replace(" - 小宇宙", "").trim().to_string())
        .unwrap_or_else(|| "小宇宙节目".into());
    Ok(Resolved {
        show: Show {
            id: short_hash(&page, 16),
            kind: "xiaoyuzhou".into(),
            title,
            author: None,
            cover: None,
            feed_url: page.clone(),
            link: Some(page),
            description: None,
            updated_at: now_ms(),
            episode_count: 0,
        },
        episodes: vec![],
    })
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
    Ok(Resolved {
        show: Show {
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
            episode_count: 0,
        },
        episodes,
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
    resolved.show.kind = "xiaoyuzhou".into();
    resolved.show.feed_url = format!("https://www.xiaoyuzhoufm.com/podcast/{pid}");
    resolved.show.link = Some(resolved.show.feed_url.clone());
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
    // #010 / EP010 / Ep 10 / 第10期 → 同一期
    if let Some(c) = Regex::new(r"(?i)(?:#|ep|第)\s*0*(\d+)")
        .ok()
        .and_then(|re| re.captures(title))
    {
        return format!("#{}", &c[1]);
    }
    title
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase()
}

/// 已知双形态节目：订阅时优先乔木 RSS（自带 videoId / 精读），避免纯音频源开集只能 ASR。
fn qiaomu_preferred_source(feed_or_input: &str, title: &str) -> Option<&'static str> {
    let u = feed_or_input.to_lowercase();
    let t = title.to_lowercase();
    if u.contains("116d068f0")
        || u.contains("6a9956fafbb9512fc83ddbb5")
        || u.contains("nexttokentv")
        || u.contains("sources/nexttoken")
        || t.contains("词元之外")
        || t.contains("next token")
    {
        return Some("nexttoken");
    }
    None
}

/// 音频源常无 videoId；对照 YouTube 频道按期号/标题配对，单集页才能切「视频/仅音频」。
fn youtube_twin_handle(feed_url: &str, title: &str) -> Option<&'static str> {
    let u = feed_url.to_lowercase();
    let t = title.to_lowercase();
    if qiaomu_preferred_source(feed_url, title).is_some()
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
                // 小宇宙通常更新更快且带音频
                if e.audio_url.is_some() {
                    let progress = old.progress;
                    *old = e;
                    old.progress = progress;
                } else if old.audio_url.is_none() {
                    *old = e;
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
    Regex::new(r"id(\d{6,})")
        .ok()?
        .captures(s)
        .map(|c| c[1].to_string())
        .or_else(|| {
            if s.chars().all(|c| c.is_ascii_digit()) && s.len() >= 6 {
                Some(s.to_string())
            } else {
                None
            }
        })
}

fn xiaoyuzhou_podcast_id(s: &str) -> Option<String> {
    Regex::new(r"xiaoyuzhoufm\.com/podcast/([a-f0-9]+)")
        .ok()?
        .captures(s)
        .map(|c| c[1].to_string())
}

fn is_youtube(s: &str) -> bool {
    s.contains("youtube.com") || s.contains("youtu.be") || s.starts_with('@')
}

fn is_xyzfm(s: &str) -> bool {
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
        let html = r#"<a href="https://www.xiaoyuzhoufm.com/podcast/aaaaaaaaaaaaaaaa">x</a>
            <a data-listen-platform="xiaoyuzhou" href="https://www.xiaoyuzhoufm.com/podcast/6a9956fafbb9512fc83ddbb5">小宇宙</a>"#;
        assert_eq!(
            preferred_xyz_pid(html).as_deref(),
            Some("6a9956fafbb9512fc83ddbb5")
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
}
