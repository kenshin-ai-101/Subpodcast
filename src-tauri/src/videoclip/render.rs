/**
 * [INPUT]: 依赖 ffmpeg（ensure / probe / encode_h264 / h264）、base64 解 PNG；mod.rs 的 RenderRequest / Frame / RenderResult 契约
 * [OUTPUT]: render（成片 MP4 + 可选封面旁路 PNG）；Graph / filter_graph（纯函数，单测锁定几何）
 * [POS]: videoclip 的导出端。字幕、标题由 WebView 画成透明 PNG，这里按时间 overlay 上去——
 *        不依赖 libass / drawtext，任何 FFmpeg 构建都能出清晰的双语 H.264 + AAC
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use super::{ffmpeg, Frame, RenderRequest, RenderResult};
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

/// 「hold」封面在片头停留的秒数；「flash」只闪一下（约 4 帧），让平台抽到它当缩略图。
const HOLD_SECS: f64 = 1.0;
const FLASH_SECS: f64 = 0.14;

// ============================================================================
// 画布几何
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq)]
enum Backdrop {
    Blur,
    Solid(&'static str),
}

/// 统一的画布描述：旧版 `layout` 字符串与对话框算好的 `Frame` 都归一到这里，只有一条出图路径。
#[derive(Debug, Clone, Copy, PartialEq)]
struct Canvas {
    w: u32,
    h: u32,
    /// true：铺满画布（按 crop_x 横移裁切）；false：放进 (vx, vy, vw, vh) 盒子，四周是背景。
    fill: bool,
    vx: u32,
    vy: u32,
    vw: u32,
    vh: u32,
    /// 盒子模式下把画面裁成盒子的比例，而非完整缩进去。
    crop_box: bool,
    backdrop: Backdrop,
}

fn even(v: u32) -> u32 {
    (v / 2 * 2).max(2)
}

fn solid(card_bg: &str) -> &'static str {
    match card_bg {
        "paper" => "#f5f2eb",
        "white" => "#ffffff",
        _ => "#141315",
    }
}

fn canvas(layout: &str, card_bg: &str, frame: Option<&Frame>) -> Canvas {
    let backdrop = if card_bg == "blur" { Backdrop::Blur } else { Backdrop::Solid(solid(card_bg)) };
    let boxed = |w, h, vx, vy, vw, vh, crop_box, backdrop| Canvas {
        w, h, fill: false, vx, vy, vw, vh, crop_box, backdrop,
    };
    let filled = |w, h| Canvas {
        w, h, fill: true, vx: 0, vy: 0, vw: w, vh: h, crop_box: false, backdrop,
    };
    let c = match (frame, layout) {
        (Some(f), _) if f.fit == "card" => boxed(f.w, f.h, f.vx, f.vy, f.vw, f.vh, f.crop_box, backdrop),
        (Some(f), _) => filled(f.w, f.h),
        (None, "portrait_fill") => filled(1080, 1920),
        (None, "portrait_card") if backdrop == Backdrop::Blur => {
            boxed(1080, 1920, 0, 560, 1080, 640, false, backdrop)
        }
        (None, "portrait_card") => boxed(1080, 1920, 24, 568, 1032, 620, false, backdrop),
        (None, _) => boxed(1920, 1080, 0, 0, 1920, 1080, false, Backdrop::Solid("black")),
    };
    // 盒子必须落在画布内，pad / overlay 才不会报错。
    let (w, h) = (even(c.w), even(c.h));
    let vx = c.vx.min(w - 2);
    let vy = c.vy.min(h - 2);
    Canvas {
        w,
        h,
        vx,
        vy,
        vw: even(c.vw.min(w - vx)),
        vh: even(c.vh.min(h - vy)),
        ..c
    }
}

/// `src` 画面按画布出成 `[base]`。
fn base_chain(c: &Canvas, src: &str, crop_x: f64) -> String {
    let cx = crop_x.clamp(0.0, 1.0);
    let Canvas { w, h, vx, vy, vw, vh, .. } = *c;
    if c.fill {
        return format!(
            "[{src}]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}:(iw-{w})*{cx:.4}:(ih-{h})/2,setsar=1[base]"
        );
    }
    let cropped = format!(
        "scale={vw}:{vh}:force_original_aspect_ratio=increase,crop={vw}:{vh}:(iw-{vw})*{cx:.4}:(ih-{vh})/2"
    );
    match c.backdrop {
        // 纯色：pad 出盒子再 pad 出画布，不逐帧画满屏背景（比 overlay 快约四成）。
        Backdrop::Solid(hex) => {
            let fit = if c.crop_box {
                cropped
            } else {
                format!(
                    "scale={vw}:{vh}:force_original_aspect_ratio=decrease,pad={vw}:{vh}:(ow-iw)/2:(oh-ih)/2:color={hex}"
                )
            };
            format!("[{src}]{fit},setsar=1,pad={w}:{h}:{vx}:{vy}:color={hex}[base]")
        }
        // 模糊背景在 1/4 尺寸上做（肉眼无差，约省七倍算力）再放大。
        Backdrop::Blur => {
            let (qw, qh) = (even(w / 4), even(h / 4));
            let fit = if c.crop_box {
                cropped
            } else {
                format!("scale={vw}:{vh}:force_original_aspect_ratio=decrease")
            };
            format!(
                "[{src}]split[fg][bg];\
                 [bg]scale={qw}:{qh}:force_original_aspect_ratio=increase,crop={qw}:{qh},boxblur=6:2,eq=brightness=-0.22:saturation=0.85,scale={w}:{h},setsar=1[bgb];\
                 [fg]{fit},setsar=1[fgs];\
                 [bgb][fgs]overlay={vx}+({vw}-w)/2:{vy}+({vh}-h)/2[base]"
            )
        }
    }
}

// ============================================================================
// 滤镜图
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Cover {
    None,
    Flash(usize),
    Hold(usize),
}

pub struct GraphSpec<'a> {
    pub layout: &'a str,
    pub card_bg: &'a str,
    pub crop_x: f64,
    pub frame: Option<&'a Frame>,
    /// 静态层（标题、品牌）所在输入号。
    pub static_input: Option<usize>,
    /// (起, 止, y, 输入号)，时间已在倍速后的时钟上。
    pub cues: &'a [(f64, f64, i32, usize)],
    pub cover: Cover,
    pub has_audio: bool,
    pub speed: f64,
}

#[derive(Debug, PartialEq)]
pub struct Graph {
    pub filter: String,
    /// 有 `[aout]`（倍速或片头停留改了音频）；否则直接映射原音轨。
    pub audio_out: bool,
}

pub fn filter_graph(g: &GraphSpec) -> Graph {
    let mut chains: Vec<String> = Vec::new();
    let sped = (g.speed - 1.0).abs() > 1e-3;
    let src = if sped {
        chains.push(format!("[0:v]setpts=PTS/{:.4}[sv]", g.speed));
        "sv"
    } else {
        "0:v"
    };
    chains.push(base_chain(&canvas(g.layout, g.card_bg, g.frame), src, g.crop_x));

    let mut cur = String::from("base");
    let mut layer = |chains: &mut Vec<String>, input: usize, y: i32, enable: Option<String>| {
        let next = format!("l{}", chains.len());
        let when = enable.map(|e| format!(":enable='{e}'")).unwrap_or_default();
        chains.push(format!(
            "[{cur}][{input}:v]overlay=0:{y}{when}:eof_action=repeat:format=auto[{next}]"
        ));
        cur = next;
    };
    if let Some(i) = g.static_input {
        layer(&mut chains, i, 0, None);
    }
    for &(s, e, y, i) in g.cues {
        let s = s.max(0.0);
        let e = e.max(s + 0.05);
        layer(&mut chains, i, y, Some(format!("between(t,{s:.3},{e:.3})")));
    }

    match g.cover {
        Cover::Flash(i) => chains.push(format!(
            "[{cur}][{i}:v]overlay=0:0:enable='lt(t,{FLASH_SECS:.3})':eof_action=repeat:format=auto,format=yuv420p[vout]"
        )),
        Cover::Hold(i) => chains.push(format!(
            "[{cur}]tpad=start_duration={HOLD_SECS:.3}:start_mode=clone[held];\
             [held][{i}:v]overlay=0:0:enable='lt(t,{HOLD_SECS:.3})':eof_action=repeat:format=auto,format=yuv420p[vout]"
        )),
        Cover::None => chains.push(format!("[{cur}]format=yuv420p[vout]")),
    }

    let mut audio: Vec<String> = Vec::new();
    if sped {
        audio.push(format!("atempo={:.4}", g.speed));
    }
    if matches!(g.cover, Cover::Hold(_)) {
        audio.push(format!("adelay={}:all=1", (HOLD_SECS * 1000.0) as u32));
    }
    let audio_out = g.has_audio && !audio.is_empty();
    if audio_out {
        chains.push(format!("[0:a]{}[aout]", audio.join(",")));
    }
    Graph { filter: chains.join(";"), audio_out }
}

// ============================================================================
// 导出
// ============================================================================

fn png_bytes(raw: &str) -> Result<Vec<u8>> {
    let t = raw.trim();
    let b64 = t.strip_prefix("data:image/png;base64,").unwrap_or(t);
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| anyhow!("图层数据无效：{e}"))
}

fn some_png(raw: &Option<String>) -> Result<Option<Vec<u8>>> {
    raw.as_deref().filter(|s| !s.trim().is_empty()).map(png_bytes).transpose()
}

/// 设置里的导出目录（存在才用）→ 下载 → 桌面；重名追加序号。
fn default_output(name: &str, dir: Option<&str>) -> Result<PathBuf> {
    let dir = dir
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .filter(|d| d.is_dir())
        .or_else(dirs::download_dir)
        .or_else(dirs::desktop_dir)
        .ok_or_else(|| anyhow!("找不到可保存的文件夹"))?;
    let clean: String = name
        .chars()
        .filter(|c| !"/\\:*?\"<>|".contains(*c) && !c.is_control())
        .take(80)
        .collect();
    let base = match clean.trim() {
        "" => "声译高光",
        s => s,
    };
    let mut path = dir.join(format!("{base}.mp4"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{base} {n}.mp4"));
        n += 1;
    }
    Ok(path)
}

fn sidecar(video: &Path, suffix: &str) -> PathBuf {
    let stem = video.file_stem().and_then(|s| s.to_str()).unwrap_or("clip");
    video.with_file_name(format!("{stem}{suffix}.png"))
}

/// 合成成片：画布 → 静态层 → 定时字幕 → 封面（闪现 / 停留 / 内嵌缩略图），再写封面旁路 PNG。
pub async fn render(
    data: &Path,
    req: RenderRequest,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(&str, f64, &str),
) -> Result<RenderResult> {
    let raw = PathBuf::from(&req.raw_path);
    if !raw.is_file() {
        bail!("找不到源视频片段，请重新获取");
    }
    if req.duration <= 0.0 {
        bail!("片段时长无效");
    }
    on_progress("ffmpeg", 0.04, "正在准备视频导出组件…");
    let bin = ffmpeg::ensure(data, cancel, |got, total| {
        let frac = total.map(|t| got as f64 / t.max(1) as f64).unwrap_or(0.5);
        on_progress(
            "ffmpeg",
            0.04 + frac.clamp(0.0, 1.0) * 0.06,
            "正在准备视频导出组件（首次使用需要下载）…",
        );
    })
    .await?;

    let out = match req.output_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => default_output(&req.default_name, req.output_dir.as_deref())?,
    };
    if let Some(parent) = out.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let cover = some_png(&req.cover_png)?;
    let landscape = some_png(&req.landscape_cover_png)?;

    let work = data.join("work").join(format!("render-{}", uuid::Uuid::new_v4().simple()));
    tokio::fs::create_dir_all(&work).await?;
    let res = compose(&bin, &raw, &work, &out, &req, cover.as_deref(), cancel, &mut on_progress).await;
    let _ = tokio::fs::remove_dir_all(&work).await;
    res?;

    let mut cover_path = None;
    if let (true, Some(bytes)) = (req.save_cover_sidecar, cover.as_deref()) {
        let p = sidecar(&out, "-封面");
        tokio::fs::write(&p, bytes).await?;
        cover_path = Some(p.to_string_lossy().into_owned());
    }
    let mut landscape_cover_path = None;
    if let Some(bytes) = landscape.as_deref() {
        let p = sidecar(&out, "-横版封面");
        tokio::fs::write(&p, bytes).await?;
        landscape_cover_path = Some(p.to_string_lossy().into_owned());
    }
    on_progress("done", 1.0, "导出完成");
    Ok(RenderResult {
        video_path: out.to_string_lossy().into_owned(),
        cover_path,
        landscape_cover_path,
    })
}

/// 图层 PNG 落到 `work`（命令行只放相对文件名，几百条字幕也不会撑爆参数长度），一次编码出片。
#[allow(clippy::too_many_arguments)]
async fn compose(
    bin: &Path,
    raw: &Path,
    work: &Path,
    out: &Path,
    req: &RenderRequest,
    cover: Option<&[u8]>,
    cancel: &AtomicBool,
    on_progress: &mut impl FnMut(&str, f64, &str),
) -> Result<()> {
    let mut inputs: Vec<String> = Vec::new();
    let add = |name: String, bytes: Vec<u8>| async move {
        tokio::fs::write(work.join(&name), bytes).await.map(|_| name)
    };
    let static_input = match some_png(&req.static_overlay_png)? {
        Some(bytes) => {
            inputs.push(add("s.png".into(), bytes).await?);
            Some(inputs.len())
        }
        None => None,
    };
    let mut cues = Vec::with_capacity(req.cues.len());
    for (k, cue) in req.cues.iter().enumerate() {
        inputs.push(add(format!("c{k}.png"), png_bytes(&cue.png_base64)?).await?);
        cues.push((cue.start, cue.end, cue.y, inputs.len()));
    }
    let mode = req.cover_mode.as_str();
    let cover_input = match cover {
        Some(bytes) if matches!(mode, "flash" | "hold") || req.embed_thumbnail => {
            inputs.push(add("cover.png".into(), bytes.to_vec()).await?);
            Some(inputs.len())
        }
        _ => None,
    };

    let has_audio = ffmpeg::probe(bin, raw).await.map(|m| m.has_audio).unwrap_or(true);
    let speed = if req.speed > 0.0 { req.speed.clamp(0.5, 2.0) } else { 1.0 };
    let cover_kind = match (cover_input, mode) {
        (Some(i), "flash") => Cover::Flash(i),
        (Some(i), "hold") => Cover::Hold(i),
        _ => Cover::None,
    };
    let graph = filter_graph(&GraphSpec {
        layout: &req.layout,
        card_bg: &req.card_bg,
        crop_x: req.crop_x,
        frame: req.frame.as_ref(),
        static_input,
        cues: &cues,
        cover: cover_kind,
        has_audio,
        speed,
    });
    let held = if matches!(cover_kind, Cover::Hold(_)) { HOLD_SECS } else { 0.0 };
    let total = req.duration / speed + held;
    let tmp = work.join("out.mp4");

    on_progress("render", 0.12, "正在合成视频…");
    ffmpeg::encode_h264(
        bin,
        Some(work),
        &tmp,
        total,
        cancel,
        |p| on_progress("render", 0.12 + p * 0.85, "正在合成视频…"),
        |hw| {
            let mut a: Vec<String> = vec![
                "-y".into(),
                "-ss".into(), format!("{:.3}", req.lead.max(0.0)),
                "-t".into(), format!("{:.3}", req.duration),
                "-i".into(), raw.to_string_lossy().into_owned(),
            ];
            for name in &inputs {
                a.extend(["-i".into(), name.clone()]);
            }
            let audio = if graph.audio_out { "[aout]" } else { "0:a?" };
            a.extend([
                "-filter_complex".into(), graph.filter.clone(),
                "-map".into(), "[vout]".into(),
                "-map".into(), audio.into(),
            ]);
            a.extend(ffmpeg::h264(hw, ":v:0", false));
            if let Some(i) = cover_input.filter(|_| req.embed_thumbnail) {
                a.extend([
                    "-map".into(), format!("{i}:v"),
                    "-c:v:1".into(), "mjpeg".into(),
                    "-q:v:1".into(), "3".into(),
                    "-disposition:v:1".into(), "attached_pic".into(),
                ]);
            }
            a.extend([
                "-c:a".into(), "aac".into(),
                "-b:a".into(), "192k".into(),
                "-movflags".into(), "+faststart".into(),
                "out.mp4".into(),
            ]);
            a
        },
    )
    .await?;
    // 跨卷时 rename 会失败，退回复制。
    if tokio::fs::rename(&tmp, out).await.is_err() {
        tokio::fs::copy(&tmp, out).await.context("无法写入导出位置")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec<'a>(layout: &'a str, bg: &'a str, frame: Option<&'a Frame>) -> GraphSpec<'a> {
        GraphSpec {
            layout,
            card_bg: bg,
            crop_x: 0.5,
            frame,
            static_input: None,
            cues: &[],
            cover: Cover::None,
            has_audio: true,
            speed: 1.0,
        }
    }

    fn frame(w: u32, h: u32, fit: &str, vy: u32, vh: u32, crop_box: bool) -> Frame {
        Frame { w, h, fit: fit.into(), vx: 0, vy, vw: w, vh, crop_box }
    }

    #[test]
    fn layers_cover_and_audio() {
        let cues = [(0.5, 2.0, 820, 2)];
        let g = filter_graph(&GraphSpec {
            static_input: Some(1),
            cues: &cues,
            cover: Cover::Flash(3),
            ..spec("landscape", "blur", None)
        });
        assert!(g.filter.contains("scale=1920:1080:force_original_aspect_ratio=decrease"));
        assert!(g.filter.contains("color=black"));
        assert!(g.filter.contains("[1:v]overlay=0:0:eof_action=repeat"));
        assert!(g.filter.contains("[2:v]overlay=0:820:enable='between(t,0.500,2.000)'"));
        assert!(g.filter.contains("[3:v]overlay=0:0:enable='lt(t,0.140)'"));
        assert!(g.filter.ends_with("format=yuv420p[vout]"));
        assert!(!g.audio_out);

        let hold = filter_graph(&GraphSpec { cover: Cover::Hold(1), ..spec("portrait_card", "paper", None) });
        assert!(hold.filter.contains("tpad=start_duration=1.000:start_mode=clone"));
        assert!(hold.filter.contains("[0:a]adelay=1000:all=1[aout]") && hold.audio_out);
        let silent = filter_graph(&GraphSpec {
            cover: Cover::Hold(1),
            has_audio: false,
            ..spec("portrait_card", "night", None)
        });
        assert!(!silent.audio_out && !silent.filter.contains("adelay"));

        let fast = filter_graph(&GraphSpec { speed: 1.5, cover: Cover::Hold(1), ..spec("x", "night", None) });
        assert!(fast.filter.starts_with("[0:v]setpts=PTS/1.5000[sv];[sv]"));
        assert!(fast.filter.contains("[0:a]atempo=1.5000,adelay=1000:all=1[aout]"));
    }

    #[test]
    fn canvas_geometry() {
        let blur = filter_graph(&spec("portrait_card", "blur", None)).filter;
        assert!(blur.contains("scale=270:480") && blur.contains("overlay=0+(1080-w)/2:560+(640-h)/2[base]"));
        let paper = filter_graph(&spec("portrait_card", "paper", None)).filter;
        assert!(paper.contains("pad=1080:1920:24:568:color=#f5f2eb[base]"));
        let fill = filter_graph(&GraphSpec { crop_x: 0.25, ..spec("portrait_fill", "blur", None) }).filter;
        assert!(fill.contains("crop=1080:1920:(iw-1080)*0.2500:(ih-1920)/2"));

        let card = frame(1080, 1440, "card", 380, 608, false);
        let g = filter_graph(&spec("x", "blur", Some(&card))).filter;
        assert!(g.contains("scale=270:360") && g.contains("overlay=0+(1080-w)/2:380+(608-h)/2[base]"), "{g}");
        let zoomed = frame(1080, 1920, "card", 560, 810, true);
        let z = filter_graph(&GraphSpec { crop_x: 0.7, ..spec("x", "night", Some(&zoomed)) }).filter;
        assert!(z.contains("crop=1080:810:(iw-1080)*0.7000") && z.contains("pad=1080:1920:0:560:color=#141315"));
        let sq = frame(1080, 1080, "fill", 0, 0, false);
        assert!(filter_graph(&GraphSpec { crop_x: 0.3, ..spec("x", "blur", Some(&sq)) })
            .filter
            .contains("crop=1080:1080:(iw-1080)*0.3000"));

        let off = frame(1080, 1920, "card", 1900, 900, false);
        let c = canvas("x", "night", Some(&off));
        assert!(c.vy + c.vh <= c.h, "{c:?}");
    }

    #[test]
    fn output_names() {
        let dir = std::env::temp_dir().join(format!("subpodcast-out-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.to_string_lossy().into_owned();
        let first = default_output("a/b:c", Some(&d)).unwrap();
        assert_eq!(first.file_name().unwrap(), "abc.mp4");
        std::fs::write(&first, b"x").unwrap();
        assert_eq!(default_output("a/b:c", Some(&d)).unwrap().file_name().unwrap(), "abc 2.mp4");
        assert_eq!(sidecar(&first, "-封面").file_name().unwrap(), "abc-封面.png");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
