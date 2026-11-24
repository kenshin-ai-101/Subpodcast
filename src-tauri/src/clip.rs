/**
 * [INPUT]: 本地文件或 HTTP Range URL；asr::Resampler / write_wav
 * [OUTPUT]: data/clips/ 下 16kHz mono WAV（句段前后留白 + 淡入淡出）
 * [POS]: 英语学习模式「原声剪辑」；键 = sha1(episodeId|start|end)
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use crate::asr::Resampler;
use anyhow::{anyhow, bail, Context, Result};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, SeekMode, SeekTo};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

/// 句首前留白（秒），避免首词被切掉。
const PAD_BEFORE: f64 = 0.25;
/// 句末后留白（秒）。
const PAD_AFTER: f64 = 0.35;
/// 单句上限；更长视为时间戳异常。
const MAX_SENTENCE: f64 = 40.0;
const SAMPLE_RATE: u32 = 16_000;
/// HTTP Range 分片大小。
const RANGE_CHUNK: u64 = 96 * 1024;

/// 进程内累计 Range 拉取字节（单测可读）。
pub static BYTES_FETCHED: AtomicU64 = AtomicU64::new(0);

pub fn clips_dir(data: &Path) -> PathBuf {
    data.join("clips")
}

/// 剪辑落盘路径（是否已生成无关）。
pub fn path_for(data: &Path, episode_id: &str, start: f64, end: f64) -> PathBuf {
    let raw = format!("{episode_id}|{start:.2}|{end:.2}");
    let digest = Sha1::digest(raw.as_bytes());
    let stem: String = digest.iter().take(10).map(|b| format!("{b:02x}")).collect();
    clips_dir(data).join(format!("{stem}.wav"))
}

pub enum Source {
    File(PathBuf),
    Url(String),
}

/// 已有则直接返回；否则截取并原子写入。
pub async fn make(
    data: &Path,
    source: Source,
    episode_id: &str,
    start: f64,
    end: f64,
) -> Result<PathBuf> {
    let dest = path_for(data, episode_id, start, end);
    if dest.exists() {
        return Ok(dest);
    }
    if !(end > start) || end - start > MAX_SENTENCE {
        bail!("这一句的时间不对");
    }
    std::fs::create_dir_all(clips_dir(data))?;
    let handle = tokio::runtime::Handle::current();
    let pcm = tokio::task::spawn_blocking(move || -> Result<Vec<f32>> {
        match source {
            Source::File(path) => {
                let hint = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(str::to_string);
                let file = std::fs::File::open(&path)?;
                extract(Box::new(file), hint.as_deref(), start, end)
            }
            Source::Url(url) => {
                let hint = url_ext(&url);
                let ranged = RangeReader::connect(handle, url)?;
                extract(Box::new(ranged), hint.as_deref(), start, end)
            }
        }
    })
    .await??;

    // 至少约 0.1s，过短视为截空。
    if pcm.len() < (SAMPLE_RATE as usize) / 10 {
        bail!("没有截到声音");
    }
    let key = dest.to_string_lossy().into_owned();
    let lock = {
        static CLIP_LOCKS: once_cell::sync::Lazy<
            std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>,
        > = once_cell::sync::Lazy::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
        let mut map = CLIP_LOCKS.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(key)
            .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let _guard = lock.lock().await;
    if dest.exists() {
        return Ok(dest);
    }
    let part = dest.with_extension(format!("{}.part", uuid::Uuid::new_v4().simple()));
    if let Err(err) = crate::asr::write_wav(&part, &pcm) {
        let _ = std::fs::remove_file(&part);
        return Err(err);
    }
    if let Err(err) = std::fs::rename(&part, &dest) {
        let _ = std::fs::remove_file(&part);
        return Err(err.into());
    }
    Ok(dest)
}

fn url_ext(url: &str) -> Option<String> {
    if url.contains("googlevideo.com") {
        return Some("mp4".into());
    }
    let path = url.split(['?', '#']).next()?;
    let name = path.rsplit('/').next()?;
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    if ext.len() <= 4 && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        Some(ext)
    } else {
        None
    }
}

/// 精确截取 `[start, end]` 为 16kHz 单声道 PCM（无留白/淡入淡出，供字幕语音探针对齐复用）。
pub fn extract_raw(
    src: Box<dyn MediaSource>,
    ext: Option<&str>,
    start: f64,
    end: f64,
) -> Result<Vec<f32>> {
    extract_window(src, ext, start.max(0.0), end, false)
}

/// 解第一音轨，取 `[start-PAD_BEFORE, end+PAD_AFTER]`，混成 16k mono。
fn extract(
    src: Box<dyn MediaSource>,
    ext: Option<&str>,
    start: f64,
    end: f64,
) -> Result<Vec<f32>> {
    extract_window(src, ext, (start - PAD_BEFORE).max(0.0), end + PAD_AFTER, true)
}

fn extract_window(
    src: Box<dyn MediaSource>,
    ext: Option<&str>,
    from: f64,
    to: f64,
    apply_fade: bool,
) -> Result<Vec<f32>> {
    let stream = MediaSourceStream::new(src, Default::default());
    let mut hint = Hint::new();
    if let Some(e) = ext {
        hint.with_extension(e);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|err| anyhow!("无法识别音频格式：{err}"))?;
    let mut fmt = probed.format;
    let track = fmt
        .tracks()
        .iter()
        .find(|t| {
            t.codec_params.codec != CODEC_TYPE_NULL && t.codec_params.sample_rate.is_some()
        })
        .ok_or_else(|| anyhow!("没有音轨"))?;
    let track_id = track.id;
    let rate = track.codec_params.sample_rate.unwrap_or(44_100);
    let time_base = track.codec_params.time_base;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|err| anyhow!("不支持的音频编码：{err}"))?;

    if from > 1.0 {
        let t = Time::new(from.floor() as u64, from.fract());
        fmt.seek(
            SeekMode::Coarse,
            SeekTo::Time {
                time: t,
                track_id: Some(track_id),
            },
        )
        .map_err(|err| anyhow!("这个音频不能跳转：{err}"))?;
        decoder.reset();
    }

    let ts_secs = |ts: u64| match time_base {
        Some(tb) => {
            let t = tb.calc_time(ts);
            t.seconds as f64 + t.frac
        }
        None => ts as f64 / rate as f64,
    };

    let mut resample = Resampler::new(rate, SAMPLE_RATE);
    let mut buf: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match fmt.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(io)) if io.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => break,
            Err(err) => return Err(anyhow!("读取音频失败：{err}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let t0 = ts_secs(packet.ts());
        if t0 > to {
            break;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymError::DecodeError(_)) => continue,
            Err(err) => return Err(anyhow!("解码失败：{err}")),
        };
        let spec = *decoded.spec();
        let ch = spec.channels.count().max(1);
        if buf
            .as_ref()
            .is_none_or(|b| b.capacity() < decoded.capacity() * ch)
        {
            buf = Some(SampleBuffer::new(decoded.capacity() as u64, spec));
        }
        let slot = buf.as_mut().unwrap();
        slot.copy_interleaved_ref(decoded);
        for (i, frame) in slot.samples().chunks(ch).enumerate() {
            let t = t0 + i as f64 / spec.rate as f64;
            if t >= from && t <= to {
                let mono = frame.iter().sum::<f32>() / ch as f32;
                resample.push(mono);
            }
        }
    }

    let mut out = resample.finish();
    if apply_fade {
        // ~20ms 淡入淡出，避免咔哒声。
        let fade = ((SAMPLE_RATE as usize) / 50).min(out.len() / 2);
        let n = out.len();
        for i in 0..fade {
            let g = i as f32 / fade as f32;
            out[i] *= g;
            out[n - 1 - i] *= g;
        }
    }
    Ok(out)
}

/// 经 HTTP Range 按 96KB 分片读远程音频；跟随重定向后的落地 URL。
struct RangeReader {
    rt: tokio::runtime::Handle,
    url: String,
    len: u64,
    pos: u64,
    cache: HashMap<u64, Vec<u8>>,
}

impl RangeReader {
    fn connect(rt: tokio::runtime::Handle, url: String) -> Result<Self> {
        let mut me = Self {
            rt,
            url,
            len: 0,
            pos: 0,
            cache: HashMap::new(),
        };
        let (bytes, total, landed) = me.pull(0, RANGE_CHUNK - 1)?;
        me.len = total.ok_or_else(|| anyhow!("这个音频地址不支持分段读取"))?;
        me.url = landed;
        me.cache.insert(0, bytes);
        Ok(me)
    }

    fn pull(&self, from: u64, to: u64) -> Result<(Vec<u8>, Option<u64>, String)> {
        let url = self.url.clone();
        self.rt.block_on(async move {
            let mut last = None;
            for attempt in 0..3u64 {
                if attempt > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(300 * attempt)).await;
                }
                let res = crate::net::client()
                    .get(&url)
                    .header(reqwest::header::RANGE, format!("bytes={from}-{to}"))
                    .timeout(std::time::Duration::from_secs(20))
                    .send()
                    .await;
                match res {
                    Ok(r) if r.status().as_u16() == 206 => {
                        let landed = r.url().to_string();
                        let total = r
                            .headers()
                            .get(reqwest::header::CONTENT_RANGE)
                            .and_then(|v| v.to_str().ok())
                            .and_then(|v| v.rsplit('/').next())
                            .and_then(|v| v.trim().parse::<u64>().ok());
                        let bytes = r.bytes().await.context("读取音频失败")?.to_vec();
                        BYTES_FETCHED.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                        return Ok((bytes, total, landed));
                    }
                    Ok(r) if r.status().is_server_error() || r.status().as_u16() == 429 => {
                        last = Some(anyhow!("音频地址返回 {}", r.status().as_u16()));
                    }
                    Ok(r) => bail!("这个音频地址不支持分段读取（{}）", r.status().as_u16()),
                    Err(err) => last = Some(err.into()),
                }
            }
            Err(last.unwrap_or_else(|| anyhow!("读取音频失败")))
        })
    }

    fn ensure_chunk(&mut self, index: u64) -> std::io::Result<&Vec<u8>> {
        if !self.cache.contains_key(&index) {
            // 预取下一块，摊平延迟。
            let need: Vec<u64> = [index, index + 1]
                .into_iter()
                .filter(|j| j * RANGE_CHUNK < self.len && !self.cache.contains_key(j))
                .collect();
            let jobs: Vec<_> = need
                .iter()
                .map(|&j| {
                    let worker = Self {
                        rt: self.rt.clone(),
                        url: self.url.clone(),
                        len: self.len,
                        pos: 0,
                        cache: HashMap::new(),
                    };
                    std::thread::spawn(move || {
                        let a = j * RANGE_CHUNK;
                        let b = (a + RANGE_CHUNK).min(worker.len) - 1;
                        worker.pull(a, b).map(|r| (j, r.0))
                    })
                })
                .collect();
            let mut fail: Option<String> = None;
            for job in jobs {
                match job.join() {
                    Ok(Ok((j, bytes))) => {
                        self.cache.insert(j, bytes);
                    }
                    Ok(Err(err)) => {
                        fail.get_or_insert(err.to_string());
                    }
                    Err(_) => {
                        fail.get_or_insert("读取音频失败".into());
                    }
                }
            }
            if !self.cache.contains_key(&index) {
                return Err(std::io::Error::other(fail.unwrap_or_default()));
            }
        }
        Ok(&self.cache[&index])
    }
}

impl Read for RangeReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.len || buf.is_empty() {
            return Ok(0);
        }
        let index = self.pos / RANGE_CHUNK;
        let offset = (self.pos - index * RANGE_CHUNK) as usize;
        let chunk = self.ensure_chunk(index)?;
        if offset >= chunk.len() {
            return Ok(0);
        }
        let n = (chunk.len() - offset).min(buf.len());
        buf[..n].copy_from_slice(&chunk[offset..offset + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for RangeReader {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        let next = match pos {
            SeekFrom::Start(p) => p as i128,
            SeekFrom::End(d) => self.len as i128 + d as i128,
            SeekFrom::Current(d) => self.pos as i128 + d as i128,
        };
        if next < 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "seek before start",
            ));
        }
        self.pos = next as u64;
        Ok(self.pos)
    }
}

impl MediaSource for RangeReader {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        Some(self.len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_key_and_url_hint() {
        let root = Path::new("/tmp/subpodcast-clip");
        assert_eq!(
            path_for(root, "ep", 1.0, 2.0),
            path_for(root, "ep", 1.001, 2.004)
        );
        assert_ne!(
            path_for(root, "ep", 1.0, 2.0),
            path_for(root, "ep", 1.0, 2.5)
        );
        assert_eq!(
            url_ext("https://cdn.example/a/b.MP3?x=1").as_deref(),
            Some("mp3")
        );
        assert_eq!(
            url_ext("https://rr1.googlevideo.com/videoplayback?id=1").as_deref(),
            Some("mp4")
        );
        assert_eq!(url_ext("https://cdn.example/feed/episode"), None);
    }
}
