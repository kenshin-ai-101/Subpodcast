/**
 * [INPUT]: ytdlp（ensure / ytdlp_command / with_bot_fallback / warm）；应用 data 目录
 * [OUTPUT]: youtube_stream_url（HLS m3u8 或 progressive mp4）；内存+磁盘 URL 缓存；video_duration
 * [POS]: 嵌入播放失败时给 WebView `<video>` 直连；macOS 优先 HLS，其它平台 progressive MP4（暂无 loopback HLS 代理）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use anyhow::{anyhow, Context, Result};
use once_cell::sync::Lazy;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex as AsyncMutex;

/// 进程内记录的片长（秒），供命令层回填 episodes.duration。
static DURATIONS: Lazy<Mutex<HashMap<String, f64>>> = Lazy::new(Default::default);

pub fn video_duration(video_id: &str) -> Option<f64> {
    DURATIONS.lock().unwrap().get(video_id).copied()
}

/// 解析结果缓存：内存 + `streams.json`；在 YouTube expire 前约 20 分钟失效。
pub mod cache {
    use super::*;

    static FILE: once_cell::sync::OnceCell<PathBuf> = once_cell::sync::OnceCell::new();
    static MAP: Lazy<Mutex<HashMap<String, (String, u64)>>> = Lazy::new(|| {
        let saved = FILE
            .get()
            .and_then(|f| std::fs::read(f).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Mutex::new(saved)
    });

    const MARGIN_SECS: u64 = 20 * 60;
    const DEFAULT_LIFE_SECS: u64 = 4 * 3600;

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    /// 首次解析前调用一次，指向应用 data 目录。
    pub fn init(data: &Path) {
        let _ = FILE.set(data.join("streams.json"));
    }

    /// `expire=` 查询参数或 HLS 路径 `/expire/<secs>/`。
    pub fn expiry(url: &str) -> Option<u64> {
        let tail = url
            .split_once("expire=")
            .or_else(|| url.split_once("/expire/"))?
            .1;
        let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
        digits.parse().ok()
    }

    pub fn get(key: &str) -> Option<String> {
        let map = MAP.lock().unwrap();
        map.get(key)
            .filter(|(_, until)| *until > now())
            .map(|(u, _)| u.clone())
    }

    pub fn put(key: &str, url: &str) {
        let t = now();
        let until = expiry(url)
            .map(|e| e.saturating_sub(MARGIN_SECS))
            .unwrap_or(t + DEFAULT_LIFE_SECS);
        let mut map = MAP.lock().unwrap();
        map.retain(|_, (_, u)| *u > t);
        if until > t {
            map.insert(key.to_string(), (url.to_string(), until));
        }
        if let (Some(f), Ok(b)) = (FILE.get(), serde_json::to_vec(&*map)) {
            let _ = std::fs::write(f, b);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::expiry;

        #[test]
        fn reads_expiry() {
            assert_eq!(
                expiry("https://rr1.googlevideo.com/videoplayback?expire=1700000000&ei=x"),
                Some(1_700_000_000)
            );
            assert_eq!(
                expiry(
                    "https://manifest.googlevideo.com/api/manifest/hls_variant/expire/1700001234/ei/abc/file/index.m3u8"
                ),
                Some(1_700_001_234)
            );
            assert_eq!(expiry("https://example.com/a.mp4"), None);
        }
    }
}

/// 同一 video_id 同时只跑一次 yt-dlp；第二次请求等锁后走缓存。
fn video_lock(video_id: &str) -> Arc<AsyncMutex<()>> {
    static LOCKS: Lazy<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>> = Lazy::new(Default::default);
    let mut m = LOCKS.lock().unwrap();
    m.retain(|_, l| Arc::strong_count(l) > 1);
    m.entry(video_id.to_string())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

/// 原声音轨优先：yt-dlp 的 language_preference + format_note 里的 original/dubbed。
fn audio_rank(f: &Value) -> i64 {
    let note = f["format_note"].as_str().unwrap_or("").to_lowercase();
    f["language_preference"].as_i64().unwrap_or(0)
        + if note.contains("original") { 100 } else { 0 }
        - if note.contains("dubbed") { 100 } else { 0 }
}

fn pick_url(info: &Value, hls: bool) -> Result<String> {
    let formats = info["formats"].as_array().cloned().unwrap_or_default();
    if hls {
        if let Some(u) = formats
            .iter()
            .filter(|f| {
                f["protocol"]
                    .as_str()
                    .is_some_and(|p| p.starts_with("m3u8"))
            })
            .find_map(|f| f["manifest_url"].as_str())
        {
            return Ok(u.to_string());
        }
    }
    // progressive：同封装音视频的 https（常见 format 18 / 更高）；优先原声、mp4、更高分辨率
    formats
        .iter()
        .rev()
        .filter(|f| {
            f["vcodec"].as_str().is_some_and(|v| v != "none")
                && f["acodec"].as_str().is_some_and(|a| a != "none")
                && f["protocol"].as_str() == Some("https")
        })
        .max_by_key(|f| {
            (
                audio_rank(f),
                f["ext"].as_str() == Some("mp4"),
                f["height"].as_i64().unwrap_or(0),
            )
        })
        .and_then(|f| f["url"].as_str().map(str::to_string))
        .ok_or_else(|| anyhow!("这个视频没有可直接播放的格式"))
}

async fn stream_once(ytdlp: &Path, video_id: &str, hls: bool, extra: &[String]) -> Result<String> {
    crate::ytdlp::warm_ytdlp(ytdlp).await;
    let mut cmd = crate::ytdlp::ytdlp_command(ytdlp);
    cmd.args(["-j", "--no-playlist", "--no-warnings"])
        .args(extra)
        .arg(format!("https://www.youtube.com/watch?v={video_id}"));
    let out = tokio::time::timeout(std::time::Duration::from_secs(45), cmd.output())
        .await
        .map_err(|_| anyhow!("获取视频地址超时"))?
        .context("无法启动 yt-dlp")?;
    let info: Value = serde_json::from_slice(&out.stdout).map_err(|_| {
        let err = String::from_utf8_lossy(&out.stderr);
        anyhow!(
            "无法获取视频地址：{}",
            err.lines()
                .last()
                .unwrap_or("")
                .chars()
                .take(200)
                .collect::<String>()
        )
    })?;
    if let Some(d) = info["duration"].as_f64().filter(|d| *d > 0.0) {
        DURATIONS.lock().unwrap().insert(video_id.to_string(), d);
    }
    pick_url(&info, hls)
}

/// 解析可播地址。`hls=true` 时优先 m3u8 manifest；否则取最高 progressive mp4。
/// `fresh` 跳过缓存。调用方应已持有 per-video 锁或经 [`resolve`] 包装。
pub async fn youtube_stream_url(
    ytdlp: &Path,
    video_id: &str,
    hls: bool,
    fresh: bool,
) -> Result<String> {
    let key = format!("{video_id}|{hls}");
    if !fresh {
        if let Some(url) = cache::get(&key) {
            return Ok(url);
        }
    }
    let url = crate::ytdlp::with_bot_fallback(|extra| {
        let ytdlp = ytdlp.to_path_buf();
        let video_id = video_id.to_string();
        async move { stream_once(&ytdlp, &video_id, hls, &extra).await }
    })
    .await?;
    cache::put(&key, &url);
    Ok(url)
}

/// 带 per-video 锁与 60s 总超时的解析入口（命令层用）。
pub async fn resolve(
    data: &Path,
    video_id: &str,
    hls: bool,
    fresh: bool,
) -> Result<String> {
    cache::init(data);
    let lock = video_lock(video_id);
    tokio::time::timeout(std::time::Duration::from_secs(60), async {
        let _one = lock.lock().await;
        let bin = crate::ytdlp::ensure_ytdlp(data).await?;
        youtube_stream_url(&bin, video_id, hls, fresh).await
    })
    .await
    .map_err(|_| anyhow!("获取视频地址超时，请检查网络或代理"))?
}

/// 预热 yt-dlp（首次回退前避免临时下载二进制）。
pub async fn prepare(data: &Path) -> Result<()> {
    cache::init(data);
    let bin = crate::ytdlp::ensure_ytdlp(data).await?;
    crate::ytdlp::warm_ytdlp(&bin).await;
    Ok(())
}

/// 地址是否像 HLS（manifest）。
pub fn looks_hls(url: &str) -> bool {
    url.contains("m3u8") || url.contains("/manifest/hls")
}
