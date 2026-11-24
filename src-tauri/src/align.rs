/**
 * [INPUT]: asr::decode_mono_stream、net、model::Segment、rusty_chromaprint
 * [OUTPUT]: AudioRef / Piece / TimeMap / fingerprint_audio / match_fingerprints / 语音探针对齐（locate_probes / build_pieces_from_anchors）/ fetch_remote_meta
 * [POS]: 音频与字幕时钟对齐核心：声纹比对（同源重剪/DAI换广告）+ 语音探针对齐（跨源 YouTube/共享库/RSS 字幕）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use crate::asr;
use crate::model::Segment;
use crate::net;
use anyhow::{anyhow, Result};
use base64::Engine;
use rusty_chromaprint::{Configuration, Fingerprinter};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

/// Chromaprint preset-2（与共享字幕库声纹接口协议一致）：每 1366/11025 s 产出一个 32-bit 帧。
pub const FP_ALGO: &str = "chromaprint2";
pub const FRAME_SECS: f64 = 1366.0 / 11025.0;

/// 语音探针参数：每个探针 24s，放进 30s 槽位（对齐 ASR 30s 窗口边界，避免串段）。
pub const PROBE_LEN_SECS: f64 = 24.0;
pub const SLOT_LEN_SECS: f64 = 30.0;

/// 同一剪辑段允许的偏移抖动上限（秒）；广告插播通常会引起远大于此的位移。
pub const OFFSET_TOLERANCE_SECS: f64 = 4.0;

/// 字幕制作时对应的参考音频元信息（存 blob `audio-ref`）。
#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioRef {
    pub bytes: u64,
    #[serde(default)]
    pub etag: String,
    pub secs: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_id: Option<String>,
    #[serde(default)]
    pub has_fp: bool,
}

/// 字幕时钟 `[ref_start, ref_end)` 映射到播放音频 `[play_start, play_start + (ref_end - ref_start))`。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Piece {
    pub ref_start: f64,
    pub ref_end: f64,
    pub play_start: f64,
}

/// 字幕时钟 ↔ 播放音频时钟分段映射（存 blob `tmap`）。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TimeMap {
    pub play_bytes: u64,
    /// same | fingerprint | probe | manual
    pub method: String,
    pub pieces: Vec<Piece>,
}

impl TimeMap {
    pub fn same(play_bytes: u64) -> Self {
        Self {
            play_bytes,
            method: "same".into(),
            pieces: Vec::new(),
        }
    }

    /// 字幕时间 → 播放音频时钟。
    pub fn to_play(&self, sub_time: f64) -> f64 {
        let Some(first) = self.pieces.first() else {
            return sub_time;
        };
        if sub_time < first.ref_start {
            return (sub_time + first.play_start - first.ref_start).max(0.0);
        }
        for idx in 0..self.pieces.len() {
            let p = &self.pieces[idx];
            if sub_time < p.ref_end {
                return p.play_start + (sub_time - p.ref_start).max(0.0);
            }
            if let Some(next) = self.pieces.get(idx + 1) {
                if sub_time < next.ref_start {
                    return next.play_start;
                }
            }
        }
        let last = self.pieces.last().unwrap();
        (sub_time + last.play_start - last.ref_start).max(0.0)
    }
}

pub fn encode_fp(frames: &[u32]) -> String {
    let mut raw = Vec::with_capacity(frames.len() * 4);
    for f in frames {
        raw.extend_from_slice(&f.to_le_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(raw)
}

pub fn decode_fp(b64: &str) -> Option<Vec<u32>> {
    let raw = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    if raw.len() % 4 != 0 {
        return None;
    }
    Some(
        raw.chunks_exact(4)
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}

/// 流式计算音频时长与 Chromaprint 声纹（O(1) 内存，支持多小时长播客）。
pub fn fingerprint_audio(path: &Path) -> Result<(f64, Vec<u32>)> {
    let cfg = Configuration::preset_test2();
    let mut fp = Fingerprinter::new(&cfg);
    let mut sample_rate = 0u32;
    let mut total_frames = 0u64;
    let mut init_err = false;
    let mut pcm16: Vec<i16> = Vec::new();

    asr::decode_mono_stream(path, |sr, samples| {
        if sample_rate == 0 {
            sample_rate = sr;
            if fp.start(sr, 1).is_err() {
                init_err = true;
            }
        }
        if init_err || sr != sample_rate {
            return;
        }
        total_frames += samples.len() as u64;
        pcm16.clear();
        pcm16.extend(
            samples
                .iter()
                .map(|&v| (v.clamp(-1.0, 1.0) * 32767.0) as i16),
        );
        fp.consume(&pcm16);
    })?;

    if sample_rate == 0 || init_err {
        return Err(anyhow!("无法提取音频声纹"));
    }
    fp.finish();
    Ok((
        total_frames as f64 / sample_rate as f64,
        fp.fingerprint().to_vec(),
    ))
}

/// 探测远端音频文件的字节数与 ETag（先 HEAD，不支持则用 `Range: bytes=0-0`）。
pub async fn fetch_remote_meta(url: &str) -> Option<(u64, String)> {
    let canonical = crate::shared::canonical_audio_url(url);
    let client = net::client();
    let read_etag = |headers: &reqwest::header::HeaderMap| {
        headers
            .get(reqwest::header::ETAG)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string()
    };

    if let Ok(resp) = client
        .head(&canonical)
        .timeout(Duration::from_secs(12))
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Some(len) = resp
                .headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .filter(|&n| n > 0)
            {
                return Some((len, read_etag(resp.headers())));
            }
        }
    }

    let resp = client
        .get(&canonical)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .timeout(Duration::from_secs(12))
        .send()
        .await
        .ok()?;
    let total = resp
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.rsplit('/').next())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|&n| n > 0)?;
    Some((total, read_etag(resp.headers())))
}

/// 声纹比对：在参考声纹与播放声纹间找出最长单调共有段序列。
pub fn match_fingerprints(reference: &[u32], target: &[u32]) -> Vec<Piece> {
    let runs = find_shared_runs(reference, target);
    if runs.is_empty() {
        return Vec::new();
    }
    // 加权最长单调递增链（允许少量边界重叠以容忍窗口拖尾）
    let n = runs.len();
    let mut dp: Vec<usize> = runs.iter().map(|r| r.len).collect();
    let mut parent: Vec<Option<usize>> = vec![None; n];
    for i in 0..n {
        for j in 0..i {
            let prev = runs[j];
            let curr = runs[i];
            if prev.ref_idx + prev.len <= curr.ref_idx + 8
                && prev.play_idx + prev.len <= curr.play_idx + 8
            {
                let cand = dp[j] + curr.len;
                if cand > dp[i] {
                    dp[i] = cand;
                    parent[i] = Some(j);
                }
            }
        }
    }
    let Some(mut best_i) = (0..n).max_by_key(|&i| dp[i]) else {
        return Vec::new();
    };
    let mut chain = Vec::new();
    loop {
        chain.push(runs[best_i]);
        match parent[best_i] {
            Some(p) => best_i = p,
            None => break,
        }
    }
    chain.reverse();

    let raw_pieces: Vec<Piece> = chain
        .into_iter()
        .map(|r| Piece {
            ref_start: r.ref_idx as f64 * FRAME_SECS,
            ref_end: (r.ref_idx + r.len) as f64 * FRAME_SECS,
            play_start: r.play_idx as f64 * FRAME_SECS,
        })
        .collect();
    merge_consistent_pieces(raw_pieces)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct SharedRun {
    ref_idx: usize,
    play_idx: usize,
    len: usize,
}

fn find_shared_runs(reference: &[u32], target: &[u32]) -> Vec<SharedRun> {
    const MIN_RUN: usize = 40; // ~5 秒
    const SMOOTH_WIN: usize = 16;
    const MAX_MEAN_BITS: f64 = 10.0;
    const MAX_BUCKET: usize = 64;

    if reference.len() < MIN_RUN || target.len() < MIN_RUN {
        return Vec::new();
    }

    // 用高 12 bit 做倒排投票，快速定位候选偏移 delta = j - i
    let mut index: HashMap<u32, Vec<usize>> = HashMap::new();
    for (i, &word) in reference.iter().enumerate() {
        index.entry(word >> 20).or_default().push(i);
    }

    let bias = reference.len();
    let mut hist = vec![0u32; reference.len() + target.len()];
    for (j, &word) in target.iter().enumerate() {
        if let Some(positions) = index.get(&(word >> 20)) {
            if positions.len() > MAX_BUCKET {
                continue; // 静音/高频底噪桶跳过
            }
            for &i in positions {
                hist[j + bias - i] += 1;
            }
        }
    }

    let mut peaks: Vec<(u32, usize)> = hist
        .iter()
        .enumerate()
        .filter(|&(d, &v)| {
            v >= 12
                && (d == 0 || hist[d - 1] <= v)
                && (d + 1 == hist.len() || hist[d + 1] < v)
        })
        .map(|(d, &v)| (v, d))
        .collect();
    peaks.sort_unstable_by(|a, b| b.cmp(a));
    peaks.truncate(24);

    let mut runs = Vec::new();
    for (_, bucket) in peaks {
        let delta = bucket as isize - bias as isize;
        let r0 = (-delta).max(0) as usize;
        let p0 = (r0 as isize + delta) as usize;
        let span = reference.len().saturating_sub(r0).min(target.len().saturating_sub(p0));
        if span < MIN_RUN {
            continue;
        }
        // 前缀和计算滑动窗口平均汉明距离，O(span)
        let mut prefix = Vec::with_capacity(span + 1);
        prefix.push(0u32);
        for k in 0..span {
            let d = (reference[r0 + k] ^ target[p0 + k]).count_ones();
            prefix.push(prefix[k] + d);
        }
        let mut ok = vec![false; span];
        let half = SMOOTH_WIN / 2;
        for k in 0..span {
            let lo = k.saturating_sub(half);
            let hi = (lo + SMOOTH_WIN).min(span);
            let mean = (prefix[hi] - prefix[lo]) as f64 / (hi - lo) as f64;
            ok[k] = mean <= MAX_MEAN_BITS;
        }
        let mut k = 0;
        while k < span {
            if !ok[k] {
                k += 1;
                continue;
            }
            let s = k;
            while k < span && ok[k] {
                k += 1;
            }
            if k - s >= MIN_RUN {
                runs.push(SharedRun {
                    ref_idx: r0 + s,
                    play_idx: p0 + s,
                    len: k - s,
                });
            }
        }
    }
    runs.sort();
    runs.dedup();
    runs
}

fn merge_consistent_pieces(pieces: Vec<Piece>) -> Vec<Piece> {
    let mut merged: Vec<Piece> = Vec::new();
    for p in pieces {
        if let Some(prev) = merged.last_mut() {
            let prev_off = prev.play_start - prev.ref_start;
            let curr_off = p.play_start - p.ref_start;
            if (curr_off - prev_off).abs() < 0.5 && p.ref_start - prev.ref_end < 30.0 {
                prev.ref_end = prev.ref_end.max(p.ref_end);
                continue;
            }
        }
        merged.push(p);
    }
    merged
}

// ---- 语音探针文本对齐（无声纹时：YouTube 字幕播 RSS 音频 / 旧共享字幕 / Podscribe 等）----

fn is_cjk_char(c: char) -> bool {
    matches!(c, '\u{3040}'..='\u{30ff}' | '\u{4e00}'..='\u{9fff}' | '\u{ac00}'..='\u{d7af}')
}

/// 将一段字幕拆成带相对位置比例的小写词 / 单个 CJK 字。
fn text_tokens(text: &str) -> Vec<(String, f64)> {
    let total = text.chars().count().max(1) as f64;
    let mut out = Vec::new();
    let mut word = String::new();
    let mut word_pos = 0usize;
    for (idx, ch) in text.chars().enumerate() {
        if ch.is_alphanumeric() && !is_cjk_char(ch) {
            if word.is_empty() {
                word_pos = idx;
            }
            for lc in ch.to_lowercase() {
                word.push(lc);
            }
        } else {
            if !word.is_empty() {
                out.push((std::mem::take(&mut word), word_pos as f64 / total));
            }
            if is_cjk_char(ch) {
                out.push((ch.to_string(), idx as f64 / total));
            }
        }
    }
    if !word.is_empty() {
        out.push((word, word_pos as f64 / total));
    }
    out
}

fn flatten_timed_tokens(segments: &[Segment]) -> Vec<(String, f64)> {
    let mut out = Vec::new();
    for s in segments {
        let dur = (s.end - s.start).max(0.0);
        for (tok, ratio) in text_tokens(&s.text) {
            out.push((tok, s.start + ratio * dur));
        }
    }
    out
}

/// 首轮采样起点：每隔 `stride` 秒取一段探针。
pub fn initial_probe_points(duration: f64, stride: f64) -> Vec<f64> {
    let mut points = Vec::new();
    let mut t = 15.0_f64.min(duration / 4.0);
    while t + PROBE_LEN_SECS <= duration {
        points.push(t);
        t += stride;
    }
    points
}

/// 在偏移发生跳变的相邻锚点之间补探针，精确定位广告/剪辑边界。
pub fn refinement_probe_points(anchors: &[(f64, f64)]) -> Vec<f64> {
    let mut sorted = anchors.to_vec();
    sorted.sort_by(|a, b| a.1.total_cmp(&b.1));
    let mut extra = Vec::new();
    for pair in sorted.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        let off_a = a.1 - a.0;
        let off_b = b.1 - b.0;
        if (off_b - off_a).abs() < OFFSET_TOLERANCE_SECS || b.1 - a.1 < PROBE_LEN_SECS * 1.5 {
            continue;
        }
        let count = (((b.1 - a.1) / PROBE_LEN_SECS).floor() as usize).clamp(1, 4);
        for step in 1..=count {
            let center = a.1 + (b.1 - a.1) * (step as f64 / (count + 1) as f64);
            extra.push((center - PROBE_LEN_SECS / 2.0).max(0.0));
        }
    }
    extra
}

/// 将拼接探针 WAV 的识别结果 `recognized` 在 `subtitles` 里做 4-gram 定位，返回 `(字幕时间, 播放时间)` 锚点。
pub fn locate_probes(
    subtitles: &[Segment],
    recognized: &[Segment],
    starts: &[f64],
) -> Vec<(f64, f64)> {
    const NGRAM: usize = 4;
    let ref_toks = flatten_timed_tokens(subtitles);
    if ref_toks.len() < NGRAM {
        return Vec::new();
    }
    let ref_words: Vec<&str> = ref_toks.iter().map(|(w, _)| w.as_str()).collect();
    let mut lookup: HashMap<&[&str], Vec<usize>> = HashMap::new();
    for i in 0..=ref_words.len() - NGRAM {
        lookup.entry(&ref_words[i..i + NGRAM]).or_default().push(i);
    }

    let mut anchors = Vec::new();
    for (slot, &play_origin) in starts.iter().enumerate() {
        let slot_lo = slot as f64 * SLOT_LEN_SECS;
        let slot_hi = slot_lo + SLOT_LEN_SECS;
        let slot_segs: Vec<Segment> = recognized
            .iter()
            .filter(|s| s.start >= slot_lo && s.start < slot_hi)
            .cloned()
            .collect();
        let heard = flatten_timed_tokens(&slot_segs);
        if heard.len() < NGRAM {
            continue;
        }
        let heard_words: Vec<&str> = heard.iter().map(|(w, _)| w.as_str()).collect();
        let mut candidates: Vec<(f64, f64)> = Vec::new();
        for j in 0..=heard_words.len() - NGRAM {
            let Some(hits) = lookup.get(&heard_words[j..j + NGRAM]) else {
                continue;
            };
            if hits.len() > 3 {
                continue; // 常见套话跳过
            }
            let play_t = play_origin + (heard[j].1 - slot_lo);
            for &h in hits {
                candidates.push((ref_toks[h].1, play_t));
            }
        }
        if candidates.len() < 3 {
            continue;
        }
        let offsets: Vec<f64> = candidates.iter().map(|(r, p)| p - r).collect();
        let Some(best_off) = offsets
            .iter()
            .copied()
            .max_by_key(|o| offsets.iter().filter(|x| (*x - o).abs() <= 2.0).count())
        else {
            continue;
        };
        let mut cluster: Vec<(f64, f64)> = candidates
            .into_iter()
            .filter(|(r, p)| ((p - r) - best_off).abs() <= 2.0)
            .collect();
        if cluster.len() < 3 {
            continue;
        }
        cluster.sort_by(|a, b| (a.1 - a.0).total_cmp(&(b.1 - b.0)));
        anchors.push(cluster[cluster.len() / 2]);
    }
    anchors
}

/// 由 `(字幕时间, 播放时间)` 锚点构造成单调分段 `Piece` 列表（自动剔除孤立误匹配）。
pub fn build_pieces_from_anchors(anchors: &[(f64, f64)]) -> Vec<Piece> {
    if anchors.is_empty() {
        return Vec::new();
    }
    let mut pts = anchors.to_vec();
    pts.sort_by(|a, b| a.1.total_cmp(&b.1));

    let off = |p: (f64, f64)| p.1 - p.0;
    let same = |a: (f64, f64), b: (f64, f64)| (off(a) - off(b)).abs() < OFFSET_TOLERANCE_SECS;

    // 剔除与左右邻居都不一致、而左右邻居彼此一致的孤立离群点（重复口癖）
    let cleaned: Vec<(f64, f64)> = (0..pts.len())
        .filter(|&i| {
            let prev = i.checked_sub(1).map(|k| pts[k]);
            let next = pts.get(i + 1).copied();
            match (prev, next) {
                (Some(a), Some(b)) => same(pts[i], a) || same(pts[i], b) || !same(a, b),
                (None, Some(b)) => {
                    same(pts[i], b) || pts.get(i + 2).is_none_or(|&c| !same(b, c))
                }
                (Some(a), None) => same(pts[i], a) || i < 2 || !same(a, pts[i - 2]),
                (None, None) => true,
            }
        })
        .map(|i| pts[i])
        .collect();

    let mut groups: Vec<Vec<(f64, f64)>> = Vec::new();
    for p in cleaned {
        let fits = groups.last().is_some_and(|g| {
            let avg = g.iter().map(|&q| off(q)).sum::<f64>() / g.len() as f64;
            (avg - off(p)).abs() < OFFSET_TOLERANCE_SECS
        });
        if fits {
            groups.last_mut().unwrap().push(p);
        } else {
            groups.push(vec![p]);
        }
    }

    let median_offset = |g: &[(f64, f64)]| {
        let mut os: Vec<f64> = g.iter().map(|&q| off(q)).collect();
        os.sort_by(f64::total_cmp);
        os[os.len() / 2]
    };

    let mut pieces: Vec<Piece> = Vec::new();
    for (idx, g) in groups.iter().enumerate() {
        let o = median_offset(g);
        let first_p = g[0].1;
        let last_p = g[g.len() - 1].1;
        let start_p = if idx == 0 {
            first_p
        } else {
            let prev_last = groups[idx - 1].last().unwrap().1;
            (prev_last + first_p) / 2.0
        };
        let end_p = if idx + 1 == groups.len() {
            last_p
        } else {
            let next_first = groups[idx + 1][0].1;
            (last_p + next_first) / 2.0
        };
        let mut ref_start = start_p - o;
        let mut play_start = start_p;
        if let Some(prev) = pieces.last() {
            if ref_start < prev.ref_end {
                ref_start = prev.ref_end;
                play_start = ref_start + o;
            }
        }
        let ref_end = (end_p - o).max(ref_start);
        pieces.push(Piece {
            ref_start,
            ref_end,
            play_start,
        });
    }
    pieces
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synth_fp(len: usize, seed: u32) -> Vec<u32> {
        let mut state = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state
            })
            .collect()
    }

    #[test]
    fn fingerprint_detects_inserted_and_swapped_ads() {
        let part_a = synth_fp(900, 11);
        let old_ad = synth_fp(250, 22);
        let part_b = synth_fp(1100, 33);
        let reference = [&part_a[..], &old_ad[..], &part_b[..]].concat();
        let playing = [
            &synth_fp(120, 44)[..],
            &part_a[..],
            &synth_fp(420, 55)[..],
            &part_b[..],
        ]
        .concat();

        let pieces = match_fingerprints(&reference, &playing);
        assert_eq!(pieces.len(), 2, "{pieces:?}");
        assert!(((pieces[0].play_start - pieces[0].ref_start) - 120.0 * FRAME_SECS).abs() < 0.25);
        assert!(
            ((pieces[1].play_start - pieces[1].ref_start) - (120.0 + 420.0 - 250.0) * FRAME_SECS)
                .abs()
                < 0.25
        );
    }

    #[test]
    fn probes_locate_offset_for_latin_and_cjk() {
        let en = "artificial intelligence is transforming mathematics and physics research across every major university department worldwide";
        let words: Vec<&str> = en.split_whitespace().collect();
        let subs: Vec<Segment> = words
            .chunks(4)
            .enumerate()
            .map(|(i, w)| Segment {
                start: i as f64 * 2.5,
                end: (i + 1) as f64 * 2.5,
                text: w.join(" "),
            })
            .collect();
        let heard = vec![Segment {
            start: 0.0,
            end: subs.last().unwrap().end,
            text: en.into(),
        }];
        let anchors = locate_probes(&subs, &heard, &[480.0]);
        assert_eq!(anchors.len(), 1);
        assert!(((anchors[0].1 - anchors[0].0) - 480.0).abs() < 1.5, "{anchors:?}");

        let zh = "欢迎回到我们的播客节目今天我们聊人工智能与数学研究的最新进展和未来方向";
        let zh_subs = vec![Segment {
            start: 10.0,
            end: 25.0,
            text: zh.into(),
        }];
        let zh_heard = vec![Segment {
            start: 0.0,
            end: 15.0,
            text: zh.into(),
        }];
        let zh_anchors = locate_probes(&zh_subs, &zh_heard, &[70.0]);
        assert_eq!(zh_anchors.len(), 1);
        assert!(((zh_anchors[0].1 - zh_anchors[0].0) - 60.0).abs() < 1.5, "{zh_anchors:?}");
    }

    #[test]
    fn anchors_ignore_outlier_and_build_monotonic_pieces() {
        let pts = [
            (60.0, 60.0),
            (180.0, 180.5),
            (300.0, 999.0), // outlier
            (420.0, 420.2),
            (600.0, 645.0),
            (780.0, 825.4),
        ];
        let pieces = build_pieces_from_anchors(&pts);
        assert_eq!(pieces.len(), 2, "{pieces:?}");
        assert!((pieces[0].play_start - pieces[0].ref_start).abs() < 1.0);
        assert!((pieces[1].play_start - pieces[1].ref_start - 45.0).abs() < 1.0);
        assert!(pieces[1].ref_start >= pieces[0].ref_end);
    }

    #[test]
    fn fp_base64_roundtrip() {
        let orig = synth_fp(16, 7);
        let decoded = decode_fp(&encode_fp(&orig)).unwrap();
        assert_eq!(orig, decoded);
    }
}
