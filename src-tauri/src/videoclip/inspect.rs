/**
 * [INPUT]: 依赖 ffmpeg::command 并发抽帧（底部灰度条带 / JPEG），base64 编码
 * [OUTPUT]: burned_subtitles（原片是否已有硬字幕）、candidate_frames（候选封面 data URL + 最清晰下标）、decide_burned（纯函数）
 * [POS]: videoclip 的画面体检：只在片段正文 `[from, from+span]` 内采样；结果由 mod.rs 缓存进 .meta.json / .frames.json
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use super::ffmpeg;
use base64::Engine;
use futures_util::future::join_all;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

const BAND_W: usize = 480;
const BAND_H: usize = 96;

async fn grab(bin: &Path, path: &Path, at: f64, filter: &str, format: &[&str]) -> Option<Vec<u8>> {
    let mut cmd = ffmpeg::command(bin);
    cmd.args(["-v", "error", "-ss", &format!("{at:.2}"), "-i"])
        .arg(path)
        .args(["-frames:v", "1", "-vf", filter])
        .args(format)
        .arg("-")
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let out = tokio::time::timeout(Duration::from_secs(10), cmd.output()).await.ok()?.ok()?;
    out.status.success().then_some(out.stdout)
}

// ============================================================================
// 硬字幕
// ============================================================================

/// 一帧里「亮像素紧挨暗像素」的位置——字幕描边的特征——只看水平居中的 70%。
fn glyph_edges(pix: &[u8], w: usize, h: usize) -> Vec<u64> {
    const BRIGHT: u8 = 200;
    const DARK: u8 = 80;
    const REACH: usize = 2;
    let mut bits = vec![0u64; (w * h).div_ceil(64)];
    let (x0, x1) = (w * 15 / 100, w * 85 / 100);
    for y in 0..h {
        let row = &pix[y * w..(y + 1) * w];
        for x in x0..x1 {
            if row[x] < BRIGHT {
                continue;
            }
            let near = &row[x.saturating_sub(REACH)..(x + REACH + 1).min(w)];
            if near.iter().any(|&v| v < DARK) {
                let i = y * w + x;
                bits[i / 64] |= 1 << (i % 64);
            }
        }
    }
    bits
}

fn count(bits: &[u64]) -> usize {
    bits.iter().map(|b| b.count_ones() as usize).sum()
}

/// 底部条带的字形边缘在帧间不断变化 → 有硬字幕；台标、水印位置不动，帧间几乎重合，不算。
pub fn decide_burned(frames: &[Vec<u8>], w: usize, h: usize) -> bool {
    const MIN_FRAC: f64 = 0.0012;
    const MAX_OVERLAP: f64 = 0.5;
    if frames.len() < 3 || w == 0 || h == 0 {
        return false;
    }
    let floor = (MIN_FRAC * (w * h) as f64) as usize;
    let masks: Vec<Vec<u64>> = frames
        .iter()
        .filter(|f| f.len() == w * h)
        .map(|f| glyph_edges(f, w, h))
        .filter(|m| count(m) >= floor)
        .collect();
    if masks.len() < 3 || masks.len() * 2 < frames.len() {
        return false;
    }
    let mut overlaps: Vec<f64> = masks
        .windows(2)
        .map(|pair| {
            let (inter, union) = pair[0].iter().zip(&pair[1]).fold((0u32, 0u32), |(i, u), (a, b)| {
                (i + (a & b).count_ones(), u + (a | b).count_ones())
            });
            inter as f64 / union.max(1) as f64
        })
        .collect();
    overlaps.sort_by(f64::total_cmp);
    overlaps[overlaps.len() / 2] < MAX_OVERLAP
}

/// 在正文里均匀取 6 帧的底部 35% 条带（缩到 480×96 灰度）判定。
pub async fn burned_subtitles(bin: &Path, path: &Path, from: f64, span: f64) -> bool {
    const SAMPLES: usize = 6;
    if span <= 0.6 {
        return false;
    }
    let filter = format!("crop=iw:ih*0.35:0:ih*0.65,scale={BAND_W}:{BAND_H},format=gray");
    let shots = (0..SAMPLES).map(|i| {
        let at = from + span * (0.08 + 0.84 * i as f64 / (SAMPLES - 1) as f64);
        grab(bin, path, at, &filter, &["-f", "rawvideo"])
    });
    let frames: Vec<Vec<u8>> = join_all(shots).await.into_iter().flatten().collect();
    decide_burned(&frames, BAND_W, BAND_H)
}

// ============================================================================
// 候选封面
// ============================================================================

/// 5 张候选帧（1280 宽 JPEG data URL）；JPEG 越大细节越多，取最大者为默认封面（避开黑场与糊帧）。
pub async fn candidate_frames(bin: &Path, path: &Path, from: f64, span: f64) -> (Vec<String>, usize) {
    const AT: [f64; 5] = [0.10, 0.28, 0.48, 0.68, 0.85];
    let span = span.max(0.2);
    let shots = AT.iter().map(|frac| {
        let at = from + (span * frac).clamp(0.05, (span - 0.08).max(0.05));
        grab(bin, path, at, "scale=1280:-2", &["-q:v", "4", "-f", "image2pipe", "-vcodec", "mjpeg"])
    });
    let jpegs: Vec<Vec<u8>> = join_all(shots)
        .await
        .into_iter()
        .flatten()
        .filter(|j| j.len() > 256)
        .collect();
    let best = jpegs
        .iter()
        .enumerate()
        .max_by_key(|(_, j)| j.len())
        .map(|(i, _)| i)
        .unwrap_or(0);
    let urls = jpegs
        .iter()
        .map(|j| format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(j)))
        .collect();
    (urls, best)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moving_glyphs_count_static_logo_does_not() {
        let (w, h) = (100usize, 40usize);
        let mut logo = vec![100u8; w * h];
        for y in 5..12 {
            for x in 20..30 {
                logo[y * w + x] = 240;
            }
            logo[y * w + 19] = 10;
        }
        assert!(!decide_burned(&[logo.clone(), logo.clone(), logo], w, h));

        let line = |x0: usize| {
            let mut f = vec![110u8; w * h];
            for y in 24..34 {
                for x in x0..x0 + 20 {
                    f[y * w + x] = 245;
                }
                f[y * w + x0 - 1] = 15;
            }
            f
        };
        assert!(decide_burned(&[line(18), line(42), line(62)], w, h));
        assert!(!decide_burned(&[line(18), line(42)], w, h));
    }
}
