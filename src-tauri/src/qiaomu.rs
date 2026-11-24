/**
 * [INPUT]: 依赖 net、model、feeds、captions::split_timed；乔木精读站 *.qiaomu.ai 与 rss.qiaomu.ai
 * [OUTPUT]: 精读频道、单集 Detail、rss 改写 HTML、transcript_segments / podscribe_transcript；rss_channel 分页拉满
 * [POS]: 精读订阅与正文管线；入库不截 300；官方字幕瀑布可消费原文/Podscribe
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use crate::captions;
use crate::feeds;
use crate::model::{now_ms, short_hash, Episode, Segment, Show};
use crate::net;
use anyhow::{anyhow, Result};
use regex::Regex;
use serde::Serialize;

/// 精读 RSS 分页防御上限（页×100）；不是产品截断，源有多少入多少。
const RSS_MAX_PAGES: usize = 100;

/// `https://lex.qiaomu.ai/...` → `lex`（排除 rss/api/www 等公共服务子域）。
pub fn site_id(url: &str) -> Option<String> {
    let c = Regex::new(r"^https?://([a-z0-9-]+)\.qiaomu\.ai(?:/|$)")
        .ok()?
        .captures(url.trim())?;
    let id = c[1].to_string();
    (!["rss", "api", "www", "xnews", "elon", "blog", "subcast", "tuijian"].contains(&id.as_str()))
        .then_some(id)
}

/// `https://rss.qiaomu.ai/sources/nexttoken` → `nexttoken`。
pub fn rss_source_id(url: &str) -> Option<String> {
    Regex::new(r"^https?://rss\.qiaomu\.ai/sources/([A-Za-z0-9_-]+)/?$")
        .ok()?
        .captures(url.trim())
        .map(|c| c[1].to_string())
}

pub fn feed_url(id: &str) -> String {
    format!("https://{id}.qiaomu.ai/")
}

pub fn rss_feed_url(id: &str) -> String {
    format!("https://rss.qiaomu.ai/sources/{id}")
}

fn title_for(id: &str) -> Option<&'static str> {
    Some(match id {
        "lex" => "Lex Fridman Podcast",
        "allin" => "All-In Podcast",
        "nopriors" => "No Priors",
        "cogrev" => "The Cognitive Revolution",
        "trainingdata" => "Training Data",
        "unsupervised" => "Unsupervised Learning",
        "zhangxiaojun" => "张小珺Jùn｜商业访谈录",
        "42zhangjing" => "42章经",
        "latetalk" => "晚点聊 LateTalk",
        "crossing" => "十字路口Crossing",
        "aialchemy" => "AI炼金术",
        "35huan" => "三五环",
        "zhixing" => "知行小酒馆",
        "mianji" => "面基",
        "nexttoken" => "Next Token｜词元之外",
        "bannatie" => "半拿铁 | 商业沉浮录",
        "latentspace" => "Latent Space",
        "podscribe-acquired" => "Acquired",
        "podscribe-pivot" => "Pivot",
        "podscribe-freakonomics-radio" => "Freakonomics Radio",
        "podscribe-invest-like-the-best" => "Invest Like the Best",
        "podscribe-the-diary-of-a-ceo-with-steven-bartlett" => "The Diary Of A CEO",
        _ => return None,
    })
}

/// 搜索词命中精读目录时，优先订阅精读源（与 SubCast Discover picks 同源）。
pub fn curated_feed_for_query(term: &str) -> Option<(String, String)> {
    let q = norm(term);
    if q.is_empty() {
        return None;
    }
    const CATALOG: &[(&str, &str, &[&str])] = &[
        ("lex", "site", &["lex fridman", "lexfridman", "lex"]),
        ("nopriors", "site", &["no priors", "nopriors"]),
        ("allin", "site", &["all-in podcast", "all in podcast", "allin"]),
        ("cogrev", "site", &["cognitive revolution", "cogrev"]),
        ("trainingdata", "site", &["training data"]),
        ("unsupervised", "site", &["unsupervised learning"]),
        ("zhangxiaojun", "site", &["张小珺", "zhangxiaojun"]),
        ("latetalk", "site", &["晚点聊", "latetalk", "late talk"]),
        ("42zhangjing", "site", &["42章经", "42zhangjing"]),
        ("nexttoken", "rss", &["next token", "词元之外", "nexttoken"]),
        ("latentspace", "rss", &["latent space", "latentspace"]),
        ("bannatie", "rss", &["半拿铁", "bannatie"]),
        ("crossing", "site", &["十字路口", "crossing"]),
        ("aialchemy", "site", &["ai炼金术", "aialchemy"]),
        ("35huan", "site", &["三五环", "35huan"]),
        ("zhixing", "site", &["知行小酒馆", "zhixing"]),
        ("mianji", "site", &["面基", "mianji"]),
        ("podscribe-acquired", "rss", &["acquired"]),
        ("podscribe-pivot", "rss", &["pivot"]),
    ];
    for (id, kind, keys) in CATALOG {
        if keys.iter().any(|k| q.contains(&norm(k)) || norm(k).contains(&q)) {
            let feed = if *kind == "rss" {
                rss_feed_url(id)
            } else {
                feed_url(id)
            };
            let title = title_for(id).unwrap_or(id).to_string();
            return Some((feed, title));
        }
    }
    None
}

fn norm(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || (*c as u32) > 0x2e80)
        .collect()
}

fn meta(html: &str, prop: &str) -> Option<String> {
    let re = Regex::new(&format!(
        r#"<meta[^>]+(?:property|name)="{prop}"[^>]+content="([^"]*)""#
    ))
    .ok()?;
    re.captures(html)
        .map(|c| c[1].to_string())
        .filter(|s| !s.is_empty())
}

/// 精读目录项：`site` → `*.qiaomu.ai/data/episodes.json`；`rss` → rss.qiaomu.ai API。
pub fn curated_kind(id: &str) -> Option<&'static str> {
    match id {
        "nexttoken" | "latentspace" | "bannatie" => Some("rss"),
        id if id.starts_with("podscribe-") => Some("rss"),
        id if title_for(id).is_some() => Some("site"),
        _ => None,
    }
}

/// 按精读 id 打开全量目录（site / rss）。
pub async fn open_curated(id: &str) -> Result<feeds::Resolved> {
    match curated_kind(id) {
        Some("rss") => rss_channel(id).await,
        Some("site") => channel(id).await,
        _ => Err(anyhow!("未知精读源：{id}")),
    }
}

/// 小宇宙 eid 常写作 `6af5….html`；去掉后缀才能与 xyz guid 对齐合并。
fn normalize_episode_guid(raw: &str) -> String {
    let s = raw.trim().trim_start_matches('/').trim_start_matches("ep/");
    s.strip_suffix(".html")
        .or_else(|| s.strip_suffix(".htm"))
        .unwrap_or(s)
        .to_string()
}

/// 拉取 `*.qiaomu.ai` 精读站（`/data/episodes.json`）。
pub async fn channel(id: &str) -> Result<feeds::Resolved> {
    let base = feed_url(id);
    let data_url = format!("{base}data/episodes.json");
    let (home, data) = tokio::join!(net::get_text(&base), net::get_text(&data_url));
    let home = home.unwrap_or_default();
    let v: serde_json::Value =
        serde_json::from_str(&data?).map_err(|_| anyhow!("精读频道数据格式不对"))?;
    let list = v["episodes"].as_array().cloned().unwrap_or_default();
    if list.is_empty() {
        return Err(anyhow!("这个精读频道还没有节目"));
    }
    let title = title_for(id)
        .map(String::from)
        .or_else(|| meta(&home, "og:site_name"))
        .or_else(|| meta(&home, "og:title"))
        .unwrap_or_else(|| format!("{id}.qiaomu.ai"));
    let abs = |u: &str| {
        if u.starts_with("http") {
            u.to_string()
        } else {
            format!(
                "{}{}",
                base.trim_end_matches('/'),
                if u.starts_with('/') {
                    u.to_string()
                } else {
                    format!("/{u}")
                }
            )
        }
    };
    let show_id = short_hash(&base, 16);
    let show = Show {
        id: show_id.clone(),
        kind: "qiaomu".into(),
        title,
        author: Some("乔木精读".into()),
        cover: meta(&home, "og:image").map(|u| abs(&u)),
        feed_url: base.clone(),
        link: Some(base.clone()),
        description: meta(&home, "description").or_else(|| meta(&home, "og:description")),
        updated_at: now_ms(),
        episode_count: 0,
    };
    let episodes: Vec<Episode> = list
        .iter()
        .filter_map(|e| {
            let raw_slug = e["s"].as_str()?;
            let guid = normalize_episode_guid(raw_slug);
            if guid.is_empty() {
                return None;
            }
            let t = e["t"].as_str()?.to_string();
            let link = e["u"]
                .as_str()
                .map(&abs)
                .unwrap_or_else(|| format!("{base}ep/{guid}/"));
            let published = e["d"]
                .as_str()
                .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
                .and_then(|d| d.and_hms_opt(12, 0, 0))
                .map(|d| d.and_utc().timestamp());
            let video = e["y"]
                .as_str()
                .filter(|y| y.len() == 11)
                .map(str::to_string);
            // 精读站常带小宇宙 CDN 音频（字段 a）
            let audio = e["a"]
                .as_str()
                .filter(|u| !u.is_empty())
                .map(str::to_string);
            Some(Episode {
                id: short_hash(&format!("{show_id}|{guid}"), 20),
                show_id: show_id.clone(),
                guid,
                title: t,
                published,
                duration: e["du"].as_f64(),
                audio_url: audio,
                cover: e["c"].as_str().map(&abs).or_else(|| {
                    video
                        .as_ref()
                        .map(|y| format!("https://i.ytimg.com/vi/{y}/hqdefault.jpg"))
                }),
                video_id: video,
                link: Some(link),
                notes: e["ds"].as_str().map(str::to_string),
                transcript_url: None,
                transcript_type: Some("qiaomu".into()),
                deep: true,
                progress: 0.0,
                has_transcript: false,
                show_title: Some(show.title.clone()),
            })
        })
        .collect();
    let mut show = show;
    show.episode_count = episodes.len() as i64;
    Ok(feeds::Resolved::full(show, episodes))
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub audio: Option<String>,
    pub deep_read: Option<String>,
    pub transcript: Option<String>,
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

/// 取 class 含指定名的首个块级元素的 inner HTML。
fn inner_html(html: &str, class: &str) -> Option<String> {
    let open = Regex::new(&format!(
        r#"<(div|article|section|pre)[^>]*class="[^"]*\b{}\b[^"]*"[^>]*>"#,
        regex::escape(class)
    ))
    .ok()?;
    let m = open.captures(html)?;
    let tag = m[1].to_string();
    let start = m.get(0)?.end();
    let tok = Regex::new(&format!(r"(?i)<(/?){tag}\b[^>]*>")).ok()?;
    let mut depth = 1i32;
    for t in tok.captures_iter(&html[start..]) {
        depth += if t[1].is_empty() { 1 } else { -1 };
        if depth == 0 {
            return Some(html[start..start + t.get(0)?.start()].to_string());
        }
    }
    None
}

/// 精读站单集页：音频、中文精读 HTML、原文。
pub async fn detail(link: &str) -> Result<Detail> {
    let html = net::get_text(link).await?;
    let audio = Regex::new(r#"<audio[^>]+src="([^"]+)""#)
        .ok()
        .and_then(|re| re.captures(&html))
        .map(|c| decode_entities(&c[1]))
        .or_else(|| {
            Regex::new(r#"(?:src|href)="(https://[^"]+\.(?:mp3|m4a)[^"]*)""#)
                .ok()
                .and_then(|re| re.captures(&html))
                .map(|c| decode_entities(&c[1]))
        });
    let deep_read = inner_html(&html, "zh-article")
        .map(|h| {
            let h = Regex::new(r"(?is)<script.*?</script>|<style.*?</style>")
                .unwrap()
                .replace_all(&h, "");
            Regex::new(r#"(?is)<p[^>]*class="zh-note"[^>]*>.*?</p>"#)
                .unwrap()
                .replace_all(&h, "")
                .trim()
                .to_string()
        })
        .filter(|h| h.len() > 40);
    let transcript = inner_html(&html, "transcript-text")
        .map(|t| {
            let t = Regex::new(r"(?s)<[^>]+>").unwrap().replace_all(&t, "");
            decode_entities(t.trim())
        })
        .filter(|t| t.len() > 200);
    Ok(Detail {
        audio,
        deep_read,
        transcript,
    })
}

/// 无时间戳原文按时长摊成句段（精读站 transcript-text）。
pub fn transcript_segments(text: &str, duration: f64) -> Vec<Segment> {
    let body: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let skip = body
        .iter()
        .take(3)
        .take_while(|l| {
            l.len() < 160
                && (l.contains("Podcast")
                    || l.contains("transcri")
                    || l.contains('#')
                    || l.contains("May contain"))
        })
        .count();
    let joined = body[skip..].join(" ");
    if joined.is_empty() {
        return vec![];
    }
    captions::split_timed(&joined, 0.0, duration.max(60.0))
}

/// Podscribe 带时间戳字幕。
pub async fn podscribe_transcript(url: &str) -> Result<Vec<Segment>> {
    let v = net::get_json(url).await?;
    let segs = v["data"]["transcript"]["segments"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut out: Vec<Segment> = segs
        .iter()
        .filter_map(|s| {
            let text = s["text"].as_str()?.trim().to_string();
            (!text.is_empty()).then(|| Segment {
                start: s["start_seconds"].as_f64().unwrap_or(0.0),
                end: 0.0,
                text,
            })
        })
        .collect();
    for i in 0..out.len() {
        out[i].end = out
            .get(i + 1)
            .map(|n| n.start)
            .unwrap_or(out[i].start + 8.0);
    }
    Ok(out)
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn inline_md(s: &str) -> String {
    static RE_IMG: once_cell::sync::Lazy<Regex> =
        once_cell::sync::Lazy::new(|| Regex::new(r"!\[[^\]]*\]\([^)]*\)").expect("img regex"));
    static RE_BOLD: once_cell::sync::Lazy<Regex> =
        once_cell::sync::Lazy::new(|| Regex::new(r"\*\*(.+?)\*\*").expect("bold regex"));
    static RE_LINK: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
        Regex::new(r"\[([^\]]+)\]\((https?://[^)\s&quot;]+)\)").expect("link regex")
    });
    static RE_CODE: once_cell::sync::Lazy<Regex> =
        once_cell::sync::Lazy::new(|| Regex::new(r"`([^`]+)`").expect("code regex"));

    let s = RE_IMG.replace_all(s, "");
    let s = esc(&s);
    let s = RE_BOLD.replace_all(&s, "<strong>$1</strong>");
    let s = RE_LINK.replace_all(&s, r#"<a href="$2">$1</a>"#);
    RE_CODE.replace_all(&s, "<code>$1</code>").into_owned()
}

/// 改写 Markdown → 简易 HTML（标题/列表/引用/段落）。
pub fn markdown_html(md: &str) -> String {
    let mut out = String::new();
    let mut list = false;
    for block in md.split("\n\n").map(str::trim).filter(|b| !b.is_empty()) {
        let lines: Vec<&str> = block.lines().collect();
        if lines
            .iter()
            .all(|l| l.trim_start().starts_with("- ") || l.trim_start().starts_with("* "))
        {
            if !list {
                out.push_str("<ul>");
                list = true;
            }
            for l in lines {
                out.push_str(&format!(
                    "<li>{}</li>",
                    inline_md(l.trim_start()[2..].trim())
                ));
            }
            continue;
        }
        if list {
            out.push_str("</ul>");
            list = false;
        }
        if let Some(h) = block.strip_prefix("### ") {
            out.push_str(&format!("<h3>{}</h3>", inline_md(h)));
        } else if let Some(h) = block.strip_prefix("## ") {
            out.push_str(&format!("<h2>{}</h2>", inline_md(h)));
        } else if let Some(h) = block.strip_prefix("# ") {
            out.push_str(&format!("<h2>{}</h2>", inline_md(h)));
        } else if block.starts_with('>') {
            let q: Vec<String> = lines
                .iter()
                .map(|l| inline_md(l.trim_start_matches('>').trim()))
                .collect();
            out.push_str(&format!(
                "<blockquote><p>{}</p></blockquote>",
                q.join("<br>")
            ));
        } else {
            out.push_str(&format!(
                "<p>{}</p>",
                lines.iter().map(|l| inline_md(l)).collect::<Vec<_>>().join("<br>")
            ));
        }
    }
    if list {
        out.push_str("</ul>");
    }
    out
}

/// rss.qiaomu.ai 单集改写正文。
pub async fn rss_rewrite(entry_id: &str) -> Result<Option<String>> {
    let v = net::get_json(&format!(
        "https://rss.qiaomu.ai/api/entry/{entry_id}/rewrite"
    ))
    .await?;
    if v["status"].as_str() != Some("ready") {
        return Ok(None);
    }
    let html = v["rewrite"]["bodyHtml"]
        .as_str()
        .filter(|h| !h.is_empty())
        .map(String::from)
        .or_else(|| v["rewrite"]["body"].as_str().map(markdown_html));
    Ok(html.filter(|h| h.len() > 40))
}

/// 拉取 `rss.qiaomu.ai/sources/{id}`（分页直到没有更多）。
pub async fn rss_channel(id: &str) -> Result<feeds::Resolved> {
    let mut entries: Vec<serde_json::Value> = vec![];
    let mut cursor = String::new();
    for _ in 0..RSS_MAX_PAGES {
        let url = format!(
            "https://rss.qiaomu.ai/api/sources/{id}/entries?limit=100{}",
            if cursor.is_empty() {
                String::new()
            } else {
                format!("&cursor={}", urlencoding::encode(&cursor))
            }
        );
        let page: serde_json::Value = serde_json::from_str(&net::get_text(&url).await?)?;
        entries.extend(
            page["entries"]
                .as_array()
                .cloned()
                .unwrap_or_default(),
        );
        match page["nextCursor"].as_str() {
            Some(c) if page["hasMore"].as_bool() == Some(true) && !c.is_empty() => {
                cursor = c.to_string();
            }
            _ => break,
        }
    }
    if entries.is_empty() {
        return Err(anyhow!("这个精读频道还没有节目"));
    }
    let feed = rss_feed_url(id);
    let show_id = short_hash(&feed, 16);
    let title = title_for(id).unwrap_or(id).to_string();
    let show = Show {
        id: show_id.clone(),
        kind: "qiaomu".into(),
        title: title.clone(),
        author: Some("乔木精读".into()),
        cover: None,
        feed_url: feed.clone(),
        link: Some(feed),
        description: None,
        updated_at: now_ms(),
        episode_count: 0,
    };
    let episodes = entries
        .iter()
        .filter_map(|e| {
            let guid = e["id"].as_str()?.to_string();
            let ep_title = e["title"].as_str()?.to_string();
            let audio = e["audio"]["url"].as_str().map(str::to_string);
            let link = e["link"].as_str().map(str::to_string);
            let video = link
                .as_deref()
                .and_then(crate::feeds::youtube_id_from_url_pub);
            let podscribe = id.starts_with("podscribe-");
            if audio.is_none() && video.is_none() && !podscribe {
                return None;
            }
            let transcript_url = if podscribe {
                link.as_deref()
                    .and_then(|l| l.strip_prefix("https://podcasts.happyscribe.com/"))
                    .map(|p| format!("https://api.qiaomu.ai/podscribe/v1/episodes/{p}/transcript"))
            } else {
                None
            };
            Some(Episode {
                id: short_hash(&format!("{show_id}|{guid}"), 20),
                show_id: show_id.clone(),
                guid,
                title: ep_title,
                published: e["publishedTs"].as_i64().map(|ms| {
                    if ms > 10_000_000_000 {
                        ms / 1000
                    } else {
                        ms
                    }
                }),
                duration: None,
                audio_url: audio,
                video_id: video.clone(),
                link,
                cover: e["image"].as_str().map(str::to_string).or_else(|| {
                    video.map(|v| format!("https://i.ytimg.com/vi/{v}/hqdefault.jpg"))
                }),
                notes: e["summary"].as_str().map(str::to_string),
                transcript_url,
                transcript_type: Some(if podscribe {
                    "podscribe".into()
                } else {
                    "qiaomu-rss".into()
                }),
                deep: e["rewriteReady"].as_bool().unwrap_or(false),
                progress: 0.0,
                has_transcript: false,
                show_title: Some(title.clone()),
            })
        })
        .collect();
    Ok(feeds::Resolved::full(show, episodes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curated_lex_maps_to_site() {
        let (feed, title) = curated_feed_for_query("Lex Fridman Podcast").unwrap();
        assert!(feed.contains("lex.qiaomu.ai"));
        assert!(title.contains("Lex"));
    }

    #[test]
    #[ignore = "需要网络"]
    fn live_lex_channel() {
        let r = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(channel("lex"))
            .expect("lex");
        eprintln!("lex n={} kind={} first={}", r.episodes.len(), r.show.kind, r.episodes.first().map(|e| e.title.as_str()).unwrap_or("-"));
        assert_eq!(r.show.kind, "qiaomu");
        assert!(!r.episodes.is_empty());
    }
}
