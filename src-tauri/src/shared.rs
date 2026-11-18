/**
 * [INPUT]: net、model::Episode/Segment/Transcript；subcast.qiaomu.ai 共享字幕 API
 * [OUTPUT]: keys（小宇宙 guid/audio 归一）/ canonical_audio_url / lookup / upload_*
 * [POS]: 官方字幕与 ASR 之前的共享库捷径——命中则跳过整集下载；导读同库
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use crate::model::{Episode, Segment, Transcript};
use crate::net;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const API: &str = "https://subcast.qiaomu.ai/api/v1/transcripts";

fn sha1_hex(s: &str) -> String {
    use sha1::Digest;
    hex::encode(sha1::Sha1::digest(s.as_bytes()))
}

/// 小宇宙单集 id：24 位 hex（RSS guid 常不带 `.html`，乔木/SubCast 上传用带 `.html`）。
fn xyz_eid(guid: &str) -> Option<&str> {
    let g = guid.strip_suffix(".html").unwrap_or(guid);
    (g.len() == 24 && g.chars().all(|c| c.is_ascii_hexdigit())).then_some(g)
}

/// 把 dts-api 包装链还原成 `media.xyzcdn.net/…`，与乔木库里的 audio key 对齐。
pub fn canonical_audio_url(url: &str) -> String {
    let bare = url.split(['?', '#']).next().unwrap_or(url);
    if let Some(i) = bare.find("media.xyzcdn.net/") {
        return format!("https://{}", &bare[i..]);
    }
    bare.to_string()
}

/// 1–4 个跨安装标识同一集的 key（服务端任一命中即可）。
/// 小宇宙订阅与乔木源 guid/audio URL 写法不同，这里做归一，才能命中共享库、跳过整集下载。
pub fn keys(ep: &Episode) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(v) = ep.video_id.as_deref().filter(|v| !v.is_empty()) {
        out.push(format!("yt:{v}"));
    }
    let guid = ep.guid.trim();
    let qm = matches!(
        ep.transcript_type.as_deref(),
        Some("qiaomu") | Some("qiaomu-rss") | Some("podscribe")
    );
    if let Some(eid) = xyz_eid(guid) {
        // SubCast/乔木上传固定用 `qm:{eid}.html`
        out.push(format!("qm:{eid}.html"));
    } else if qm && !guid.is_empty() {
        out.push(format!("qm:{guid}"));
    }
    if let Some(a) = ep.audio_url.as_deref().filter(|u| !u.is_empty()) {
        out.push(format!("audio:{}", sha1_hex(&canonical_audio_url(a))));
    }
    if let Some(eid) = xyz_eid(guid) {
        // 与乔木 guid（带 .html）的 sha1 对齐
        out.push(format!("guid:{}", sha1_hex(&format!("{eid}.html"))));
    } else if !guid.is_empty() {
        out.push(format!("guid:{}", sha1_hex(guid)));
    }
    out.truncate(4);
    out
}

#[derive(Deserialize)]
pub struct SharedTranslation {
    pub lang: String,
    pub items: Vec<Option<String>>,
}

#[derive(Deserialize)]
pub struct Shared {
    pub source: String,
    pub language: String,
    pub segments: Vec<Segment>,
    pub translation: Option<SharedTranslation>,
}

/// 查共享库；网络失败静默为 None（自己去识别）。
pub async fn lookup(keys: &[String]) -> Option<Shared> {
    if keys.is_empty() {
        return None;
    }
    let qs = keys
        .iter()
        .map(|k| format!("key={}", urlencoding::encode(k)))
        .collect::<Vec<_>>()
        .join("&");
    let resp = net::client()
        .get(format!("{API}?{qs}"))
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let hit: Shared = resp.json().await.ok()?;
    (!hit.segments.is_empty()).then_some(hit)
}

/// 批量：哪些 key 列表在共享库有字幕（按列表下标）。
pub async fn existing(lists: &[Vec<String>]) -> Vec<bool> {
    let mut out = vec![false; lists.len()];
    let all: Vec<&String> = lists.iter().flatten().collect();
    for chunk in all.chunks(400) {
        let body = serde_json::json!({ "keys": chunk });
        let Ok(resp) = net::client()
            .post(format!("{API}/exists"))
            .json(&body)
            .timeout(Duration::from_secs(8))
            .send()
            .await
        else {
            break;
        };
        if !resp.status().is_success() {
            break;
        }
        #[derive(Deserialize)]
        struct Found {
            found: Vec<String>,
        }
        let Ok(f) = resp.json::<Found>().await else {
            break;
        };
        for (i, keys) in lists.iter().enumerate() {
            if keys.iter().any(|k| f.found.contains(k)) {
                out[i] = true;
            }
        }
    }
    out
}

#[derive(Serialize)]
struct UploadTranslation {
    lang: String,
    engine: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    model: String,
    items: Vec<Option<String>>,
}

#[derive(Serialize)]
struct ClientInfo {
    app: &'static str,
    version: &'static str,
    install: String,
}

#[derive(Serialize)]
struct Upload<'a> {
    keys: &'a [String],
    title: &'a str,
    show: &'a str,
    duration: f64,
    source: &'a str,
    model: &'a str,
    language: &'a str,
    segments: &'a [Segment],
    translation: Option<UploadTranslation>,
    client: ClientInfo,
}

#[derive(Deserialize)]
struct UploadReply {
    action: Option<String>,
}

pub struct UploadMeta {
    pub title: String,
    pub show: String,
    pub duration: f64,
    pub source: String,
    pub model: String,
    pub language: String,
    pub install: String,
    pub translation: Option<(String, Vec<Option<String>>)>,
}

pub async fn upload_with(
    keys: &[String],
    meta: UploadMeta,
    segments: &[Segment],
    engine: &str,
    tr_model: &str,
) -> anyhow::Result<String> {
    let body = Upload {
        keys,
        title: &meta.title,
        show: &meta.show,
        duration: meta.duration,
        source: &meta.source,
        model: &meta.model,
        language: &meta.language,
        segments,
        translation: meta.translation.map(|(lang, items)| UploadTranslation {
            lang,
            engine: engine.into(),
            model: tr_model.into(),
            items,
        }),
        client: ClientInfo {
            app: "subpodcast",
            version: env!("CARGO_PKG_VERSION"),
            install: meta.install,
        },
    };
    let resp = net::client()
        .post(API)
        .json(&body)
        .timeout(Duration::from_secs(30))
        .send()
        .await?;
    if !resp.status().is_success() {
        anyhow::bail!("shared transcripts: HTTP {}", resp.status());
    }
    let reply: UploadReply = resp.json().await?;
    Ok(reply.action.unwrap_or_default())
}

pub fn into_transcript(episode_id: &str, hit: Shared) -> Transcript {
    Transcript {
        episode_id: episode_id.into(),
        source: format!("shared:{}", hit.source),
        language: hit.language,
        segments: hit.segments,
    }
}

const GUIDES: &str = "https://subcast.qiaomu.ai/api/v1/guides";

/// 别人分享的导读（Markdown）；网络失败静默为 None。
pub async fn lookup_guide(keys: &[String]) -> Option<String> {
    if keys.is_empty() {
        return None;
    }
    let qs = keys
        .iter()
        .map(|k| format!("key={}", urlencoding::encode(k)))
        .collect::<Vec<_>>()
        .join("&");
    let resp = net::client()
        .get(format!("{GUIDES}?{qs}"))
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    #[derive(Deserialize)]
    struct Hit {
        text: String,
    }
    let hit: Hit = resp.json().await.ok()?;
    (!hit.text.trim().is_empty()).then_some(hit.text)
}

/// 匿名上传本机生成的导读；返回服务端 action。
pub async fn upload_guide(
    keys: &[String],
    title: &str,
    show: &str,
    model: &str,
    text: &str,
    install: String,
) -> anyhow::Result<String> {
    let body = serde_json::json!({
        "keys": keys,
        "title": title,
        "show": show,
        "lang": "zh",
        "model": model,
        "text": text,
        "client": {
            "app": "subpodcast",
            "version": env!("CARGO_PKG_VERSION"),
            "install": install,
        }
    });
    let resp = net::client()
        .post(GUIDES)
        .json(&body)
        .timeout(Duration::from_secs(20))
        .send()
        .await?;
    if !resp.status().is_success() {
        anyhow::bail!("shared guides: HTTP {}", resp.status());
    }
    let v: serde_json::Value = resp.json().await?;
    Ok(v["action"].as_str().unwrap_or("").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn episode_keys() {
        let ep = Episode {
            guid: "abc123".into(),
            audio_url: Some("https://media.example.com/ep1.mp3".into()),
            video_id: Some("tBMlXQIrYK4".into()),
            transcript_type: Some("qiaomu-rss".into()),
            ..Default::default()
        };
        let ks = keys(&ep);
        assert_eq!(ks.len(), 4, "{ks:?}");
        assert_eq!(ks[0], "yt:tBMlXQIrYK4");
        assert_eq!(ks[1], "qm:abc123");
        assert!(ks[2].starts_with("audio:") && ks[2].len() == 6 + 40);
        assert!(ks[3].starts_with("guid:") && ks[3].len() == 5 + 40);
        let ep2 = Episode {
            guid: "g".into(),
            audio_url: Some("a".into()),
            ..Default::default()
        };
        assert_eq!(keys(&ep2).len(), 2);
        assert!(keys(&Episode::default()).is_empty());
    }

    #[test]
    fn xiaoyuzhou_keys_match_qiaomu_upload() {
        let eid = "6af5debf14d01a26f8a900ac";
        let ep = Episode {
            guid: eid.into(), // 小宇宙 RSS：无 .html、无 transcript_type
            audio_url: Some(format!(
                "https://dts-api.xiaoyuzhoufm.com/track/626b46ea9cbbf0451cf5a962/{eid}/media.xyzcdn.net/626b46ea9cbbf0451cf5a962/lvnhry4gLCC3Ut_6NMJN7QRmdDaN.m4a"
            )),
            ..Default::default()
        };
        let ks = keys(&ep);
        assert!(ks.contains(&format!("qm:{eid}.html")), "{ks:?}");
        let cdn = "https://media.xyzcdn.net/626b46ea9cbbf0451cf5a962/lvnhry4gLCC3Ut_6NMJN7QRmdDaN.m4a";
        assert!(
            ks.contains(&format!("audio:{}", sha1_hex(cdn))),
            "{ks:?}"
        );
        assert_eq!(
            canonical_audio_url(ep.audio_url.as_deref().unwrap()),
            cdn
        );
    }

    #[tokio::test]
    #[ignore = "需要网络"]
    async fn live_lex_shared_hit() {
        let hit = lookup(&["yt:2hJkprFnzhY".into()]).await;
        assert!(hit.is_some(), "expected shared hit for Lex #504");
        assert!(!hit.unwrap().segments.is_empty());
    }

    #[tokio::test]
    #[ignore = "需要网络"]
    async fn live_xiaoyuzhou_via_normalized_qm() {
        let ep = Episode {
            guid: "6af5debf14d01a26f8a900ac".into(),
            audio_url: Some(
                "https://dts-api.xiaoyuzhoufm.com/track/626b46ea9cbbf0451cf5a962/6af5debf14d01a26f8a900ac/media.xyzcdn.net/626b46ea9cbbf0451cf5a962/x.m4a"
                    .into(),
            ),
            ..Default::default()
        };
        let hit = lookup(&keys(&ep)).await;
        assert!(hit.is_some(), "小宇宙 guid 归一后应命中乔木共享库");
        assert!(hit.unwrap().segments.len() > 100);
    }
}
