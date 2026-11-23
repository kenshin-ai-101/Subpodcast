/**
 * [INPUT]: 依赖 ytdlp::find_tool 定位二进制、asr::download_file 拉静态包、zip/tar/flate2 解包、regex 解析探测输出
 * [OUTPUT]: find / status / ensure（缺失时镜像 → 上游下载到 data/bin）；hardware_h264；command / run（-progress 进度 + 取消）；
 *           probe / parse_meta；h264 编码参数与 encode_h264（硬编失败退软编）；mux_copy / normalize 两个取段配方
 * [POS]: videoclip 的 FFmpeg 边界层：兄弟文件只拼滤镜与参数，子进程生命周期、取消与错误尾行都收口于此
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use super::FfmpegStatus;
use anyhow::{anyhow, bail, Context, Result};
use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};

// ============================================================================
// 定位与安装
// ============================================================================

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

pub fn find(data: &Path) -> Option<PathBuf> {
    crate::ytdlp::find_tool(data, "ffmpeg")
}

static HW: Lazy<Mutex<HashMap<PathBuf, bool>>> = Lazy::new(Default::default);

/// macOS 的 VideoToolbox H.264 硬编；其它平台一律软编。按二进制缓存，只探测一次。
pub fn hardware_h264(bin: &Path) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    if let Some(ok) = HW.lock().unwrap().get(bin) {
        return *ok;
    }
    let ok = std::process::Command::new(bin)
        .args(["-hide_banner", "-encoders"])
        .output()
        .map(|o| {
            o.status.success() && String::from_utf8_lossy(&o.stdout).contains("h264_videotoolbox")
        })
        .unwrap_or(false);
    HW.lock().unwrap().insert(bin.to_path_buf(), ok);
    ok
}

pub fn status(data: &Path) -> FfmpegStatus {
    let bin = find(data);
    FfmpegStatus {
        installed: bin.is_some(),
        hardware_h264: bin.as_deref().is_some_and(hardware_h264),
        path: bin.map(|p| p.to_string_lossy().into_owned()),
    }
}

/// 静态构建包：镜像（与 yt-dlp 同源，国内可达）优先，上游兜底。
fn archives() -> &'static [&'static str] {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        &[
            "https://subcast.qiaomu.ai/tools/ffmpeg/ffmpeg-macos-arm64.zip",
            "https://www.osxexperts.net/ffmpeg711arm.zip",
        ]
    } else if cfg!(target_os = "macos") {
        &[
            "https://subcast.qiaomu.ai/tools/ffmpeg/ffmpeg-macos-x64.zip",
            "https://evermeet.cx/ffmpeg/getrelease/zip",
        ]
    } else if cfg!(windows) {
        &[
            "https://subcast.qiaomu.ai/tools/ffmpeg/ffmpeg-windows-x64.zip",
            "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
        ]
    } else if cfg!(target_arch = "aarch64") {
        &["https://subcast.qiaomu.ai/tools/ffmpeg/ffmpeg-linux-arm64.tar.gz"]
    } else {
        &["https://subcast.qiaomu.ai/tools/ffmpeg/ffmpeg-linux-x64.tar.gz"]
    }
}

static INSTALLING: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

/// 找到即用；否则下载静态构建到 data/bin（并发调用只下一次），装好后跑一次 `-version` 才算数。
pub async fn ensure(
    data: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<PathBuf> {
    if let Some(p) = find(data) {
        return Ok(p);
    }
    let _one = INSTALLING.lock().await;
    if let Some(p) = find(data) {
        return Ok(p);
    }
    let dest = data.join("bin").join(exe_name());
    let stage = data.join("bin").join(".ffmpeg-download");
    for url in archives() {
        if cancel.load(Ordering::Relaxed) {
            bail!("已取消");
        }
        let _ = tokio::fs::remove_dir_all(&stage).await;
        let archive = stage.join(if url.ends_with(".tar.gz") { "pkg.tar.gz" } else { "pkg.zip" });
        let installed = match crate::asr::download_file(url, &archive, cancel, &mut progress).await {
            Ok(()) => {
                let (a, d) = (archive.clone(), dest.clone());
                tokio::task::spawn_blocking(move || unpack(&a, &d))
                    .await
                    .map_err(|e| anyhow!(e))
                    .and_then(|r| r)
            }
            Err(e) => Err(e),
        };
        let _ = tokio::fs::remove_dir_all(&stage).await;
        match installed {
            Ok(()) if runs(&dest).await => return Ok(dest),
            Ok(()) => {
                let _ = tokio::fs::remove_file(&dest).await;
            }
            Err(e) if cancel.load(Ordering::Relaxed) => return Err(e),
            Err(e) => eprintln!("Subpodcast: ffmpeg download {url} failed: {e}"),
        }
    }
    bail!("没有找到 FFmpeg，自动下载也没有成功。可用 Homebrew 安装（brew install ffmpeg）后重试")
}

/// 从 zip / tar.gz 里只取出 ffmpeg 本体（包内目录结构各家不同，按文件名找）。
fn unpack(archive: &Path, dest: &Path) -> Result<()> {
    let want = exe_name();
    let tmp = dest.with_extension("unpack");
    std::fs::create_dir_all(dest.parent().context("bin 目录无效")?)?;
    let file = std::fs::File::open(archive)?;
    let found = if archive.to_string_lossy().ends_with(".tar.gz") {
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
        let mut hit = false;
        for entry in tar.entries()? {
            let mut entry = entry?;
            let named = entry.path()?.file_name().is_some_and(|n| n == want);
            if named && entry.header().entry_type().is_file() {
                std::io::copy(&mut entry, &mut std::fs::File::create(&tmp)?)?;
                hit = true;
                break;
            }
        }
        hit
    } else {
        let mut zip = zip::ZipArchive::new(file)?;
        let index = (0..zip.len()).find(|&i| {
            zip.by_index(i).is_ok_and(|f| {
                f.is_file() && Path::new(f.name()).file_name().is_some_and(|n| n == want)
            })
        });
        match index {
            Some(i) => {
                std::io::copy(&mut zip.by_index(i)?, &mut std::fs::File::create(&tmp)?)?;
                true
            }
            None => false,
        }
    };
    if !found {
        bail!("安装包里没有 ffmpeg");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::rename(&tmp, dest)?;
    Ok(())
}

async fn runs(bin: &Path) -> bool {
    let mut c = command(bin);
    c.arg("-version").stdout(Stdio::null()).stderr(Stdio::null());
    matches!(
        tokio::time::timeout(Duration::from_secs(10), c.status()).await,
        Ok(Ok(s)) if s.success()
    )
}

// ============================================================================
// 运行
// ============================================================================

pub fn command(bin: &Path) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(bin);
    c.stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    {
        c.creation_flags(0x08000000);
    }
    c
}

/// `-progress` 的 `out_time_us=`（旧版叫 out_time_ms，单位同为微秒）。
fn progress_secs(line: &str) -> Option<f64> {
    let v = line
        .strip_prefix("out_time_us=")
        .or_else(|| line.strip_prefix("out_time_ms="))?;
    v.trim().parse::<i64>().ok().filter(|v| *v >= 0).map(|us| us as f64 / 1e6)
}

/// 跑一条 ffmpeg。进度走 `-progress pipe:1`（按行，不受 stats 行用 `\r` 刷新的影响），
/// 折算成 0–0.99；取消即杀进程；失败带回 stderr 最后一行。
pub async fn run(
    bin: &Path,
    cwd: Option<&Path>,
    args: &[String],
    total: f64,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(f64),
) -> Result<()> {
    let mut cmd = command(bin);
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    cmd.args(["-hide_banner", "-nostats", "-v", "error", "-progress", "pipe:1"])
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().context("无法启动 FFmpeg")?;
    let stderr = child.stderr.take();
    let tail = tokio::spawn(async move {
        let mut last = String::new();
        if let Some(s) = stderr {
            let mut lines = BufReader::new(s).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                if !l.trim().is_empty() {
                    last = l;
                }
            }
        }
        last
    });
    let mut out = BufReader::new(child.stdout.take().context("FFmpeg 没有输出")?).lines();
    let mut tick = tokio::time::interval(Duration::from_millis(200));
    loop {
        tokio::select! {
            line = out.next_line() => match line {
                Ok(Some(l)) => {
                    if let Some(t) = progress_secs(&l).filter(|_| total > 0.1) {
                        on_progress((t / total).clamp(0.0, 0.99));
                    }
                }
                _ => break,
            },
            _ = tick.tick() => {}
        }
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill().await;
            tail.abort();
            bail!("已取消");
        }
    }
    let status = child.wait().await?;
    let last = tail.await.unwrap_or_default();
    if cancel.load(Ordering::Relaxed) {
        bail!("已取消");
    }
    if !status.success() {
        bail!("视频处理失败：{}", last.chars().take(180).collect::<String>());
    }
    Ok(())
}

// ============================================================================
// 探测
// ============================================================================

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Meta {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub has_audio: bool,
}

static DURATION: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)").unwrap());
static DIMS: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(\d{2,5})x(\d{2,5})\b").unwrap());

/// 解析 `ffmpeg -i` 的流信息；缺项按 0 秒 / 1920×1080 兜底。
pub fn parse_meta(text: &str) -> Meta {
    let duration = DURATION
        .captures(text)
        .and_then(|c| {
            let h: f64 = c[1].parse().ok()?;
            let m: f64 = c[2].parse().ok()?;
            let s: f64 = c[3].parse().ok()?;
            Some(h * 3600.0 + m * 60.0 + s)
        })
        .unwrap_or(0.0);
    let streams = || text.lines().filter(|l| l.contains("Stream #"));
    let (width, height) = streams()
        .find(|l| l.contains("Video:"))
        .and_then(|l| {
            let c = DIMS.captures(l)?;
            Some((c[1].parse().ok()?, c[2].parse().ok()?))
        })
        .unwrap_or((1920, 1080));
    let has_audio = streams().any(|l| l.contains("Audio:"));
    Meta { duration, width, height, has_audio }
}

/// `ffmpeg -i` 不给输出会以非零退出，但流信息照常打在 stderr。
pub async fn probe(bin: &Path, path: &Path) -> Option<Meta> {
    let mut cmd = command(bin);
    cmd.arg("-hide_banner")
        .arg("-i")
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let out = tokio::time::timeout(Duration::from_secs(15), cmd.output()).await.ok()?.ok()?;
    let meta = parse_meta(&String::from_utf8_lossy(&out.stderr));
    (meta.duration > 0.0).then_some(meta)
}

// ============================================================================
// 编码
// ============================================================================

/// H.264 参数。`spec` 是流限定符：通常 ":v"，封面缩略图作第二路视频流时用 ":v:0" 只管主画面；
/// 中间文件还要再编一次，给足码率，成片则控住体积。
pub fn h264(hw: bool, spec: &str, intermediate: bool) -> Vec<String> {
    let k = |name: &str| format!("{name}{spec}");
    if hw {
        let (rate, max) = if intermediate { ("12M", "16M") } else { ("10M", "14M") };
        vec![
            k("-c"), "h264_videotoolbox".into(),
            k("-b"), rate.into(),
            k("-maxrate"), max.into(),
            k("-bufsize"), "20M".into(),
        ]
    } else {
        let crf = if intermediate { "18" } else { "19" };
        vec![
            k("-c"), "libx264".into(),
            k("-preset"), "veryfast".into(),
            k("-crf"), crf.into(),
        ]
    }
}

/// 先硬编，VideoToolbox 拒绝（部分分辨率/机型）时退回 libx264；取消不重试。失败会删掉 `out`。
pub async fn encode_h264(
    bin: &Path,
    cwd: Option<&Path>,
    out: &Path,
    total: f64,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(f64),
    args_for: impl Fn(bool) -> Vec<String>,
) -> Result<()> {
    let tries: &[bool] = if hardware_h264(bin) { &[true, false] } else { &[false] };
    let mut failure = None;
    for &hw in tries {
        match run(bin, cwd, &args_for(hw), total, cancel, &mut on_progress).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                let _ = tokio::fs::remove_file(out).await;
                if cancel.load(Ordering::Relaxed) {
                    return Err(e);
                }
                failure = Some(e);
            }
        }
    }
    Err(failure.unwrap_or_else(|| anyhow!("视频处理失败")))
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// 快速取段的拼装：画面从关键帧 `v0` 原样拷贝（不重编），音频对齐到 `v0` 后转 AAC。
/// 片段正文从文件的 `start - v0` 秒处开始，由调用方记成 lead，导出时再精确裁掉。
#[allow(clippy::too_many_arguments)]
pub async fn mux_copy(
    bin: &Path,
    video: &Path,
    v0: f64,
    audio: &Path,
    a0: f64,
    end: f64,
    out: &Path,
    cancel: &AtomicBool,
) -> Result<()> {
    let mut args: Vec<String> = vec!["-y".into(), "-i".into(), s(video)];
    if a0 < v0 {
        args.extend(["-ss".into(), format!("{:.3}", v0 - a0)]);
    } else if a0 > v0 {
        args.extend(["-itsoffset".into(), format!("{:.3}", a0 - v0)]);
    }
    args.extend(["-i".into(), s(audio)]);
    args.extend([
        "-t".into(), format!("{:.3}", end - v0),
        "-map".into(), "0:v:0".into(),
        "-map".into(), "1:a:0".into(),
        "-c:v".into(), "copy".into(),
        "-c:a".into(), "aac".into(),
        "-b:a".into(), "192k".into(),
        "-movflags".into(), "+faststart".into(),
        s(out),
    ]);
    let res = run(bin, None, &args, end - v0, cancel, |_| {}).await;
    if res.is_err() {
        let _ = tokio::fs::remove_file(out).await;
    }
    res
}

/// 重编成标准 MP4（偶数宽高、yuv420p、AAC），`trim = (起点, 时长)` 时顺带精确截取。
pub async fn normalize(
    bin: &Path,
    input: &Path,
    out: &Path,
    trim: Option<(f64, f64)>,
    total: f64,
    cancel: &AtomicBool,
    on_progress: impl FnMut(f64),
) -> Result<()> {
    encode_h264(bin, None, out, total, cancel, on_progress, |hw| {
        let mut a: Vec<String> = vec!["-y".into()];
        if let Some((ss, dur)) = trim {
            a.extend([
                "-ss".into(), format!("{ss:.3}"),
                "-t".into(), format!("{dur:.3}"),
            ]);
        }
        a.extend([
            "-i".into(), s(input),
            "-vf".into(), "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p".into(),
        ]);
        a.extend(h264(hw, ":v", true));
        a.extend([
            "-c:a".into(), "aac".into(),
            "-b:a".into(), "192k".into(),
            "-movflags".into(), "+faststart".into(),
            s(out),
        ]);
        a
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_stream_info_and_progress() {
        let text = "\
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':
  Duration: 00:01:23.45, start: 0.000000, bitrate: 1543 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709), 1280x720 [SAR 1:1 DAR 16:9], 30 fps
  Stream #0:1[0x2](und): Audio: aac (LC), 48000 Hz, stereo, fltp
";
        let m = parse_meta(text);
        assert!((m.duration - 83.45).abs() < 1e-6);
        assert_eq!((m.width, m.height, m.has_audio), (1280, 720, true));
        assert!(!parse_meta("Duration: 00:00:02.00\n  Stream #0:0: Video: h264, 640x360").has_audio);
        assert_eq!(progress_secs("out_time_us=4250000"), Some(4.25));
        assert_eq!(progress_secs("out_time_ms=1000000"), Some(1.0));
        assert_eq!(progress_secs("out_time_us=N/A"), None);
        assert_eq!(progress_secs("frame=12"), None);
    }

    #[test]
    fn encoder_args_respect_stream_spec() {
        let hw = h264(true, ":v:0", false);
        assert!(hw.windows(2).any(|w| w[0] == "-c:v:0" && w[1] == "h264_videotoolbox"));
        let sw = h264(false, ":v", true);
        assert!(sw.windows(2).any(|w| w[0] == "-c:v" && w[1] == "libx264"));
        assert!(sw.windows(2).any(|w| w[0] == "-crf:v" && w[1] == "18"));
    }
}
