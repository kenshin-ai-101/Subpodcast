/**
 * [INPUT]: 依赖 net、model；乔木精读站 *.qiaomu.ai 与 rss.qiaomu.ai
 * [OUTPUT]: 精读频道 Show+Episodes；按节目标题匹配精读源
 * [POS]: 与 SubCast qiaomu 对齐的精读订阅入口；feeds.resolve / search 可升格到此
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use crate::feeds;
use crate::model::{now_ms, short_hash, Episode, Show};
use crate::net;
use anyhow::{anyhow, Result};
use regex::Regex;

/// 与 SubCast 一致：单档最多保留最近 300 期。
pub const MAX_EPISODES: usize = 300;

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
        unplayed: 0,
    };
    let episodes = list
        .iter()
        .take(MAX_EPISODES)
        .filter_map(|e| {
            let slug = e["s"].as_str()?.to_string();
            let t = e["t"].as_str()?.to_string();
            let link = e["u"]
                .as_str()
                .map(abs)
                .unwrap_or_else(|| format!("{base}ep/{slug}/"));
            let published = e["d"]
                .as_str()
                .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
                .and_then(|d| d.and_hms_opt(12, 0, 0))
                .map(|d| d.and_utc().timestamp());
            let video = e["y"]
                .as_str()
                .filter(|y| y.len() == 11)
                .map(str::to_string);
            Some(Episode {
                id: short_hash(&format!("{show_id}|{slug}"), 20),
                show_id: show_id.clone(),
                guid: slug,
                title: t,
                published,
                duration: e["du"].as_f64(),
                audio_url: None,
                cover: e["c"].as_str().map(abs).or_else(|| {
                    video
                        .as_ref()
                        .map(|y| format!("https://i.ytimg.com/vi/{y}/hqdefault.jpg"))
                }),
                video_id: video,
                link: Some(link),
                notes: e["ds"].as_str().map(str::to_string),
                transcript_url: None,
                transcript_type: Some("qiaomu".into()),
                progress: 0.0,
                has_transcript: false,
                show_title: Some(show.title.clone()),
            })
        })
        .collect();
    Ok(feeds::Resolved { show, episodes })
}

/// 拉取 `rss.qiaomu.ai/sources/{id}`（分页 API，封顶 MAX_EPISODES）。
pub async fn rss_channel(id: &str) -> Result<feeds::Resolved> {
    let mut entries: Vec<serde_json::Value> = vec![];
    let mut cursor = String::new();
    for _ in 0..3 {
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
        if entries.len() >= MAX_EPISODES {
            break;
        }
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
        unplayed: 0,
    };
    let episodes = entries
        .iter()
        .take(MAX_EPISODES)
        .filter_map(|e| {
            let guid = e["id"].as_str()?.to_string();
            let ep_title = e["title"].as_str()?.to_string();
            let audio = e["audio"]["url"].as_str().map(str::to_string);
            let video = e["link"]
                .as_str()
                .and_then(crate::feeds::youtube_id_from_url_pub);
            if audio.is_none() && video.is_none() && !id.starts_with("podscribe-") {
                return None;
            }
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
                link: e["link"].as_str().map(str::to_string),
                cover: e["image"].as_str().map(str::to_string).or_else(|| {
                    video.map(|v| format!("https://i.ytimg.com/vi/{v}/hqdefault.jpg"))
                }),
                notes: e["summary"].as_str().map(str::to_string),
                transcript_url: None,
                transcript_type: Some("qiaomu-rss".into()),
                progress: 0.0,
                has_transcript: false,
                show_title: Some(title.clone()),
            })
        })
        .collect();
    Ok(feeds::Resolved { show, episodes })
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
    fn live_lex_channel_capped() {
        let r = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(channel("lex"))
            .expect("lex");
        eprintln!("lex n={} kind={} first={}", r.episodes.len(), r.show.kind, r.episodes.first().map(|e| e.title.as_str()).unwrap_or("-"));
        assert_eq!(r.show.kind, "qiaomu");
        assert!(r.episodes.len() <= MAX_EPISODES);
        assert!(!r.episodes.is_empty());
    }
}
