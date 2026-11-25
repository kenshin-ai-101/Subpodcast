/**
 * [INPUT]: video_id；可选 data 目录（找 yt-dlp）；net InnerTube player
 * [OUTPUT]: fetch / parse_* / prefill_missing；进程内按 video_id 缓存正时长
 * [POS]: video_id 写入后补 episode.duration；curated_video fill 与 set_video_id 调用
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use crate::model::Episode;
use crate::net;
use crate::ytdlp;
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

static CACHE: Lazy<Mutex<HashMap<String, f64>>> = Lazy::new(|| Mutex::new(HashMap::new()));

const FETCH_TIMEOUT: Duration = Duration::from_secs(15);

fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Subpodcast")
}

pub fn cached(video_id: &str) -> Option<f64> {
    CACHE
        .lock()
        .ok()
        .and_then(|g| g.get(video_id).copied())
        .filter(|d| *d > 0.0)
}

pub fn remember(video_id: &str, seconds: f64) {
    if seconds <= 0.0 || !seconds.is_finite() {
        return;
    }
    if let Ok(mut g) = CACHE.lock() {
        g.insert(video_id.to_string(), seconds);
    }
}

/// yt-dlp `--print duration` 标准输出 → 秒。
pub fn parse_ytdlp_print(stdout: &str) -> Option<f64> {
    let line = stdout.lines().map(str::trim).find(|l| !l.is_empty())?;
    let n: f64 = line.parse().ok()?;
    (n > 0.0 && n.is_finite()).then_some(n)
}

/// InnerTube `videoDetails.lengthSeconds`（字符串或数字）。
pub fn parse_length_seconds(details: &Value) -> Option<f64> {
    let raw = &details["lengthSeconds"];
    let n = raw
        .as_str()
        .and_then(|s| s.parse().ok())
        .or_else(|| raw.as_f64())
        .or_else(|| raw.as_i64().map(|i| i as f64))?;
    (n > 0.0 && n.is_finite()).then_some(n)
}

async fn ytdlp_duration(video_id: &str, data: &Path) -> Option<f64> {
    let bin = ytdlp::find_ytdlp(data)?;
    let url = format!("https://www.youtube.com/watch?v={video_id}");
    let mut cmd = ytdlp::ytdlp_command(&bin);
    cmd.args([
        "--skip-download",
        "--no-warnings",
        "--print",
        "duration",
        &url,
    ]);
    let out = cmd.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    parse_ytdlp_print(&String::from_utf8_lossy(&out.stdout))
}

async fn innertube_duration(video_id: &str) -> Option<f64> {
    // 与 captions 同源客户端，只取 lengthSeconds，不要求字幕轨。
    const CLIENTS: &[(&str, &str, Option<u32>)] = &[
        ("ANDROID", "20.10.38", Some(34)),
        ("IOS", "20.10.3", None),
        ("ANDROID_VR", "1.60.19", Some(32)),
    ];
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
            Ok(r) if r.status().is_success() => r.json().await.ok()?,
            _ => continue,
        };
        if let Some(d) = parse_length_seconds(&player["videoDetails"]) {
            return Some(d);
        }
    }
    None
}

/// 一次取时长：缓存 → yt-dlp（若本机有）→ InnerTube；整体 ≤15s，失败返回 None。
pub async fn fetch(video_id: &str, data: Option<&Path>) -> Option<f64> {
    let id = video_id.trim();
    if id.len() != 11 {
        return None;
    }
    if let Some(d) = cached(id) {
        return Some(d);
    }
    let data_owned;
    let data = match data {
        Some(p) => p,
        None => {
            data_owned = data_dir();
            data_owned.as_path()
        }
    };
    let id_owned = id.to_string();
    let data_buf = data.to_path_buf();
    let got = tokio::time::timeout(FETCH_TIMEOUT, async move {
        if let Some(d) = ytdlp_duration(&id_owned, &data_buf).await {
            return Some(d);
        }
        innertube_duration(&id_owned).await
    })
    .await
    .ok()
    .flatten()?;
    remember(id, got);
    Some(got)
}

fn needs_duration(ep: &Episode) -> bool {
    ep.video_id.as_ref().is_some_and(|v| !v.is_empty())
        && ep.duration.map(|d| !(d > 0.0)).unwrap_or(true)
}

/// 给已挂 video_id 且缺时长的集补 duration（best-effort，整批 ≤15s）。
pub async fn prefill_missing(eps: &mut [Episode], data: Option<&Path>) {
    let idxs: Vec<usize> = eps
        .iter()
        .enumerate()
        .filter(|(_, e)| needs_duration(e))
        .map(|(i, _)| i)
        .collect();
    if idxs.is_empty() {
        return;
    }
    let data_owned;
    let data = match data {
        Some(p) => p,
        None => {
            data_owned = data_dir();
            data_owned.as_path()
        }
    };
    let data = data.to_path_buf();
    let _ = tokio::time::timeout(FETCH_TIMEOUT, async {
        for chunk in idxs.chunks(4) {
            let futs: Vec<_> = chunk
                .iter()
                .map(|&i| {
                    let vid = eps[i].video_id.clone().unwrap_or_default();
                    let data = data.clone();
                    async move { (i, fetch(&vid, Some(&data)).await) }
                })
                .collect();
            for (i, d) in futures_util::future::join_all(futs).await {
                if let Some(secs) = d {
                    eps[i].duration = Some(secs);
                }
            }
        }
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ytdlp_stdout() {
        assert_eq!(parse_ytdlp_print("3725\n"), Some(3725.0));
        assert_eq!(parse_ytdlp_print("  1830.5  \n"), Some(1830.5));
        assert_eq!(parse_ytdlp_print("0\n"), None);
        assert_eq!(parse_ytdlp_print("na\n"), None);
        assert_eq!(parse_ytdlp_print(""), None);
    }

    #[test]
    fn parse_player_length_seconds() {
        let s = json!({ "lengthSeconds": "3725", "title": "x" });
        assert_eq!(parse_length_seconds(&s), Some(3725.0));
        let n = json!({ "lengthSeconds": 90 });
        assert_eq!(parse_length_seconds(&n), Some(90.0));
        let bad = json!({ "lengthSeconds": "0" });
        assert_eq!(parse_length_seconds(&bad), None);
        let missing = json!({ "title": "x" });
        assert_eq!(parse_length_seconds(&missing), None);
    }

    #[test]
    fn remember_and_cache() {
        remember("dQw4w9WgXcQ", 212.0);
        assert_eq!(cached("dQw4w9WgXcQ"), Some(212.0));
        remember("dQw4w9WgXcQ", 0.0);
        assert_eq!(cached("dQw4w9WgXcQ"), Some(212.0));
    }
}
