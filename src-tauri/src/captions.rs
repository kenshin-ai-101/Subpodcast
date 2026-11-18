/**
 * [INPUT]: 依赖 net、model、transcript 解析逻辑（本文件内）
 * [OUTPUT]: YouTube 字幕轨拉取、VTT/SRT/JSON 解析、分句清理
 * [POS]: 官方字幕路径；不负责 ASR
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use crate::model::Segment;
use crate::net;
use anyhow::{anyhow, Result};
use regex::Regex;
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct Track {
    pub language: String,
    pub auto: bool,
    pub url: String,
}

/// 通过 InnerTube player 接口列出字幕轨（ANDROID 客户端标识，可被远端配置替换）。
pub async fn youtube_tracks(video_id: &str) -> Result<Vec<Track>> {
    let body = serde_json::json!({
        "context": {
            "client": {
                "clientName": "ANDROID",
                "clientVersion": "20.10.38",
                "hl": "en",
                "gl": "US"
            }
        },
        "videoId": video_id
    });
    let resp = net::client()
        .post("https://www.youtube.com/youtubei/v1/player?prettyPrint=false")
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(anyhow!("YouTube player HTTP {}", resp.status()));
    }
    let v: Value = resp.json().await?;
    let mut tracks = Vec::new();
    let list = v
        .pointer("/captions/playerCaptionsTracklistRenderer/captionTracks")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    for t in list {
        let base = t["baseUrl"].as_str().unwrap_or("");
        if base.is_empty() {
            continue;
        }
        let lang = t["languageCode"].as_str().unwrap_or("und").to_string();
        let auto = t["kind"].as_str() == Some("asr");
        let url = if base.contains("fmt=") {
            base.to_string()
        } else {
            format!("{base}&fmt=json3")
        };
        tracks.push(Track { language: lang, auto, url });
    }
    Ok(tracks)
}

/// 人工轨优先于自动轨；同优先级时偏英文，再退回第一条。
pub fn choose_track<'a>(tracks: &'a [Track], prefer_lang: Option<&str>) -> Option<&'a Track> {
    if tracks.is_empty() {
        return None;
    }
    let prefer = prefer_lang.unwrap_or("en").to_lowercase();
    let mut ranked: Vec<&Track> = tracks.iter().collect();
    ranked.sort_by_key(|t| {
        let auto_pen = if t.auto { 1 } else { 0 };
        let lang_pen = if t.language.to_lowercase().starts_with(&prefer) { 0 } else { 1 };
        (auto_pen, lang_pen)
    });
    ranked.first().copied()
}

pub async fn fetch_track(track: &Track) -> Result<Vec<Segment>> {
    let body = net::get_text(&track.url).await?;
    let segs = if body.trim_start().starts_with('{') {
        parse_youtube_json3(&body)
    } else {
        parse_cues(&body)
    };
    Ok(resegment(clean(segs)))
}

pub async fn fetch_rss_transcript(url: &str, kind: &str) -> Result<Vec<Segment>> {
    let body = net::get_text(url).await?;
    let segs = if kind.contains("json") {
        parse_podcast_json(&body)
    } else {
        parse_cues(&body)
    };
    Ok(resegment(clean(segs)))
}

fn parse_cues(body: &str) -> Vec<Segment> {
    let mut out = Vec::new();
    let body = body.replace("\r\n", "\n");
    for block in body.split("\n\n") {
        let lines: Vec<&str> = block.lines().collect();
        let Some(idx) = lines.iter().position(|l| l.contains("-->")) else { continue };
        let mut it = lines[idx].split("-->");
        let (Some(a), Some(b)) = (it.next(), it.next()) else { continue };
        let b = b.split_whitespace().next().unwrap_or("");
        let (Some(start), Some(end)) = (clock(a), clock(b)) else { continue };
        let text = strip_tags(&lines[idx + 1..].join(" "));
        if !text.is_empty() {
            out.push(Segment { start, end, text });
        }
    }
    out
}

fn parse_podcast_json(body: &str) -> Vec<Segment> {
    let Ok(v) = serde_json::from_str::<Value>(body) else { return vec![] };
    v["segments"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    let text = s["body"].as_str()?.trim().to_string();
                    let start = s["startTime"].as_f64()?;
                    let end = s["endTime"].as_f64().unwrap_or(start + 2.0);
                    (!text.is_empty()).then_some(Segment { start, end, text })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_youtube_json3(body: &str) -> Vec<Segment> {
    let Ok(v) = serde_json::from_str::<Value>(body) else { return vec![] };
    let mut out = Vec::new();
    for ev in v["events"].as_array().into_iter().flatten() {
        let Some(t) = ev["tStartMs"].as_f64() else { continue };
        let d = ev["dDurationMs"].as_f64().unwrap_or(0.0);
        let text: String = ev["segs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| s["utf8"].as_str())
            .collect();
        let text = strip_tags(&text);
        if !text.is_empty() {
            out.push(Segment {
                start: t / 1000.0,
                end: (t + d) / 1000.0,
                text,
            });
        }
    }
    out
}

fn clock(stamp: &str) -> Option<f64> {
    let stamp = stamp.trim().replace(',', ".");
    let parts: Vec<&str> = stamp.split(':').collect();
    let mut total = 0.0;
    for p in &parts {
        total = total * 60.0 + p.trim().parse::<f64>().ok()?;
    }
    if parts.len() > 3 {
        None
    } else {
        Some(total)
    }
}

fn strip_tags(text: &str) -> String {
    static TAG: once_cell::sync::Lazy<Regex> =
        once_cell::sync::Lazy::new(|| Regex::new(r"<[^>]+>").unwrap());
    TAG.replace_all(text, "")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

const NOISE: &[&str] = &[
    "thanks for watching",
    "thank you for watching",
    "subtitles by",
    "谢谢观看",
    "感谢观看",
];

pub fn clean(segments: Vec<Segment>) -> Vec<Segment> {
    segments
        .into_iter()
        .filter_map(|mut s| {
            s.text = s.text.trim().to_string();
            if s.text.is_empty() {
                return None;
            }
            let lower = s.text.to_lowercase();
            if NOISE.iter().any(|n| lower.contains(n)) {
                return None;
            }
            Some(s)
        })
        .collect()
}

/// 把碎字幕合并成可读句子（约 12 秒或遇句号切断）。
pub fn resegment(segments: Vec<Segment>) -> Vec<Segment> {
    if segments.is_empty() {
        return segments;
    }
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut start = segments[0].start;
    let mut end = segments[0].end;
    for s in segments {
        if buf.is_empty() {
            start = s.start;
            buf = s.text;
            end = s.end;
            continue;
        }
        let gap = s.start - end;
        let long = end - start > 12.0;
        let punct = buf.ends_with(['.', '!', '?', '。', '！', '？']);
        if gap > 1.2 || long || punct {
            out.push(Segment {
                start,
                end,
                text: buf.trim().to_string(),
            });
            start = s.start;
            buf = s.text;
        } else {
            buf.push(' ');
            buf.push_str(&s.text);
        }
        end = s.end;
    }
    if !buf.trim().is_empty() {
        out.push(Segment {
            start,
            end,
            text: buf.trim().to_string(),
        });
    }
    out
}
