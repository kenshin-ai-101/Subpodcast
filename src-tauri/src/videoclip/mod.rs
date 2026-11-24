/**
 * [INPUT]: 依赖 ytdlp（ensure / ytdlp_command / with_bot_fallback）与子模块 ffmpeg / fastclip / inspect / render
 * [OUTPUT]: 命令契约 FfmpegStatus / PreparedClip / CueOverlay / Frame / RenderRequest / RenderResult；
 *           env_status、warm、prepare_segment、prepare_montage、render（re-export）
 * [POS]: 「高光」视频切片管线的编排层：取段（缓存 → 覆盖缓存截取 → 快速分片 → yt-dlp 兜底）→ 体检 → 交给 render 合成；
 *        缓存目录 <data>/work/clips/<video_id>/，文件名 <起ms>-<止ms>.mp4，旁路 .lead / .meta.json / .frames.json
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
mod fastclip;
mod ffmpeg;
mod inspect;
mod render;

pub use render::render;

use anyhow::{anyhow, bail, Context, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, BufReader};

// ============================================================================
// 命令契约（camelCase JSON）
// ============================================================================

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatus {
    pub installed: bool,
    pub path: Option<String>,
    pub hardware_h264: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreparedClip {
    pub path: String,
    /// 片段正文时长（文件可能从 lead 秒前的关键帧开始）。
    pub duration: f64,
    /// 文件里正文之前的秒数：快速取段从关键帧拷贝画面，导出时裁掉。
    pub lead: f64,
    pub width: u32,
    pub height: u32,
    pub has_burned_subtitles: bool,
    pub cached: bool,
    /// 候选封面帧（JPEG data URL）。
    pub frames: Vec<String>,
    pub best_frame: usize,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CueOverlay {
    pub start: f64,
    pub end: f64,
    pub y: i32,
    pub png_base64: String,
}

/// 输出画布与画面位置（对话框算好并按它画图层）。`fit`："fill" 铺满裁切（按 cropX 横移）；
/// "card" 放进 (vx, vy, vw, vh) 盒子，四周模糊或纯色背景。
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub w: u32,
    pub h: u32,
    pub fit: String,
    #[serde(default)]
    pub vx: u32,
    #[serde(default)]
    pub vy: u32,
    #[serde(default)]
    pub vw: u32,
    #[serde(default)]
    pub vh: u32,
    /// 仅 card：把画面裁成盒子比例（按 cropX 横移），而非完整缩进去。
    #[serde(default)]
    pub crop_box: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    #[serde(default)]
    pub frame: Option<Frame>,
    /// rawPath 开头要跳过的秒数（见 PreparedClip::lead）。
    #[serde(default)]
    pub lead: f64,
    /// 导出倍速 0.5–2；字幕时间已按倍速后的时钟给出。缺省为 1。
    #[serde(default)]
    pub speed: f64,
    /// 设置里的导出目录；为空或不存在时落到「下载」。
    #[serde(default)]
    pub output_dir: Option<String>,
    pub raw_path: String,
    #[serde(default)]
    pub output_path: Option<String>,
    pub default_name: String,
    pub layout: String,
    pub card_bg: String,
    pub crop_x: f64,
    pub duration: f64,
    #[serde(default)]
    pub static_overlay_png: Option<String>,
    #[serde(default)]
    pub cues: Vec<CueOverlay>,
    #[serde(default)]
    pub cover_png: Option<String>,
    /// "flash" | "hold" | "none"
    #[serde(default)]
    pub cover_mode: String,
    #[serde(default)]
    pub embed_thumbnail: bool,
    #[serde(default)]
    pub save_cover_sidecar: bool,
    #[serde(default)]
    pub landscape_cover_png: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RenderResult {
    pub video_path: String,
    pub cover_path: Option<String>,
    pub landscape_cover_path: Option<String>,
}

pub fn env_status(data: &Path) -> FfmpegStatus {
    ffmpeg::status(data)
}

// ============================================================================
// 缓存布局与互斥
// ============================================================================

/// 预取与用户点击撞上同一份文件时只做一次；按键（路径 / 视频）分锁。
fn keyed_lock(key: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: Lazy<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
        Lazy::new(Default::default);
    LOCKS.lock().unwrap().entry(key.to_string()).or_default().clone()
}

fn slug(video_id: &str) -> String {
    let s: String = video_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(64)
        .collect();
    if s.is_empty() { "clip".into() } else { s }
}

pub fn work_dir(data: &Path, video_id: &str) -> PathBuf {
    data.join("work").join("clips").join(slug(video_id))
}

fn ms(t: f64) -> u64 {
    (t.max(0.0) * 1000.0).round() as u64
}

fn usable(p: &Path) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.len() > 10_000)
}

fn read_lead(clip: &Path) -> f64 {
    std::fs::read_to_string(clip.with_extension("lead"))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0.0)
}

/// 临时文件就位成正式片段：先写好（或清掉）旁路，再 rename——只要 mp4 在，它的 lead 就是对的。
async fn commit(tmp: &Path, dest: &Path, lead: f64) -> Result<()> {
    for ext in ["meta.json", "frames.json"] {
        let _ = tokio::fs::remove_file(dest.with_extension(ext)).await;
    }
    let lead_file = dest.with_extension("lead");
    if lead > 0.0005 {
        tokio::fs::write(&lead_file, format!("{lead:.3}")).await?;
    } else {
        let _ = tokio::fs::remove_file(&lead_file).await;
    }
    tokio::fs::rename(tmp, dest).await.context("无法保存片段")
}

/// 已缓存、能完整覆盖 `[a, b]`（毫秒）的最短片段，返回 (路径, 起点毫秒)。
fn covering_cache(dir: &Path, a: u64, b: u64) -> Option<(PathBuf, u64)> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "mp4") && usable(p))
        .filter_map(|p| {
            let (s, e) = p.file_stem()?.to_str()?.split_once('-')?;
            let (s, e) = (s.parse::<u64>().ok()?, e.parse::<u64>().ok()?);
            (s <= a && e >= b).then_some((p, s, e - s))
        })
        .min_by_key(|(_, _, span)| *span)
        .map(|(p, s, _)| (p, s))
}

// ============================================================================
// 体检结果缓存
// ============================================================================

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetaCache {
    duration: f64,
    width: u32,
    height: u32,
    has_burned_subtitles: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FramesCache {
    frames: Vec<String>,
    best_frame: usize,
}

async fn read_json<T: for<'de> Deserialize<'de>>(p: &Path) -> Option<T> {
    serde_json::from_str(&tokio::fs::read_to_string(p).await.ok()?).ok()
}

async fn write_json<T: Serialize>(p: &Path, v: &T) {
    if let Ok(s) = serde_json::to_string(v) {
        let tmp = p.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
        if tokio::fs::write(&tmp, s).await.is_ok() {
            if tokio::fs::rename(&tmp, p).await.is_err() {
                let _ = tokio::fs::remove_file(&tmp).await;
            }
        }
    }
}

/// 片段文件 → PreparedClip：探测尺寸与时长、判硬字幕、抽候选封面，结果写旁路缓存。
/// `on_progress` 在锁外跑，占 [0.92, 0.99]，避免下载停在 55% 后直接「消失」。
async fn finish(
    bin: &Path,
    clip: &Path,
    expected: f64,
    cached: bool,
    mut on_progress: impl FnMut(&str, f64, &str),
) -> PreparedClip {
    on_progress("inspect", 0.92, "正在分析画面…");
    let lead = read_lead(clip);
    let meta_path = clip.with_extension("meta.json");
    let frames_path = clip.with_extension("frames.json");

    let meta = match read_json::<MetaCache>(&meta_path).await {
        Some(m) => m,
        None => {
            on_progress("inspect", 0.94, "正在检测字幕与画幅…");
            let probed = ffmpeg::probe(bin, clip).await;
            let duration = probed.map(|m| m.duration).unwrap_or(expected + lead);
            let m = MetaCache {
                duration,
                width: probed.map_or(1920, |m| m.width),
                height: probed.map_or(1080, |m| m.height),
                has_burned_subtitles: inspect::burned_subtitles(bin, clip, lead, duration - lead).await,
            };
            write_json(&meta_path, &m).await;
            m
        }
    };
    let span = (meta.duration - lead).max(0.1);
    let (frames, best_frame) = match read_json::<FramesCache>(&frames_path).await {
        Some(f) if !f.frames.is_empty() => {
            let best = f.best_frame.min(f.frames.len() - 1);
            (f.frames, best)
        }
        _ => {
            on_progress("inspect", 0.96, "正在提取封面剧照…");
            let (frames, best_frame) = inspect::candidate_frames(bin, clip, lead, span).await;
            if !frames.is_empty() {
                write_json(&frames_path, &FramesCache { frames: frames.clone(), best_frame }).await;
            }
            (frames, best_frame)
        }
    };
    on_progress("done", 1.0, if cached { "已复用缓存片段" } else { "片段已就绪" });
    PreparedClip {
        path: clip.to_string_lossy().into_owned(),
        duration: span,
        lead,
        width: meta.width,
        height: meta.height,
        has_burned_subtitles: meta.has_burned_subtitles,
        cached,
        frames,
        best_frame,
    }
}

// ============================================================================
// 取段
// ============================================================================

async fn ensure_ffmpeg(
    data: &Path,
    cancel: &AtomicBool,
    on_progress: &mut impl FnMut(&str, f64, &str),
) -> Result<PathBuf> {
    // 全程单调：ffmpeg ∈ [0.02, 0.08]，其后 download/trim 不得回跳。
    on_progress("ffmpeg", 0.02, "正在检查视频工具…");
    ffmpeg::ensure(data, cancel, |got, total| {
        let frac = total.map(|t| got as f64 / t.max(1) as f64).unwrap_or(0.5);
        on_progress(
            "ffmpeg",
            0.02 + frac.clamp(0.0, 1.0) * 0.06,
            "正在准备视频导出组件（首次使用需要下载）…",
        );
    })
    .await
}

/// 取 `video_id` 的 `[start, end]`（或复用缓存）。进度阶段：ffmpeg / download / trim / done。
///
/// 锁只保护「写入 dest」；`finish`（抽帧 / 硬字幕检测）在锁外做，
/// 否则后台 warm 抽帧会把用户点的 prepare 堵到永远完不成。
pub async fn prepare_segment(
    data: &Path,
    video_id: &str,
    start: f64,
    end: f64,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(&str, f64, &str),
) -> Result<PreparedClip> {
    let start = start.max(0.0);
    let span = end - start;
    if !(0.5..=900.0).contains(&span) {
        bail!("片段时间范围无效");
    }
    let (a, b) = (ms(start), ms(end));
    let dir = work_dir(data, video_id);
    tokio::fs::create_dir_all(&dir).await?;
    let dest = dir.join(format!("{a}-{b}.mp4"));
    let lock = keyed_lock(&dest.to_string_lossy());

    let (bin, cached) = {
        let _held = lock.lock().await;
        let bin = ensure_ffmpeg(data, cancel, &mut on_progress).await?;
        if usable(&dest) {
            (bin, true)
        } else {
            let tmp = dest.with_extension("part.mp4");
            if let Some((parent, from)) = covering_cache(&dir, a, b) {
                let ss = (a - from) as f64 / 1000.0 + read_lead(&parent);
                on_progress("trim", 0.20, "正在从缓存片段截取…");
                ffmpeg::normalize(&bin, &parent, &tmp, Some((ss, span)), span, cancel, |p| {
                    on_progress("trim", 0.20 + p * 0.70, "正在从缓存片段截取…")
                })
                .await?;
                commit(&tmp, &dest, 0.0).await?;
                (bin, true)
            } else {
                // download ∈ [0.10, 0.88]，trim ∈ [0.88, 0.92]，inspect ∈ [0.92, 1.0]
                on_progress("download", 0.10, "正在获取这一段原视频…");
                on_progress("download", 0.12, "正在准备下载组件…");
                let ytdlp = crate::ytdlp::ensure_ytdlp(data).await?;
                if cancel.load(Ordering::Relaxed) {
                    bail!("已取消");
                }
                on_progress("download", 0.14, "正在解析视频地址…");
                let fast =
                    fastclip::fetch_section(data, &ytdlp, &bin, video_id, start, end, &tmp, cancel, |p, m| {
                        on_progress("download", 0.14 + p.clamp(0.0, 1.0) * 0.74, m)
                    })
                    .await;
                match fast {
                    Ok(lead) => {
                        commit(&tmp, &dest, lead).await?;
                        (bin, false)
                    }
                    Err(e) if cancel.load(Ordering::Relaxed) => return Err(e),
                    Err(e) => {
                        eprintln!("Subpodcast: fast clip fetch failed, falling back to yt-dlp: {e}");
                        // 兜底从 0.55 续跑（前端 peak 保单调）；yt-dlp 期间用 select 心跳，避免卡在 55% 再突然结束。
                        on_progress("download", 0.55, "正在获取这一段原视频…");
                        let raw = {
                            let download =
                                ytdlp_section(&ytdlp, &bin, video_id, start, end, &dir, cancel);
                            tokio::pin!(download);
                            let began = std::time::Instant::now();
                            loop {
                                tokio::select! {
                                    r = &mut download => break r?,
                                    _ = tokio::time::sleep(std::time::Duration::from_millis(400)) => {
                                        if cancel.load(Ordering::Relaxed) {
                                            bail!("已取消");
                                        }
                                        let t = began.elapsed().as_secs_f64();
                                        let frac = (0.92 * (1.0 - (-t / 45.0).exp())).clamp(0.0, 0.92);
                                        on_progress(
                                            "download",
                                            0.55 + frac * 0.33,
                                            "正在获取这一段原视频…",
                                        );
                                    }
                                }
                            }
                        };
                        on_progress("trim", 0.88, "正在整理片段画面…");
                        let norm = ffmpeg::normalize(&bin, &raw, &tmp, None, span, cancel, |p| {
                            on_progress("trim", 0.88 + p * 0.04, "正在整理片段画面…")
                        })
                        .await;
                        let _ = tokio::fs::remove_file(&raw).await;
                        norm?;
                        commit(&tmp, &dest, 0.0).await?;
                        (bin, false)
                    }
                }
            }
        }
    };

    Ok(finish(&bin, &dest, span, cached, &mut on_progress).await)
}

/// 分片+音视频合并（优先 avc1，避免奇葩编码）。
const SECTION_FORMAT: &str = "bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/\
bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best";

/// 单文件渐进式：躲「ffmpeg exited with code 8」类合并失败（TLS IO 时不要优先走这条——仍是 ffmpeg 拉 HTTPS）。
const SECTION_FORMAT_PROGRESSIVE: &str =
    "best[height<=1080][ext=mp4]/best[height<=1080]/best[ext=mp4]/best";

fn section_err_tls(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("input/output error")
        || m.contains("error reading http")
        || m.contains("error opening input")
        || m.contains("tls")
        || m.contains("ssl")
        || m.contains("connection reset")
        || m.contains("timed out")
        || m.contains("timeout")
}

fn section_err_merge(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("exited with code 8")
        || m.contains("invalid data found")
        || m.contains("error reencoding")
        || m.contains("merge")
}

/// 兜底：yt-dlp `--download-sections` 取段。
/// - 不用 `--force-keyframes-at-cuts`（ffmpeg 7/8 常 exit 8）；精确裁切交给 `normalize`
/// - `--force-ipv4` + ffmpeg reconnect：躲开 googlevideo 上 ffmpeg TLS「Input/output error」
/// - TLS/IO → 换 player_client 再试；合并类失败 → progressive
async fn ytdlp_section(
    ytdlp: &Path,
    bin: &Path,
    video_id: &str,
    start: f64,
    end: f64,
    dir: &Path,
    cancel: &AtomicBool,
) -> Result<PathBuf> {
    crate::ytdlp::with_bot_fallback(|extra| async move {
        // 1) 默认合并  2) TLS 时换 android CDN  3) 合并失败再 progressive
        let plans: [(&str, Option<&[&str]>); 3] = [
            (SECTION_FORMAT, None),
            (
                SECTION_FORMAT,
                Some(&["--extractor-args", "youtube:player_client=android,web"]),
            ),
            (SECTION_FORMAT_PROGRESSIVE, None),
        ];
        let mut last_err: Option<anyhow::Error> = None;
        let mut skip_android = false;
        for (i, &(format, more)) in plans.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                bail!("已取消");
            }
            if i == 1 && skip_android {
                continue;
            }
            let mut args = extra.clone();
            if let Some(more) = more {
                args.extend(more.iter().map(|s| (*s).to_string()));
            }
            match ytdlp_section_once(ytdlp, bin, video_id, start, end, dir, cancel, &args, format)
                .await
            {
                Ok(p) => return Ok(p),
                Err(e) if cancel.load(Ordering::Relaxed) => return Err(e),
                Err(e) => {
                    let msg = e.to_string();
                    eprintln!("Subpodcast: yt-dlp section try#{i} ({format}) failed: {msg}");
                    if i == 0 && section_err_merge(&msg) && !section_err_tls(&msg) {
                        // 合并炸了：不必换 CDN，直接 progressive
                        skip_android = true;
                    }
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow!("获取视频片段失败")))
    })
    .await
}

#[allow(clippy::too_many_arguments)]
async fn ytdlp_section_once(
    ytdlp: &Path,
    bin: &Path,
    video_id: &str,
    start: f64,
    end: f64,
    dir: &Path,
    cancel: &AtomicBool,
    extra: &[String],
    format: &str,
) -> Result<PathBuf> {
    let tag = format!("raw-{}", uuid::Uuid::new_v4().simple());
    // yt-dlp 接受「二进制」或「所在目录」；传目录更稳（部分版本对带空格的绝对路径会踩坑）。
    let ffmpeg_loc = bin
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(bin);
    let mut cmd = crate::ytdlp::ytdlp_command(ytdlp);
    // googlevideo + ffmpeg TLS：IPv6 半开连接常报 Input/output error；强制 v4 + 断线重连。
    // DASH/HLS 尽量走 yt-dlp 原生分片（rustls/OpenSSL 栈），少让 ffmpeg 自己去拉 HTTPS。
    cmd.arg("--force-ipv4")
        .arg("--download-sections")
        .arg(format!("*{start:.2}-{end:.2}"))
        .arg("--ffmpeg-location")
        .arg(ffmpeg_loc)
        .args(["--downloader", "dash,m3u8:native"])
        .args(["--retries", "3", "--fragment-retries", "3"])
        .args([
            "--downloader-args",
            "ffmpeg:-reconnect 1 -reconnect_streamed 1 -reconnect_on_network_error 1 -rw_timeout 30000000 -timeout 30000000",
        ])
        .args(["-f", format, "--merge-output-format", "mp4", "--no-playlist", "--no-part"])
        .args(extra)
        .arg("-o")
        .arg(dir.join(format!("{tag}.%(ext)s")))
        .arg(format!("https://www.youtube.com/watch?v={video_id}"))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().context("无法启动 yt-dlp")?;
    let stderr = child.stderr.take();
    let tail = tokio::spawn(async move {
        // 留最后几行：ffmpeg 真因往往在 ERROR 上一行。
        let mut lines: Vec<String> = Vec::new();
        if let Some(s) = stderr {
            let mut rd = BufReader::new(s).lines();
            while let Ok(Some(l)) = rd.next_line().await {
                if !l.trim().is_empty() {
                    lines.push(l);
                    if lines.len() > 6 {
                        lines.remove(0);
                    }
                }
            }
        }
        lines.join(" | ")
    });
    let status = loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill().await;
            tail.abort();
            cleanup_tag_files(dir, &tag).await;
            bail!("已取消");
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    };
    let last = tail.await.unwrap_or_default();
    if !status.success() {
        cleanup_tag_files(dir, &tag).await;
        bail!("获取视频片段失败：{}", last.chars().take(240).collect::<String>());
    }
    let mut rd = tokio::fs::read_dir(dir).await?;
    while let Some(e) = rd.next_entry().await? {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with(&tag) && !name.ends_with(".part") {
            return Ok(e.path());
        }
    }
    cleanup_tag_files(dir, &tag).await;
    Err(anyhow!("没有找到下载的视频片段"))
}

async fn cleanup_tag_files(dir: &Path, tag: &str) {
    if let Ok(mut rd) = tokio::fs::read_dir(dir).await {
        while let Ok(Some(e)) = rd.next_entry().await {
            if e.file_name().to_string_lossy().starts_with(tag) {
                let _ = tokio::fs::remove_file(e.path()).await;
            }
        }
    }
}

/// 同一视频的几段按顺序拼成一条（蒙太奇）：每段单独取并缓存，再统一尺寸后一次编码。
pub async fn prepare_montage(
    data: &Path,
    video_id: &str,
    ranges: &[(f64, f64)],
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(&str, f64, &str),
) -> Result<PreparedClip> {
    if ranges.len() < 2 {
        bail!("片段时间范围无效");
    }
    let key: Vec<String> = ranges.iter().map(|&(a, b)| format!("{}-{}", ms(a), ms(b))).collect();
    let digest = hex::encode(Sha1::digest(key.join("_").as_bytes()));
    let dir = work_dir(data, video_id);
    tokio::fs::create_dir_all(&dir).await?;
    let dest = dir.join(format!("montage-{}.mp4", &digest[..12]));
    let lock = keyed_lock(&dest.to_string_lossy());
    let total: f64 = ranges.iter().map(|(a, b)| b - a).sum();

    // 各段 prepare_segment 自带路径锁；montage dest 锁只罩拼接写入，finish 放锁外。
    let (bin, cached) = {
        let _held = lock.lock().await;
        let bin = ensure_ffmpeg(data, cancel, &mut on_progress).await?;
        if usable(&dest) {
            (bin, true)
        } else {
            // 先放 montage 锁再取各段，避免与单段 prepare 互相嵌死。
            drop(_held);
            let n = ranges.len() as f64;
            let mut parts = Vec::with_capacity(ranges.len());
            for (k, &(a, b)) in ranges.iter().enumerate() {
                let base = k as f64 / n;
                let part = prepare_segment(data, video_id, a, b, cancel, |stage, p, m| {
                    if stage != "done" && stage != "inspect" {
                        // 单调：第 k 段占 [k/n, (k+1)/n) × 0.85
                        on_progress("download", (base + p.clamp(0.0, 1.0) / n) * 0.85, m);
                    }
                })
                .await?;
                parts.push(part);
            }

            let _held = lock.lock().await;
            if usable(&dest) {
                (bin, true)
            } else {
                on_progress("trim", 0.88, "正在拼接片段…");
                let (w, h) = (parts[0].width / 2 * 2, parts[0].height / 2 * 2);
                let mut graph = String::new();
                for k in 0..parts.len() {
                    graph += &format!(
                        "[{k}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v{k}];"
                    );
                }
                for k in 0..parts.len() {
                    graph += &format!("[v{k}][{k}:a]");
                }
                graph += &format!("concat=n={}:v=1:a=1[v][a]", parts.len());
                let tmp = dest.with_extension("part.mp4");
                ffmpeg::encode_h264(
                    &bin,
                    None,
                    &tmp,
                    total,
                    cancel,
                    |p| on_progress("trim", 0.88 + p * 0.04, "正在拼接片段…"),
                    |hw| {
                        let mut args: Vec<String> = vec!["-y".into()];
                        for p in &parts {
                            args.extend([
                                "-ss".into(),
                                format!("{:.3}", p.lead),
                                "-t".into(),
                                format!("{:.3}", p.duration),
                                "-i".into(),
                                p.path.clone(),
                            ]);
                        }
                        args.extend([
                            "-filter_complex".into(),
                            graph.clone(),
                            "-map".into(),
                            "[v]".into(),
                            "-map".into(),
                            "[a]".into(),
                        ]);
                        args.extend(ffmpeg::h264(hw, ":v", true));
                        args.extend([
                            "-c:a".into(),
                            "aac".into(),
                            "-b:a".into(),
                            "192k".into(),
                            "-movflags".into(),
                            "+faststart".into(),
                            tmp.to_string_lossy().into_owned(),
                        ]);
                        args
                    },
                )
                .await?;
                commit(&tmp, &dest, 0.0).await?;
                (bin, false)
            }
        }
    };

    Ok(finish(&bin, &dest, total, cached, &mut on_progress).await)
}

/// 后台预热：解析直链 + 备好 ffmpeg，再按顺序预取最可能被剪的前三段。失败静默（真正剪时会再报错）。
pub async fn warm(data: &Path, video_id: &str, ranges: &[(f64, f64)]) {
    let never = AtomicBool::new(false);
    let (resolved, ff) = tokio::join!(
        fastclip::warm(data, video_id),
        ffmpeg::ensure(data, &never, |_, _| {})
    );
    if resolved.is_err() || ff.is_err() {
        return;
    }
    for &(a, b) in ranges.iter().take(3) {
        let _ = prepare_segment(data, video_id, a, b, &never, |_, _, _| {}).await;
    }
}

#[cfg(test)]
mod tests;
