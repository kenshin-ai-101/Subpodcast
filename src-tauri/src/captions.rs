/**
 * [INPUT]: 依赖 net、model::Segment
 * [OUTPUT]: video_info/选轨/align、fetch_track_raw（细时间戳）、clean/resegment、split_timed
 * [POS]: 官方字幕下载与分句；中文对齐用 raw+clean；原文用 clean+resegment；不负责 ASR
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use crate::model::Segment;
use crate::net;
use anyhow::{anyhow, Result};
use regex::Regex;
use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub struct Track {
    pub language: String,
    pub auto: bool,
    pub url: String,
}

pub struct VideoInfo {
    pub title: String,
    pub tracks: Vec<Track>,
    /// 有配音时 YouTube 标为 original 的音轨语言。
    pub original_language: Option<String>,
}

const CLIENTS: &[(&str, &str, Option<u32>)] = &[
    ("ANDROID", "20.10.38", Some(34)),
    ("IOS", "20.10.3", None),
    ("ANDROID_VR", "1.60.19", Some(32)),
];

fn lang_base(lang: &str) -> String {
    lang.split(['-', '_'])
        .next()
        .unwrap_or(lang)
        .to_lowercase()
}

fn tracks_of(player: &Value) -> Vec<Track> {
    player["captions"]["playerCaptionsTracklistRenderer"]["captionTracks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| {
            let base = t["baseUrl"].as_str()?;
            if base.contains("exp=xpe") {
                return None;
            }
            let lang = t["languageCode"].as_str().unwrap_or("und").to_string();
            let auto = t["kind"].as_str() == Some("asr");
            let url = if base.contains("fmt=") {
                base.to_string()
            } else {
                format!("{base}&fmt=json3")
            };
            Some(Track {
                language: lang,
                auto,
                url,
            })
        })
        .collect()
}

fn original_language(player: &Value) -> Option<String> {
    let mut found = std::collections::BTreeSet::new();
    for key in ["formats", "adaptiveFormats"] {
        for f in player["streamingData"][key]
            .as_array()
            .into_iter()
            .flatten()
        {
            let a = &f["audioTrack"];
            if a["displayName"]
                .as_str()
                .is_some_and(|n| n.to_lowercase().contains("original"))
            {
                if let Some(id) = a["id"].as_str() {
                    found.insert(lang_base(id.split('.').next().unwrap_or(id)));
                }
            }
        }
    }
    (found.len() == 1).then(|| found.into_iter().next().unwrap())
}

/// InnerTube 多客户端轮询；优先返回带字幕轨的结果。
pub async fn video_info(video_id: &str) -> Result<VideoInfo> {
    let mut last_err = anyhow!("YouTube 没有返回视频信息");
    let mut fallback: Option<VideoInfo> = None;
    for &(name, version, sdk) in CLIENTS {
        let mut client = json!({ "clientName": name, "clientVersion": version, "hl": "en" });
        if let Some(sdk) = sdk {
            client["androidSdkVersion"] = json!(sdk);
        }
        let body = json!({
            "context": { "client": client },
            "videoId": video_id,
            "contentCheckOk": true,
            "racyCheckOk": true
        });
        let res = net::client()
            .post("https://www.youtube.com/youtubei/v1/player?prettyPrint=false")
            .json(&body)
            .send()
            .await;
        let player: Value = match res {
            Ok(r) if r.status().is_success() => match r.json().await {
                Ok(v) => v,
                Err(e) => {
                    last_err = e.into();
                    continue;
                }
            },
            Ok(r) => {
                last_err = anyhow!("YouTube {}", r.status());
                continue;
            }
            Err(e) => {
                last_err = anyhow!("连不上 YouTube（国内需要设置代理）：{e}");
                continue;
            }
        };
        let d = &player["videoDetails"];
        let info = VideoInfo {
            title: d["title"].as_str().unwrap_or("").to_string(),
            tracks: tracks_of(&player),
            original_language: original_language(&player),
        };
        if !info.tracks.is_empty() {
            return Ok(info);
        }
        if fallback.is_none() && !info.title.is_empty() {
            fallback = Some(info);
        }
    }
    fallback.ok_or(last_err)
}

/// 标题脚本提示口语：假名→日、谚文→韩、汉字（无假名）→中。
pub fn script_hint(title: &str) -> Option<&'static str> {
    let has = |lo: char, hi: char| title.chars().any(|c| (lo..=hi).contains(&c));
    if has('\u{3040}', '\u{30ff}') {
        Some("ja")
    } else if has('\u{ac00}', '\u{d7af}') {
        Some("ko")
    } else if title
        .chars()
        .filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c))
        .count()
        >= 2
    {
        Some("zh")
    } else {
        None
    }
}

/// 口语轨：人工优先；无证据时退英文，再退第一条。
pub fn choose<'a>(
    tracks: &'a [Track],
    original: Option<&str>,
    hint: Option<&str>,
) -> Option<&'a Track> {
    if tracks.is_empty() {
        return None;
    }
    let autos: Vec<&Track> = tracks.iter().filter(|t| t.auto).collect();
    let spoken = original
        .map(lang_base)
        .or_else(|| (autos.len() == 1).then(|| lang_base(&autos[0].language)))
        .or_else(|| hint.map(lang_base));
    if let Some(sp) = &spoken {
        if let Some(t) = tracks
            .iter()
            .find(|t| !t.auto && &lang_base(&t.language) == sp)
        {
            return Some(t);
        }
        if let Some(t) = autos.iter().find(|t| &lang_base(&t.language) == sp) {
            return Some(t);
        }
    }
    tracks
        .iter()
        .find(|t| !t.auto && lang_base(&t.language) == "en")
        .or_else(|| autos.iter().copied().find(|t| lang_base(&t.language) == "en"))
        .or_else(|| tracks.iter().find(|t| !t.auto))
        .or_else(|| tracks.first())
}

/// 非中文口语时，节目方人工简体中文轨（作双语译文）。
pub fn official_chinese<'a>(tracks: &'a [Track], spoken: &str) -> Option<&'a Track> {
    if lang_base(spoken) == "zh" {
        return None;
    }
    let zh: Vec<&Track> = tracks
        .iter()
        .filter(|t| !t.auto && lang_base(&t.language) == "zh")
        .collect();
    zh.iter()
        .find(|t| matches!(t.language.as_str(), "zh-Hans" | "zh-CN" | "zh-SG" | "zh"))
        .or(zh.first())
        .copied()
}

/// 把另一轨按时间中点挂到原文句下；空槽留给机翻。
pub fn align(orig: &[Segment], other: &[Segment]) -> Vec<Option<String>> {
    let mut out: Vec<Option<String>> = vec![None; orig.len()];
    for s in other {
        let mid = (s.start + s.end) / 2.0;
        let i = orig.partition_point(|o| o.start <= mid).saturating_sub(1);
        if orig.is_empty() || mid > orig[i].end + 2.0 {
            continue;
        }
        let text = s.text.trim();
        if text.is_empty() {
            continue;
        }
        match &mut out[i] {
            Some(prev) => prev.push_str(text),
            slot => *slot = Some(text.to_string()),
        }
    }
    out
}

/// 只拉原始 cue（未 clean/resegment）。中文对齐要用细粒度时间戳。
pub async fn fetch_track_raw(track: &Track) -> Result<Vec<Segment>> {
    let stripped = Regex::new(r"&fmt=[^&]*")
        .unwrap()
        .replace_all(&track.url, "")
        .to_string();
    for url in [format!("{stripped}&fmt=json3"), stripped.clone()] {
        if let Ok(body) = net::get_text(&url).await {
            let segs = parse_youtube(&body);
            if !segs.is_empty() {
                return Ok(segs);
            }
            let cues = parse_cues(&body);
            if !cues.is_empty() {
                return Ok(cues);
            }
        }
    }
    Err(anyhow!("字幕下载失败"))
}

/// 原文轨：clean + resegment 成可读句（RSS 等也可直接用）。
#[allow(dead_code)]
pub async fn fetch_track(track: &Track) -> Result<Vec<Segment>> {
    Ok(resegment(clean(fetch_track_raw(track).await?)))
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
        let Some(idx) = lines.iter().position(|l| l.contains("-->")) else {
            continue;
        };
        let mut it = lines[idx].split("-->");
        let (Some(a), Some(b)) = (it.next(), it.next()) else {
            continue;
        };
        let b = b.split_whitespace().next().unwrap_or("");
        let (Some(start), Some(end)) = (clock(a), clock(b)) else {
            continue;
        };
        let text = strip_tags(&lines[idx + 1..].join(" "));
        if !text.is_empty() {
            out.push(Segment { start, end, text });
        }
    }
    out
}

fn parse_podcast_json(body: &str) -> Vec<Segment> {
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return vec![];
    };
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

/// YouTube timedtext：json3，或 srv3/classic XML。
fn parse_youtube(body: &str) -> Vec<Segment> {
    let trimmed = body.trim();
    let mut out = Vec::new();
    if trimmed.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
            for ev in v["events"].as_array().into_iter().flatten() {
                let Some(t) = ev["tStartMs"].as_f64() else {
                    continue;
                };
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
        }
        return out;
    }
    static P: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
        Regex::new(r#"(?s)<(text|p)\b([^>]*)>(.*?)</(?:text|p)>"#).unwrap()
    });
    static A: once_cell::sync::Lazy<Regex> =
        once_cell::sync::Lazy::new(|| Regex::new(r#"\b(start|dur|t|d)="([\d.]+)""#).unwrap());
    for c in P.captures_iter(trimmed) {
        let classic = &c[1] == "text";
        let (mut start, mut dur) = (None, 0.0);
        for a in A.captures_iter(&c[2]) {
            let v: f64 = a[2].parse().unwrap_or(0.0);
            match &a[1] {
                "start" if classic => start = Some(v),
                "dur" if classic => dur = v,
                "t" if !classic => start = Some(v / 1000.0),
                "d" if !classic => dur = v / 1000.0,
                _ => {}
            }
        }
        let text = strip_tags(&c[3]);
        if let (Some(s), false) = (start, text.is_empty()) {
            out.push(Segment {
                start: s,
                end: s + dur,
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

fn decode_entities(text: &str) -> String {
    static NUM: once_cell::sync::Lazy<Regex> =
        once_cell::sync::Lazy::new(|| Regex::new(r"&#(x?)([0-9a-fA-F]+);").unwrap());
    let t = NUM.replace_all(text, |c: &regex::Captures| {
        let radix = if c[1].is_empty() { 10 } else { 16 };
        u32::from_str_radix(&c[2], radix)
            .ok()
            .and_then(char::from_u32)
            .map(|ch| ch.to_string())
            .unwrap_or_default()
    });
    t.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

fn strip_tags(text: &str) -> String {
    static TAG: once_cell::sync::Lazy<Regex> =
        once_cell::sync::Lazy::new(|| Regex::new(r"<[^>]+>").unwrap());
    decode_entities(&TAG.replace_all(text, ""))
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

const HALLUCINATIONS: &[&str] = &[
    "谢谢观看",
    "感谢观看",
    "请不吝点赞",
    "字幕由",
    "字幕by",
    "订阅",
    "thanks for watching",
    "thank you for watching",
    "subtitles by",
    "amara.org",
];

/// 去掉音乐标记、片尾幻觉与重复行。
pub fn clean(segments: Vec<Segment>) -> Vec<Segment> {
    static MUSIC: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
        Regex::new(r"(?i)^\s*[\[\(（【]?\s*(music|音乐|applause|掌声|laughter|笑声|♪+)\s*[\]\)）】]?\s*$")
            .unwrap()
    });
    let mut out: Vec<Segment> = Vec::new();
    for s in segments {
        let text = s
            .text
            .replace('♪', "")
            .replace("[]", "")
            .replace("()", "")
            .trim()
            .to_string();
        if text.is_empty() || MUSIC.is_match(&text) {
            continue;
        }
        let low = text.to_lowercase();
        if s.end - s.start < 4.0
            && text.chars().count() < 30
            && HALLUCINATIONS.iter().any(|h| low.contains(h))
        {
            continue;
        }
        if out.last().is_some_and(|p| p.text == text) {
            continue;
        }
        out.push(Segment { text, ..s });
    }
    out
}

fn ends_sentence(text: &str) -> bool {
    text.trim_end()
        .ends_with(['.', '?', '!', '。', '？', '！', '…', '"', '”'])
}

/// 碎 cue 并成可读句：句末 / 长停顿 / 长度上限；CJK 不插空格。
pub fn resegment(segments: Vec<Segment>) -> Vec<Segment> {
    if segments.is_empty() {
        return segments;
    }
    let punctuated = segments.iter().filter(|s| ends_sentence(&s.text)).count() * 6
        >= segments.len().max(1);
    let (max_len, max_secs) = if punctuated {
        (320, 30.0)
    } else {
        (180, 12.0)
    };
    let mut out: Vec<Segment> = Vec::new();
    let mut cur: Option<Segment> = None;
    for s in segments {
        match cur.as_mut() {
            Some(c) => {
                let gap = s.start - c.end;
                let cjk = s.text.chars().next().is_some_and(|ch| ch > '\u{2e80}');
                let too_long =
                    c.text.chars().count() > max_len || s.end - c.start > max_secs;
                if (punctuated && ends_sentence(&c.text) && c.end - c.start > 1.2)
                    || gap > 2.0
                    || too_long
                {
                    out.push(cur.take().unwrap());
                    cur = Some(s);
                } else {
                    if !cjk {
                        c.text.push(' ');
                    }
                    c.text.push_str(&s.text);
                    c.end = c.end.max(s.end);
                }
            }
            None => cur = Some(s),
        }
    }
    if let Some(c) = cur {
        out.push(c);
    }
    out
}

/// 把一段带总起止时间的长文按句切开，时间按字数比例摊开（Qwen3 约 30s 一块）。
pub fn split_timed(text: &str, start: f64, end: f64) -> Vec<Segment> {
    let chars: Vec<char> = text.chars().collect();
    let mut raw: Vec<String> = Vec::new();
    let mut cur = String::new();
    for (i, &c) in chars.iter().enumerate() {
        cur.push(c);
        let next = chars.get(i + 1).copied();
        let ends = match c {
            '。' | '？' | '！' | '；' => !matches!(next, Some('”' | '"')),
            '.' | '?' | '!' => next.is_none_or(char::is_whitespace),
            '"' | '”' => i > 0 && matches!(chars[i - 1], '.' | '?' | '!' | '。' | '？' | '！'),
            _ => false,
        };
        if ends {
            raw.push(cur.trim().to_string());
            cur.clear();
        }
    }
    if !cur.trim().is_empty() {
        raw.push(cur.trim().to_string());
    }
    let short = |t: &str| t.chars().count() < if t.chars().any(|c| c > '\u{2e80}') { 6 } else { 12 };
    let mut parts: Vec<String> = Vec::new();
    for r in raw.into_iter().filter(|r| !r.is_empty()) {
        match parts.last_mut() {
            Some(last) if short(&r) || short(last) => {
                if !last.ends_with(|c: char| c > '\u{2e80}') {
                    last.push(' ');
                }
                last.push_str(&r);
            }
            _ => parts.push(r),
        }
    }
    let total: usize = parts.iter().map(|p| p.chars().count()).sum::<usize>().max(1);
    let span = (end - start).max(0.0);
    let mut t = start;
    parts
        .into_iter()
        .map(|p| {
            let d = span * p.chars().count() as f64 / total as f64;
            let s = Segment {
                start: t,
                end: t + d,
                text: p,
            };
            t += d;
            s
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(l: &str, auto: bool) -> Track {
        Track {
            language: l.into(),
            auto,
            url: String::new(),
        }
    }

    #[test]
    fn dubbed_video_picks_original() {
        let tracks = vec![t("ar", true), t("en", true), t("en-US", false), t("de", true)];
        assert_eq!(choose(&tracks, Some("en"), None).unwrap().language, "en-US");
        assert_eq!(choose(&tracks, None, None).unwrap().language, "en-US");
        let only_auto = vec![t("ar", true), t("en", true)];
        assert_eq!(choose(&only_auto, None, None).unwrap().language, "en");
        assert_eq!(choose(&[t("ja", true)], None, None).unwrap().language, "ja");
    }

    #[test]
    fn chinese_title_opens_chinese_track() {
        let tracks = vec![
            t("en", false),
            t("zh-Hans", false),
            t("zh-Hans", true),
            t("en", true),
        ];
        let hint = script_hint("#010 黄仁勋辞职，Fable 杀死比赛");
        assert_eq!(hint, Some("zh"));
        assert_eq!(choose(&tracks, None, hint).unwrap().language, "zh-Hans");
        assert!(official_chinese(&tracks, "zh-Hans").is_none());
        assert_eq!(script_hint("Recursive self-improvement"), None);
        assert_eq!(script_hint("ChatGPTの使い方"), Some("ja"));
    }

    #[test]
    fn english_video_takes_publisher_chinese() {
        let tracks = vec![
            t("en", false),
            t("zh-TW", false),
            t("zh-Hans", false),
            t("en", true),
        ];
        assert_eq!(
            official_chinese(&tracks, "en").unwrap().language,
            "zh-Hans"
        );
        let seg = |s: f64, e: f64, x: &str| Segment {
            start: s,
            end: e,
            text: x.into(),
        };
        let orig = vec![
            seg(0.0, 4.0, "Hello there."),
            seg(4.0, 9.0, "How are you?"),
            seg(9.0, 12.0, "Fine."),
        ];
        let zh = vec![
            seg(0.2, 2.0, "你好"),
            seg(2.0, 3.8, "呀。"),
            seg(4.5, 8.0, "你好吗？"),
        ];
        let items = align(&orig, &zh);
        assert_eq!(items[0].as_deref(), Some("你好呀。"));
        assert_eq!(items[1].as_deref(), Some("你好吗？"));
        assert!(items[2].is_none());
    }
}
