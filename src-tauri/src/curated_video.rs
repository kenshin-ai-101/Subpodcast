/**
 * [INPUT]: net HTTP；Episode 可变切片；磁盘缓存目录（Subpodcast/cache）
 * [OUTPUT]: fill / is_audio_only / set_overrides / best_match；方图过滤与邻集 16:9 配对；缺时长时 video_duration 预填
 * [POS]: 精选/乔木源视频绑定权威层；feeds/qiaomu 拉目录后调用，再 clear_show_videos
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use crate::model::Episode;
use crate::net;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::RwLock;
use std::time::{Duration, Instant};

/// 频道上传条目（published 为 Unix 秒，与 Episode 一致）。
#[derive(Clone, Debug)]
pub struct Vid {
    pub id: String,
    pub title: String,
    pub published: Option<i64>,
    pub duration: Option<f64>,
}

static OVERRIDES: Lazy<RwLock<HashMap<String, String>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));
static FOUND: Lazy<RwLock<HashMap<String, (Option<String>, Instant)>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));
static CHANNEL_MEM: Lazy<RwLock<HashMap<String, (Vec<Vid>, Instant)>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

fn cache_root() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Subpodcast")
        .join("cache")
}

fn channel_cache_path() -> PathBuf {
    cache_root().join("curated-youtube.json")
}

fn aspect_cache_path() -> PathBuf {
    cache_root().join("video-aspect.json")
}

fn read_json_map(path: &PathBuf) -> HashMap<String, Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_json_map(path: &PathBuf, map: &HashMap<String, Value>) {
    let _ = std::fs::create_dir_all(cache_root());
    if let Ok(s) = serde_json::to_string_pretty(map) {
        let _ = std::fs::write(path, s);
    }
}

/// 内置：真实频道 UC… 或 `"none"`（纯音频，不挂视频）。
fn builtin(source: &str) -> Option<&'static str> {
    let s = source.strip_suffix("-zh").unwrap_or(source);
    Some(match s {
        "zhangxiaojun" => "UC3Sv1JuKpbOx3csUO8FAo5g",
        "42zhangjing" => "UCirUGhuiz6m85eKO8n3Picw",
        "zhixing" => "UC3ezayOvLhJRk5L0QRg_bfQ",
        "mianji" => "UCroOLbclmz0FOit7d2Xe0PQ",
        "nexttoken" => "UC_9pr_usdNG29RauPFwIFQw",
        "crossing" => "UCqoy3g7ZH24j2mLOq_nbKrQ",
        "nopriors" => "UCSI7h9hydQ40K5MJHnCrQvw",
        "allin" => "UCESLZhusAkFfsNsApnjF_Cg",
        "unsupervised" => "UCUl-s_Vp-Kkk_XVyDylNwLA",
        "cogrev" => "UCjNRVMBVI30Sak_p6HRWhIA",
        "aialchemy" | "35huan" | "latetalk" => "none",
        _ => return None,
    })
}

/// 远程配置：`source → "UC…" | feed URL | "none"`。
pub fn set_overrides(v: &Value) {
    let Some(obj) = v.as_object() else { return };
    let mut map = HashMap::new();
    for (k, val) in obj {
        if let Some(s) = val.as_str() {
            map.insert(k.to_lowercase(), s.to_string());
        }
    }
    if let Ok(mut g) = OVERRIDES.write() {
        *g = map;
    }
}

pub fn is_audio_only(source: &str) -> bool {
    let key = source.to_lowercase();
    if let Ok(g) = OVERRIDES.read() {
        if let Some(o) = g.get(&key) {
            return o.eq_ignore_ascii_case("none");
        }
    }
    builtin(source).is_some_and(|b| b.eq_ignore_ascii_case("none"))
}

fn channel_id_of(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("none") {
        return None;
    }
    static RE_UC: Lazy<Regex> = Lazy::new(|| Regex::new(r"UC[\w-]{22}").unwrap());
    if let Some(m) = RE_UC.find(s) {
        return Some(m.as_str().to_string());
    }
    // UU / UULF uploads playlist → UC…
    static RE_UU: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"playlist_id=UU(?:LF)?([\w-]{22})").unwrap());
    if let Some(c) = RE_UU.captures(s) {
        return Some(format!("UC{}", &c[1]));
    }
    None
}

fn resolve_channel_spec(source: &str) -> Option<String> {
    let key = source.to_lowercase();
    if let Ok(g) = OVERRIDES.read() {
        if let Some(o) = g.get(&key) {
            return channel_id_of(o);
        }
    }
    builtin(source).and_then(channel_id_of)
}

fn norm(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn episode_num(title: &str) -> Option<u32> {
    static RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(
            r"(?i)(?:^|[\s\[\(【（|#])(?:#|ep\.?|第)\s*0*(\d{1,4})(?:[\s\]\)】）|·\-—:：期]|$)|(?:^|\s)(\d{1,4})\s*[\.\:：]",
        )
        .unwrap()
    });
    RE.captures(title).and_then(|c| {
        c.get(1)
            .or_else(|| c.get(2))
            .and_then(|m| m.as_str().parse().ok())
    })
}

fn bigram_sim(a: &str, b: &str) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let grams = |s: &str| -> HashSet<(char, char)> {
        let chars: Vec<char> = s.chars().collect();
        if chars.len() < 2 {
            return HashSet::new();
        }
        chars.windows(2).map(|w| (w[0], w[1])).collect()
    };
    let ga = grams(a);
    let gb = grams(b);
    if ga.is_empty() || gb.is_empty() {
        return if a == b { 1.0 } else { 0.0 };
    }
    let inter = ga.intersection(&gb).count() as f64;
    let denom = ga.len().min(gb.len()) as f64;
    inter / denom
}

fn days_apart(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    Some((a? - b?).abs() / 86_400)
}

/// 标题 / 期号 / 日期窗打分；`used` 内 id 跳过。published 为 Unix **秒**。
pub fn best_match(
    title: &str,
    published: Option<i64>,
    vids: &[Vid],
    used: &HashSet<String>,
) -> Option<usize> {
    let n = norm(title);
    if n.chars().count() < 6 {
        return None;
    }
    let en = episode_num(title);
    let mut best: Option<(usize, f64)> = None;
    for (i, v) in vids.iter().enumerate() {
        if used.contains(&v.id) {
            continue;
        }
        if let Some(d) = days_apart(published, v.published) {
            if d > 60 {
                continue;
            }
        }
        let nv = norm(&v.title);
        let sim = bigram_sim(&n, &nv);
        let days = days_apart(published, v.published);
        let score = if nv == n
            || (n.chars().count() >= 8 && nv.contains(&n))
            || (nv.chars().count() >= 12 && n.contains(&nv))
        {
            3.0 + sim
        } else if en.is_some()
            && episode_num(&v.title) == en
            && (days.is_some_and(|d| d <= 10) || sim >= 0.35)
        {
            2.0 + sim
        } else if sim >= 0.8 || (sim >= 0.6 && days.is_some_and(|d| d <= 7)) {
            1.0 + sim
        } else {
            continue;
        };
        if best.is_none_or(|(_, s)| score > s) {
            best = Some((i, score));
        }
    }
    best.map(|(i, _)| i)
}

async fn probe_widescreen(video_id: &str) -> Option<bool> {
    let path = aspect_cache_path();
    let disk = read_json_map(&path);
    if let Some(v) = disk.get(video_id).and_then(|x| x.as_bool()) {
        return Some(v);
    }
    let url = format!("https://www.youtube.com/oembed?url=https://youtu.be/{video_id}&format=json");
    let body = net::get_text(&url).await.ok()?;
    let v: Value = serde_json::from_str(&body).ok()?;
    let w = v.get("width")?.as_f64()?;
    let h = v.get("height")?.as_f64()?;
    if h <= 0.0 {
        return None;
    }
    let wide = w * 2.0 >= h * 3.0; // ≥ 3:2
    let mut disk = read_json_map(&path);
    disk.insert(video_id.to_string(), Value::Bool(wide));
    write_json_map(&path, &disk);
    Some(wide)
}

async fn check_widescreen_batch(ids: &[String]) -> HashMap<String, bool> {
    let mut out = HashMap::new();
    let mut uniq: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for id in ids {
        if seen.insert(id.clone()) {
            uniq.push(id.clone());
        }
    }
    // 并发上限 12
    for chunk in uniq.chunks(12) {
        let futs: Vec<_> = chunk.iter().map(|id| async move {
            let w = probe_widescreen(id).await;
            (id.clone(), w)
        }).collect();
        for (id, w) in futures_util::future::join_all(futs).await {
            if let Some(wide) = w {
                out.insert(id, wide);
            }
        }
    }
    out
}

fn ascii_tokens(title: &str) -> HashSet<String> {
    const STOP: &[&str] = &[
        "interview", "podcast", "episode", "full", "video", "official", "trailer",
        "with", "the", "and", "for", "from",
    ];
    title
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| t.len() >= 4)
        .map(|t| t.to_ascii_lowercase())
        .filter(|t| !t.chars().all(|c| c.is_ascii_digit()))
        .filter(|t| !STOP.contains(&t.as_str()))
        .collect()
}

fn find_twin_video(
    vi: usize,
    vids: &[Vid],
    wide: &HashMap<String, bool>,
    assigned: &HashSet<String>,
    title_hits: &HashSet<usize>,
) -> Option<usize> {
    let ref_v = vids.get(vi)?;
    let ref_tokens = ascii_tokens(&ref_v.title);
    let mut best: Option<(usize, f64)> = None;
    for off in [-1_isize, 1, -2, 2] {
        let j = vi as isize + off;
        if j < 0 || j as usize >= vids.len() {
            continue;
        }
        let ji = j as usize;
        if title_hits.contains(&ji) {
            continue;
        }
        let cand = &vids[ji];
        if assigned.contains(&cand.id) {
            continue;
        }
        if wide.get(&cand.id) != Some(&true) {
            continue;
        }
        // 防偷邻：另一侧还有方图且时长更近
        if let (Some(rd), Some(cd)) = (ref_v.duration, cand.duration) {
            if rd >= 300.0 && cd >= 300.0 {
                let my_delta = (rd - cd).abs();
                let other = (ji as isize) + if off > 0 { 1 } else { -1 };
                if other >= 0 && (other as usize) < vids.len() {
                    let other_v = &vids[other as usize];
                    if wide.get(&other_v.id) == Some(&false) {
                        if let Some(od) = other_v.duration {
                            if od >= 300.0 && (od - cd).abs() + 30.0 < my_delta {
                                continue;
                            }
                        }
                    }
                }
            }
        }
        let shared = ref_tokens
            .intersection(&ascii_tokens(&cand.title))
            .count();
        let adjacent = off.abs() == 1;
        let score = match (ref_v.duration, cand.duration) {
            (Some(rd), Some(cd)) if rd >= 300.0 && cd >= 300.0 => {
                let delta = (rd - cd).abs();
                let ratio = delta / rd.max(cd);
                let dur_close = delta <= 180.0 || ratio <= 0.05;
                if dur_close {
                    2.0 - ratio + if adjacent { 0.3 } else { 0.0 } + shared as f64 * 0.1
                } else if adjacent && (shared >= 2 || (shared >= 1 && ratio <= 0.35)) {
                    1.4 + shared as f64 * 0.2
                } else {
                    continue;
                }
            }
            _ if adjacent && shared >= 2 => 1.2 + shared as f64 * 0.15,
            _ => continue,
        };
        if best.is_none_or(|(_, s)| score > s) {
            best = Some((ji, score));
        }
    }
    best.map(|(i, _)| i)
}

fn resolve_real_videos(
    hits: &[(usize, usize)],
    vids: &[Vid],
    wide: &HashMap<String, bool>,
) -> Vec<(usize, usize)> {
    let title_hits: HashSet<usize> = hits.iter().map(|(_, vi)| *vi).collect();
    let mut assigned = HashSet::new();
    let mut out = Vec::new();
    // Pass1: 确认宽屏
    for &(ei, vi) in hits {
        let id = &vids[vi].id;
        if wide.get(id).copied().unwrap_or(true) {
            if assigned.insert(id.clone()) {
                out.push((ei, vi));
            }
        }
    }
    // Pass2: 方图找 twin
    for &(ei, vi) in hits {
        let id = &vids[vi].id;
        if wide.get(id) == Some(&true) {
            continue;
        }
        if out.iter().any(|(e, _)| *e == ei) {
            continue;
        }
        if let Some(twin) = find_twin_video(vi, vids, wide, &assigned, &title_hits) {
            if assigned.insert(vids[twin].id.clone()) {
                out.push((ei, twin));
            }
        }
    }
    out
}

async fn channel_videos(channel_id: &str) -> Vec<Vid> {
    if let Ok(g) = CHANNEL_MEM.read() {
        if let Some((vids, at)) = g.get(channel_id) {
            if at.elapsed() < Duration::from_secs(30 * 60) {
                return vids.clone();
            }
        }
    }
    let mut by_id: HashMap<String, Vid> = HashMap::new();
    // Atom 最近约 15
    let atom = format!("https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}");
    if let Ok(xml) = net::get_text(&atom).await {
        parse_atom_vids(&xml, &mut by_id);
    }
    // uploads 播放列表（约 100）
    let uu = format!(
        "https://www.youtube.com/feeds/videos.xml?playlist_id=UU{}",
        channel_id.strip_prefix("UC").unwrap_or(channel_id)
    );
    if let Ok(xml) = net::get_text(&uu).await {
        parse_atom_vids(&xml, &mut by_id);
    }
    let mut vids: Vec<Vid> = by_id.into_values().collect();
    vids.sort_by(|a, b| b.published.cmp(&a.published));
    if let Ok(mut g) = CHANNEL_MEM.write() {
        g.insert(channel_id.to_string(), (vids.clone(), Instant::now()));
    }
    vids
}

fn parse_atom_vids(xml: &str, out: &mut HashMap<String, Vid>) {
    let Ok(doc) = roxmltree::Document::parse(xml) else {
        return;
    };
    for entry in doc.descendants().filter(|n| n.has_tag_name("entry")) {
        let mut id = None;
        let mut title = None;
        let mut published = None;
        for c in entry.children() {
            let tag = c.tag_name().name();
            if tag == "videoId" {
                id = c.text().map(str::to_string);
            } else if tag == "title" {
                title = c.text().map(str::to_string);
            } else if tag == "published" {
                published = c.text().and_then(|t| {
                    chrono::DateTime::parse_from_rfc3339(t)
                        .ok()
                        .map(|d| d.timestamp())
                });
            } else if tag == "group" {
                for g in c.children() {
                    if g.tag_name().name() == "videoid" || g.tag_name().name() == "videoId" {
                        id = g.text().map(str::to_string);
                    }
                }
            }
        }
        // media:group yt:videoId
        if id.is_none() {
            for n in entry.descendants() {
                let name = n.tag_name().name();
                if name.eq_ignore_ascii_case("videoid") {
                    id = n.text().map(str::to_string);
                    break;
                }
            }
        }
        let Some(id) = id.filter(|s| s.len() == 11) else {
            continue;
        };
        let title = title.unwrap_or_default();
        out.entry(id.clone()).or_insert(Vid {
            id,
            title,
            published,
            duration: None,
        });
    }
}

fn clean_show_name(name: &str) -> String {
    let base = name.split('·').next().unwrap_or(name).trim();
    base.replace("中文精读", "")
        .replace("精读", "")
        .replace("文稿", "")
        .trim()
        .to_string()
}

async fn discover(show_name: &str, sample_eps: &[Episode]) -> Option<String> {
    let q = clean_show_name(show_name);
    if q.chars().count() < 2 {
        return None;
    }
    let url = format!(
        "https://www.youtube.com/results?search_query={}&sp=EgIQAg%253D%253D",
        urlencoding::encode(&q)
    );
    let html = net::get_text(&url).await.ok()?;
    static RE_UC: Lazy<Regex> =
        Lazy::new(|| Regex::new(r#""channelId":"(UC[\w-]{22})""#).unwrap());
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for c in RE_UC.captures_iter(&html) {
        let id = c[1].to_string();
        if seen.insert(id.clone()) {
            candidates.push(id);
            if candidates.len() >= 3 {
                break;
            }
        }
    }
    let recent: Vec<&Episode> = sample_eps.iter().take(40).collect();
    let need = if recent.len() >= 4 { 2 } else { 1 };
    let mut best: Option<(String, usize)> = None;
    for ch in candidates {
        let vids = channel_videos(&ch).await;
        if vids.is_empty() {
            continue;
        }
        let mut used = HashSet::new();
        let mut hits = 0usize;
        for ep in &recent {
            if let Some(i) = best_match(&ep.title, ep.published, &vids, &used) {
                used.insert(vids[i].id.clone());
                hits += 1;
            }
        }
        if hits < need {
            continue;
        }
        // 抽样宽屏：全是 1:1 则拒（纯 Podcast 封面频道）
        let sample_ids: Vec<String> = vids.iter().take(6).map(|v| v.id.clone()).collect();
        let wide = check_widescreen_batch(&sample_ids).await;
        if !sample_ids.is_empty() && sample_ids.iter().all(|id| wide.get(id) == Some(&false)) {
            continue;
        }
        let better = match &best {
            None => true,
            Some((_, h)) => hits > *h,
        };
        if better {
            best = Some((ch, hits));
        }
    }
    best.map(|(id, _)| id)
}

async fn channel_for(source: &str, show_name: &str, eps: &[Episode]) -> Option<String> {
    if let Some(id) = resolve_channel_spec(source) {
        return Some(id);
    }
    // 会话 / 磁盘缓存
    if let Ok(g) = FOUND.read() {
        if let Some((cached, at)) = g.get(source) {
            if cached.is_some() || at.elapsed() < Duration::from_secs(30 * 60) {
                return cached.clone();
            }
        }
    }
    let disk = read_json_map(&channel_cache_path());
    if let Some(id) = disk.get(source).and_then(|v| v.as_str()).map(str::to_string) {
        return Some(id);
    }
    let found = discover(show_name, eps).await;
    if let Ok(mut g) = FOUND.write() {
        g.insert(source.to_string(), (found.clone(), Instant::now()));
    }
    if let Some(ref id) = found {
        let mut disk = read_json_map(&channel_cache_path());
        disk.insert(source.to_string(), Value::String(id.clone()));
        write_json_map(&channel_cache_path(), &disk);
    }
    found
}

/// 给缺 `video_id` 的集配对真实 16:9。返回 `true` = 已权威检查（可清库内陈旧绑定）。
pub async fn fill(source: &str, show_name: &str, eps: &mut [Episode]) -> bool {
    if is_audio_only(source) {
        return true;
    }
    if eps.iter().all(|e| e.video_id.as_ref().is_some_and(|v| !v.is_empty())) {
        return false;
    }
    let channel = match tokio::time::timeout(
        Duration::from_secs(20),
        channel_for(source, show_name, eps),
    )
    .await
    {
        Ok(Some(c)) => c,
        _ => return false,
    };
    let vids = match tokio::time::timeout(Duration::from_secs(15), channel_videos(&channel)).await {
        Ok(v) if !v.is_empty() => v,
        _ => return false,
    };
    let mut used = HashSet::new();
    let mut hits: Vec<(usize, usize)> = Vec::new();
    for (ei, ep) in eps.iter().enumerate() {
        if ep.video_id.as_ref().is_some_and(|v| !v.is_empty()) {
            continue;
        }
        if let Some(vi) = best_match(&ep.title, ep.published, &vids, &used) {
            used.insert(vids[vi].id.clone());
            hits.push((ei, vi));
        }
    }
    if hits.is_empty() {
        return true;
    }
    let mut probe_ids = HashSet::new();
    for &(_, vi) in &hits {
        let lo = vi.saturating_sub(2);
        let hi = (vi + 2).min(vids.len().saturating_sub(1));
        for i in lo..=hi {
            probe_ids.insert(vids[i].id.clone());
        }
    }
    let ids: Vec<String> = probe_ids.into_iter().collect();
    let wide = check_widescreen_batch(&ids).await;
    let resolved = resolve_real_videos(&hits, &vids, &wide);
    for (ei, vi) in resolved {
        let v = &vids[vi];
        let ep = &mut eps[ei];
        ep.video_id = Some(v.id.clone());
        if ep.cover.as_ref().map(|c| c.is_empty()).unwrap_or(true) {
            ep.cover = Some(format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", v.id));
        }
        if ep.duration.is_none() {
            ep.duration = v.duration;
        }
    }
    // Atom 常无时长；挂上 video_id 后 best-effort 补一次（≤15s）
    crate::video_duration::prefill_missing(eps, None).await;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_only_builtin() {
        assert!(is_audio_only("aialchemy"));
        assert!(is_audio_only("latetalk"));
        assert!(is_audio_only("35huan"));
        assert!(!is_audio_only("zhangxiaojun"));
        assert!(!is_audio_only("nexttoken"));
    }

    #[test]
    fn channel_id_parse() {
        assert_eq!(
            channel_id_of("UC3Sv1JuKpbOx3csUO8FAo5g").as_deref(),
            Some("UC3Sv1JuKpbOx3csUO8FAo5g")
        );
        assert_eq!(
            channel_id_of(
                "https://www.youtube.com/feeds/videos.xml?channel_id=UC_9pr_usdNG29RauPFwIFQw"
            )
            .as_deref(),
            Some("UC_9pr_usdNG29RauPFwIFQw")
        );
        assert_eq!(channel_id_of("none"), None);
    }

    #[test]
    fn best_match_by_number() {
        let vids = vec![
            Vid {
                id: "aaaaaaaaaaa".into(),
                title: "EP 42 Deep Dive".into(),
                published: Some(1_700_000_000),
                duration: Some(3600.0),
            },
            Vid {
                id: "bbbbbbbbbbb".into(),
                title: "EP 99 Other".into(),
                published: Some(1_700_000_000),
                duration: Some(3600.0),
            },
        ];
        let used = HashSet::new();
        let i = best_match("第42期：深度访谈", Some(1_700_000_100), &vids, &used);
        assert_eq!(i, Some(0));
    }

    #[test]
    fn override_none() {
        set_overrides(&serde_json::json!({"demo": "none"}));
        assert!(is_audio_only("demo"));
        set_overrides(&serde_json::json!({}));
    }
}
