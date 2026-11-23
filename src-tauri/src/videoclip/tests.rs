/**
 * [INPUT]: 依赖 videoclip 的私有项（covering_cache / slug / prepare_segment / render）与本机 FFmpeg（缺失则跳过）
 * [OUTPUT]: 缓存命名与覆盖查找单测；离线全链路冒烟（种子缓存 → 覆盖截取 → 体检 → 闪现 / 停留 / 倍速导出）
 * [POS]: videoclip 的集成测试，不联网；分片下载与 yt-dlp 兜底依赖真实 YouTube，不在此覆盖
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use super::*;
use base64::Engine;

fn temp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("subpodcast-{name}-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn slug_and_covering_cache() {
    assert_eq!(slug("ab-C_9"), "ab-C_9");
    assert_eq!(slug("../x"), "___x");
    assert_eq!(slug(""), "clip");

    let d = temp("cover");
    std::fs::write(d.join("10000-90000.mp4"), vec![0u8; 20_000]).unwrap();
    std::fs::write(d.join("20000-50000.mp4"), vec![0u8; 20_000]).unwrap();
    std::fs::write(d.join("21000-49000.mp4"), vec![0u8; 100]).unwrap();
    std::fs::write(d.join("montage-abc.mp4"), vec![0u8; 20_000]).unwrap();
    assert_eq!(covering_cache(&d, 22_000, 45_000).map(|c| c.1), Some(20_000));
    assert!(covering_cache(&d, 5_000, 45_000).is_none());
    let _ = std::fs::remove_dir_all(&d);
}

fn png(bin: &Path, spec: &str) -> String {
    let out = std::process::Command::new(bin)
        .args(["-v", "error", "-f", "lavfi", "-i", spec, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"])
        .output()
        .unwrap();
    assert!(out.status.success() && !out.stdout.is_empty());
    base64::engine::general_purpose::STANDARD.encode(out.stdout)
}

fn request(raw: &str, out: &Path, duration: f64) -> RenderRequest {
    RenderRequest {
        frame: None,
        lead: 0.0,
        speed: 1.0,
        output_dir: None,
        raw_path: raw.into(),
        output_path: Some(out.to_string_lossy().into_owned()),
        default_name: "smoke".into(),
        layout: "portrait_card".into(),
        card_bg: "night".into(),
        crop_x: 0.5,
        duration,
        static_overlay_png: None,
        cues: vec![],
        cover_png: None,
        cover_mode: "none".into(),
        embed_thumbnail: false,
        save_cover_sidecar: false,
        landscape_cover_png: None,
    }
}

#[tokio::test]
async fn offline_pipeline_smoke() {
    let data = temp("vclip");
    let Some(bin) = ffmpeg::find(&data) else { return };

    // 种子：缓存里已有 0–4 s 的片段，取 1–3 s 应走「覆盖缓存截取」，不联网。
    let dir = work_dir(&data, "smokevid");
    std::fs::create_dir_all(&dir).unwrap();
    let made = std::process::Command::new(&bin)
        .args([
            "-v", "error", "-y",
            "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=4",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
            "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
        ])
        .arg(dir.join("0-4000.mp4"))
        .status()
        .unwrap();
    assert!(made.success());

    let never = AtomicBool::new(false);
    let mut stages = Vec::new();
    let clip = prepare_segment(&data, "smokevid", 1.0, 3.0, &never, |s, _, _| stages.push(s.to_string()))
        .await
        .unwrap();
    assert!(stages.iter().any(|s| s == "trim"), "{stages:?}");
    assert!((clip.duration - 2.0).abs() < 0.2, "{}", clip.duration);
    assert_eq!((clip.width, clip.height, clip.lead), (640, 360, 0.0));
    assert!(!clip.frames.is_empty() && clip.best_frame < clip.frames.len());
    assert!(clip.frames[0].starts_with("data:image/jpeg;base64,"));
    let again = prepare_segment(&data, "smokevid", 1.0, 3.0, &never, |_, _, _| {}).await.unwrap();
    assert!(again.cached && again.frames == clip.frames);

    let flash_out = data.join("flash.mp4");
    let mut flash = request(&clip.path, &flash_out, clip.duration);
    flash.static_overlay_png = Some(png(&bin, "color=c=white@0.0:s=1080x1920,format=rgba"));
    flash.cues = vec![CueOverlay {
        start: 0.2,
        end: 1.5,
        y: 1320,
        png_base64: png(&bin, "color=c=yellow@0.7:s=1080x160,format=rgba"),
    }];
    flash.cover_png = Some(png(&bin, "color=c=gray:s=1080x1920,format=rgba"));
    flash.cover_mode = "flash".into();
    flash.embed_thumbnail = true;
    flash.save_cover_sidecar = true;
    flash.landscape_cover_png = Some(png(&bin, "color=c=gray:s=1920x1080,format=rgba"));
    let res = render(&data, flash, &never, |_, _, _| {}).await.unwrap();
    let meta = ffmpeg::probe(&bin, Path::new(&res.video_path)).await.unwrap();
    assert_eq!((meta.width, meta.height), (1080, 1920));
    assert!(meta.has_audio && (meta.duration - 2.0).abs() < 0.3, "{meta:?}");
    assert!(Path::new(res.cover_path.as_deref().unwrap()).is_file());
    assert!(Path::new(res.landscape_cover_path.as_deref().unwrap()).is_file());

    let hold_out = data.join("hold.mp4");
    let mut hold = request(&clip.path, &hold_out, clip.duration);
    hold.card_bg = "blur".into();
    hold.speed = 2.0;
    hold.cover_png = Some(png(&bin, "color=c=white:s=1080x1920,format=rgba"));
    hold.cover_mode = "hold".into();
    let res = render(&data, hold, &never, |_, _, _| {}).await.unwrap();
    let meta = ffmpeg::probe(&bin, Path::new(&res.video_path)).await.unwrap();
    assert!(meta.has_audio && (meta.duration - 2.0).abs() < 0.3, "{meta:?}");
    assert!(res.cover_path.is_none());

    let _ = std::fs::remove_dir_all(&data);
}

/// 真实 YouTube：快速分片取一段 + 两段蒙太奇（--ignored 手动跑）。
#[tokio::test]
#[ignore = "需要网络"]
async fn live_youtube_section_and_montage() {
    let data = temp("vclip-live");
    let never = AtomicBool::new(false);
    let t = std::time::Instant::now();
    let clip = prepare_segment(&data, "jNQXAC9IVRw", 3.0, 12.0, &never, |s, p, m| {
        eprintln!("T+{:.1}s {s} {p:.2} {m}", t.elapsed().as_secs_f64())
    })
    .await
    .unwrap();
    eprintln!("{clip:?}", clip = (clip.width, clip.height, clip.duration, clip.lead, clip.has_burned_subtitles));
    assert!((clip.duration - 9.0).abs() < 0.5 && !clip.frames.is_empty());
    let m = prepare_montage(&data, "jNQXAC9IVRw", &[(1.0, 4.0), (8.0, 11.0)], &never, |_, _, _| {})
        .await
        .unwrap();
    assert!((m.duration - 6.0).abs() < 0.5, "{}", m.duration);
    let _ = std::fs::remove_dir_all(&data);
}
