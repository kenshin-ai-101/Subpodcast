/**
 * [INPUT]: 依赖 ytdlp（ensure / ytdlp_command / with_bot_fallback 解析直链）、net::client（HTTP Range）、ffmpeg::mux_copy（拼音画）
 * [OUTPUT]: warm（预解析直链）、fetch_section（只下覆盖这一段的分片 → 输出文件，返回 lead）；parse_index / covering（sidx 纯函数）
 * [POS]: videoclip 的快速取段路径。YouTube 每档画质是一条带 sidx 索引的分段 MP4：读索引、只取需要的字节、
 *        8 路并发 Range（单连接几 MB 后会被限到播放速率）。任何失败都交回 mod.rs 退到 yt-dlp --download-sections
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use super::ffmpeg;
use anyhow::{anyhow, bail, Context, Result};
use futures_util::{stream, StreamExt, TryStreamExt};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

const CONNECTIONS: usize = 8;
const CHUNK: u64 = 1 << 20;
const MAX_HEIGHT: u64 = 1080;
/// 索引头部最多读这么多；更大视为没有可用索引。
const HEAD_CAP: u64 = 16 << 20;

// ============================================================================
// sidx 索引
// ============================================================================

#[derive(Debug, Clone, PartialEq)]
pub struct Fragment {
    pub offset: u64,
    pub size: u64,
    pub start: f64,
    pub dur: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Index {
    /// ftyp + moov 的长度：拼回分片前的初始化段。
    pub init_len: u64,
    pub fragments: Vec<Fragment>,
}

#[derive(Debug, PartialEq)]
pub enum Parse {
    /// 头部不够长，至少要读到这么多字节。
    Need(u64),
    /// 不是带单层 sidx 的分段 MP4。
    Invalid,
}

fn be(b: &[u8], at: usize, n: usize) -> Option<u64> {
    b.get(at..at + n).map(|s| s.iter().fold(0u64, |acc, &x| acc << 8 | x as u64))
}

/// 顺着顶层 box 走到 sidx；moov 必须在它之前（否则拼不出可播放的初始化段）。
pub fn parse_index(head: &[u8]) -> Result<Index, Parse> {
    let mut at = 0u64;
    let mut init_len = None;
    loop {
        let p = at as usize;
        let more = Parse::Need(at + 16 + 4096);
        let (Some(size32), Some(kind)) = (be(head, p, 4), head.get(p + 4..p + 8)) else {
            return Err(more);
        };
        let (size, hdr) = match size32 {
            0 => return Err(Parse::Invalid),
            1 => (be(head, p + 8, 8).ok_or(more)?, 16u64),
            n => (n, 8u64),
        };
        if size < hdr {
            return Err(Parse::Invalid);
        }
        let end = at + size;
        match kind {
            b"moov" => init_len = Some(end),
            b"sidx" => {
                let body = head.get(p + hdr as usize..end as usize).ok_or(Parse::Need(end))?;
                let init_len = init_len.ok_or(Parse::Invalid)?;
                let fragments = read_sidx(body, end).ok_or(Parse::Invalid)?;
                return Ok(Index { init_len, fragments });
            }
            b"moof" | b"mdat" => return Err(Parse::Invalid),
            _ => {}
        }
        at = end;
    }
}

/// 分片偏移以 sidx 之后第一个字节为锚。引用子索引（层级 sidx）的不处理。
fn read_sidx(body: &[u8], anchor: u64) -> Option<Vec<Fragment>> {
    let version = *body.first()?;
    let timescale = be(body, 8, 4)? as f64;
    if timescale <= 0.0 {
        return None;
    }
    let (earliest, first_offset, mut p) = if version == 0 {
        (be(body, 12, 4)?, be(body, 16, 4)?, 20)
    } else {
        (be(body, 12, 8)?, be(body, 20, 8)?, 28)
    };
    let count = be(body, p + 2, 2)? as usize;
    p += 4;
    let mut offset = anchor + first_offset;
    let mut t = earliest as f64 / timescale;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let word = be(body, p, 4)?;
        if word >> 31 == 1 {
            return None;
        }
        let size = word & 0x7fff_ffff;
        let dur = be(body, p + 4, 4)? as f64 / timescale;
        out.push(Fragment { offset, size, start: t, dur });
        offset += size;
        t += dur;
        p += 12;
    }
    (!out.is_empty()).then_some(out)
}

/// 覆盖 `[start, end]` 的连续分片（首片起点 ≤ start，末片终点 ≥ end）。
pub fn covering(frs: &[Fragment], start: f64, end: f64) -> &[Fragment] {
    const EPS: f64 = 1e-3;
    if frs.is_empty() {
        return &[];
    }
    let first = frs.partition_point(|f| f.start <= start + EPS).saturating_sub(1);
    let last = frs
        .partition_point(|f| f.start + f.dur < end - EPS)
        .min(frs.len() - 1);
    if last < first {
        &[]
    } else {
        &frs[first..=last]
    }
}

// ============================================================================
// 直链解析（进程内缓存到 expire）
// ============================================================================

#[derive(Clone)]
struct Streams {
    video: String,
    audio: String,
    /// 直链与 yt-dlp 伪装的客户端绑定；只带描述媒体请求本身的 Origin / Referer。
    headers: Vec<(String, String)>,
    expires: u64,
}

static RESOLVED: Lazy<Mutex<HashMap<String, Streams>>> = Lazy::new(Default::default);

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn expire_of(url: &str) -> Option<u64> {
    url.split(['?', '&'])
        .find_map(|kv| kv.strip_prefix("expire="))
        .and_then(|v| v.parse().ok())
}

fn forget(video_id: &str) {
    RESOLVED.lock().unwrap().remove(video_id);
}

fn pick_streams(info: &serde_json::Value) -> Result<Streams> {
    let formats = info["formats"].as_array().map(Vec::as_slice).unwrap_or_default();
    let direct = formats
        .iter()
        .filter(|f| f["protocol"].as_str() == Some("https") && f["url"].is_string());
    let codec = |f: &serde_json::Value, k: &str| f[k].as_str().unwrap_or("").to_string();
    let vf = direct
        .clone()
        .filter(|f| codec(f, "vcodec").starts_with("avc1") && codec(f, "acodec") == "none")
        .filter(|f| f["height"].as_u64().is_some_and(|h| h <= MAX_HEIGHT))
        .max_by_key(|f| {
            (f["height"].as_u64().unwrap_or(0), (f["tbr"].as_f64().unwrap_or(0.0) * 10.0) as u64)
        })
        .ok_or_else(|| anyhow!("这个视频没有可分段下载的 H.264 画面"))?;
    let af = direct
        .filter(|f| codec(f, "acodec").starts_with("mp4a") && codec(f, "vcodec") == "none")
        .max_by_key(|f| (f["abr"].as_f64().unwrap_or(0.0) * 10.0) as u64)
        .ok_or_else(|| anyhow!("这个视频没有可分段下载的音频"))?;
    let video = codec(vf, "url");
    let audio = codec(af, "url");
    let headers = vf["http_headers"]
        .as_object()
        .map(|m| {
            m.iter()
                .filter(|(k, _)| k.eq_ignore_ascii_case("origin") || k.eq_ignore_ascii_case("referer"))
                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let expires = expire_of(&video)
        .into_iter()
        .chain(expire_of(&audio))
        .min()
        .unwrap_or(now_secs() + 3 * 3600);
    Ok(Streams { video, audio, headers, expires })
}

/// 同一视频同时只跑一次 yt-dlp：预热与真正下载撞在一起时共享结果。
async fn resolve(ytdlp: &Path, video_id: &str) -> Result<Streams> {
    let lock = super::keyed_lock(&format!("resolve:{video_id}"));
    let _held = lock.lock().await;
    if let Some(s) = RESOLVED.lock().unwrap().get(video_id).cloned() {
        if s.expires > now_secs() + 300 {
            return Ok(s);
        }
    }
    let url = format!("https://www.youtube.com/watch?v={video_id}");
    let info: serde_json::Value = crate::ytdlp::with_bot_fallback(|extra| {
        let url = url.clone();
        async move {
            let mut cmd = crate::ytdlp::ytdlp_command(ytdlp);
            cmd.args(["-j", "--no-playlist", "--no-warnings"]).args(&extra).arg(&url);
            let out = tokio::time::timeout(Duration::from_secs(90), cmd.output())
                .await
                .map_err(|_| anyhow!("解析视频地址超时"))?
                .context("无法启动 yt-dlp")?;
            serde_json::from_slice(&out.stdout).map_err(|_| {
                let err = String::from_utf8_lossy(&out.stderr);
                anyhow!(
                    "无法解析视频地址：{}",
                    err.lines().last().unwrap_or("").chars().take(200).collect::<String>()
                )
            })
        }
    })
    .await?;
    let streams = pick_streams(&info)?;
    RESOLVED.lock().unwrap().insert(video_id.to_string(), streams.clone());
    Ok(streams)
}

/// 提前解析直链（首次约 30 秒），之后切片只剩下载。
pub async fn warm(data: &Path, video_id: &str) -> Result<()> {
    let ytdlp = crate::ytdlp::ensure_ytdlp(data).await?;
    resolve(&ytdlp, video_id).await.map(|_| ())
}

// ============================================================================
// Range 下载
// ============================================================================

/// 直链 403：YouTube 偶尔发出不能直接取的地址，重新解析一次再放弃。
#[derive(Debug)]
struct Stale;

impl std::fmt::Display for Stale {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("视频地址已失效")
    }
}

impl std::error::Error for Stale {}

async fn range(
    url: &str,
    headers: &[(String, String)],
    a: u64,
    b: u64,
    cancel: &AtomicBool,
) -> Result<Vec<u8>> {
    let want = b - a + 1;
    let mut failure = None;
    for attempt in 0..4u64 {
        if cancel.load(Ordering::Relaxed) {
            bail!("已取消");
        }
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(300 * attempt)).await;
        }
        let mut req = crate::net::client()
            .get(url)
            .header(reqwest::header::RANGE, format!("bytes={a}-{b}"))
            .timeout(Duration::from_secs(30));
        for (k, v) in headers {
            req = req.header(k.as_str(), v.as_str());
        }
        match req.send().await {
            Ok(r) if r.status().as_u16() == 403 => return Err(Stale.into()),
            Ok(r) if r.status().is_success() => match r.bytes().await {
                Ok(bytes) if bytes.len() as u64 == want => return Ok(bytes.to_vec()),
                Ok(bytes) => failure = Some(anyhow!("分片不完整（{} / {want}）", bytes.len())),
                Err(e) => failure = Some(anyhow!("下载中断：{e}")),
            },
            Ok(r) => failure = Some(anyhow!("请求失败（{}）", r.status().as_u16())),
            Err(e) => failure = Some(anyhow!("网络错误：{e}")),
        }
    }
    Err(failure.unwrap_or_else(|| anyhow!("下载失败")))
}

struct Tally {
    got: AtomicU64,
    total: AtomicU64,
}

/// 初始化段 + 覆盖 `[start, end]` 的分片写到 `out`（一个可播放的分段 MP4）；返回 `out` 在原视频里的起点。
async fn fetch_stretch(
    url: &str,
    headers: &[(String, String)],
    start: f64,
    end: f64,
    out: &Path,
    cancel: &AtomicBool,
    tally: &Tally,
) -> Result<f64> {
    let mut want = 256 * 1024u64;
    let (head, index) = loop {
        let head = range(url, headers, 0, want - 1, cancel).await?;
        match parse_index(&head) {
            Ok(ix) => break (head, ix),
            Err(Parse::Need(n)) if n > want && n <= HEAD_CAP => want = n,
            Err(_) => bail!("视频没有分段索引"),
        }
    };
    let frs = covering(&index.fragments, start, end);
    let (Some(first), Some(last)) = (frs.first(), frs.last()) else {
        bail!("索引里找不到这一段");
    };
    let (a, b) = (first.offset, last.offset + last.size - 1);
    tally.total.fetch_add(b - a + 1, Ordering::Relaxed);
    let spans: Vec<(u64, u64)> = (a..=b)
        .step_by(CHUNK as usize)
        .map(|s| (s, (s + CHUNK - 1).min(b)))
        .collect();
    let mut parts: Vec<(u64, Vec<u8>)> = stream::iter(spans)
        .map(|(s, e)| async move {
            let bytes = range(url, headers, s, e, cancel).await?;
            tally.got.fetch_add(bytes.len() as u64, Ordering::Relaxed);
            Ok::<_, anyhow::Error>((s, bytes))
        })
        .buffer_unordered(CONNECTIONS)
        .try_collect()
        .await?;
    parts.sort_unstable_by_key(|p| p.0);
    let init = head
        .get(..index.init_len as usize)
        .context("初始化段不完整")?;
    let mut file = Vec::with_capacity(init.len() + (b - a + 1) as usize);
    file.extend_from_slice(init);
    for (_, p) in parts {
        file.extend_from_slice(&p);
    }
    tokio::fs::write(out, file).await?;
    Ok(first.start)
}

// ============================================================================
// 对外
// ============================================================================

/// `[start, end]` 写到 `out`：画面从 start 之前的关键帧原样拷贝。返回 lead（片段正文在文件里的起点）。
#[allow(clippy::too_many_arguments)]
pub async fn fetch_section(
    data: &Path,
    ytdlp: &Path,
    ffmpeg_bin: &Path,
    video_id: &str,
    start: f64,
    end: f64,
    out: &Path,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(f64, &str),
) -> Result<f64> {
    let first = fetch_once(data, ytdlp, ffmpeg_bin, video_id, start, end, out, cancel, &mut on_progress).await;
    let res = match first {
        Err(e) if e.is::<Stale>() && !cancel.load(Ordering::Relaxed) => {
            forget(video_id);
            fetch_once(data, ytdlp, ffmpeg_bin, video_id, start, end, out, cancel, &mut on_progress).await
        }
        r => r,
    };
    if res.is_err() && !cancel.load(Ordering::Relaxed) {
        forget(video_id);
    }
    res
}

#[allow(clippy::too_many_arguments)]
async fn fetch_once(
    data: &Path,
    ytdlp: &Path,
    ffmpeg_bin: &Path,
    video_id: &str,
    start: f64,
    end: f64,
    out: &Path,
    cancel: &AtomicBool,
    on_progress: &mut impl FnMut(f64, &str),
) -> Result<f64> {
    // 进度分段：解析 0–30%（首次可能半分钟，用渐近曲线不让进度条停住）、下载 30–88%、拼装 92%。
    let streams = {
        let fut = resolve(ytdlp, video_id);
        tokio::pin!(fut);
        let began = std::time::Instant::now();
        loop {
            tokio::select! {
                r = &mut fut => break r?,
                _ = tokio::time::sleep(Duration::from_millis(300)) => {
                    if cancel.load(Ordering::Relaxed) {
                        bail!("已取消");
                    }
                    let t = began.elapsed().as_secs_f64();
                    on_progress(0.3 * (1.0 - (-t / 14.0).exp()), "第一次剪这个视频，正在解析视频地址…");
                }
            }
        }
    };
    let work = data.join("work").join(format!("fast-{}", uuid::Uuid::new_v4().simple()));
    tokio::fs::create_dir_all(&work).await?;
    let res = async {
        let (vp, ap) = (work.join("v.mp4"), work.join("a.m4a"));
        let tally = Tally { got: AtomicU64::new(0), total: AtomicU64::new(0) };
        let done = AtomicBool::new(false);
        let fetch = async {
            let r = tokio::try_join!(
                fetch_stretch(&streams.video, &streams.headers, start, end, &vp, cancel, &tally),
                fetch_stretch(&streams.audio, &streams.headers, start, end, &ap, cancel, &tally),
            );
            done.store(true, Ordering::Relaxed);
            r
        };
        let report = async {
            while !done.load(Ordering::Relaxed) {
                let got = tally.got.load(Ordering::Relaxed) as f64;
                let total = tally.total.load(Ordering::Relaxed).max(1) as f64;
                on_progress(0.3 + (got / total).min(1.0) * 0.58, "正在下载这一段画面…");
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        };
        let (fetched, ()) = tokio::join!(fetch, report);
        let (v0, a0) = fetched?;
        on_progress(0.92, "正在合成片段…");
        ffmpeg::mux_copy(ffmpeg_bin, &vp, v0, &ap, a0, end, out, cancel).await?;
        Ok((start - v0).max(0.0))
    }
    .await;
    let _ = tokio::fs::remove_dir_all(&work).await;
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boxed(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut b = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        b.extend_from_slice(kind);
        b.extend_from_slice(body);
        b
    }

    fn sidx_v0(timescale: u32, refs: &[(u32, u32)]) -> Vec<u8> {
        let mut body = vec![0u8; 4];
        body.extend(1u32.to_be_bytes());
        body.extend(timescale.to_be_bytes());
        body.extend(0u32.to_be_bytes());
        body.extend(0u32.to_be_bytes());
        body.extend(0u16.to_be_bytes());
        body.extend((refs.len() as u16).to_be_bytes());
        for &(size, dur) in refs {
            body.extend(size.to_be_bytes());
            body.extend(dur.to_be_bytes());
            body.extend(0x9000_0000u32.to_be_bytes());
        }
        boxed(b"sidx", &body)
    }

    #[test]
    fn index_then_covering_fragments() {
        let mut head = boxed(b"ftyp", &[0; 16]);
        head.extend(boxed(b"moov", &[0; 100]));
        let init_len = head.len() as u64;
        let s = sidx_v0(1000, &[(500, 5000), (600, 5000), (700, 5000), (800, 5000)]);
        let anchor = init_len + s.len() as u64;
        head.extend(s);

        let ix = parse_index(&head).unwrap();
        assert_eq!(ix.init_len, init_len);
        assert_eq!(ix.fragments.len(), 4);
        assert_eq!(
            ix.fragments[2],
            Fragment { offset: anchor + 1100, size: 700, start: 10.0, dur: 5.0 }
        );

        let c = covering(&ix.fragments, 7.0, 12.0);
        assert_eq!((c.len(), c[0].start), (2, 5.0));
        assert_eq!(covering(&ix.fragments, 0.0, 20.0).len(), 4);
        assert_eq!(covering(&ix.fragments, 10.0, 10.5)[0].start, 10.0);

        assert!(matches!(parse_index(&head[..head.len() - 10]), Err(Parse::Need(_))));
        assert_eq!(parse_index(&boxed(b"moof", &[0; 8])), Err(Parse::Invalid));
    }

    #[test]
    fn expiry_from_googlevideo_url() {
        let u = "https://rr1.googlevideo.com/videoplayback?expire=1700000000&ei=x";
        assert_eq!(expire_of(u), Some(1_700_000_000));
        assert_eq!(expire_of("https://example.com/a.mp4"), None);
    }
}
