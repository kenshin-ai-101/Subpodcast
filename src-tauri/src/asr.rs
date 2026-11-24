/**
 * [INPUT]: net、ytdlp、model::Segment、symphonia、whisper-rs、CrispASR CLI
 * [OUTPUT]: 本机模型；youtube_audio（原生 m4a）；decode_16k_mono_progressive（字节进度）；Qwen3/Whisper
 * [POS]: 官方字幕之后的本机识别；ASR 选源离线→enclosure 直链→YT（直链优先以免 twin 拖慢）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use crate::model::Segment;
use crate::net;
use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub struct ModelSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub engine: &'static str, // whisper | qwen3
    pub repo: &'static str,
    pub file: &'static str,
    pub size_mb: u32,
    pub note: &'static str,
}

pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "qwen3-asr",
        name: "Qwen3-ASR 0.6B（推荐）",
        engine: "qwen3",
        repo: "cstr/qwen3-asr-0.6b-GGUF",
        file: "qwen3-asr-0.6b-q8_0.gguf",
        size_mb: 960,
        note: "中英文准，自带标点；首次另需约 20 MB 识别程序",
    },
    ModelSpec {
        id: "large-v3-turbo",
        name: "Whisper large-v3-turbo",
        engine: "whisper",
        repo: "ggerganov/whisper.cpp",
        file: "ggml-large-v3-turbo-q5_0.bin",
        size_mb: 547,
        note: "语种多；Apple 芯片约 3–5 分钟/小时音频",
    },
    ModelSpec {
        id: "small",
        name: "Whisper small",
        engine: "whisper",
        repo: "ggerganov/whisper.cpp",
        file: "ggml-small-q5_1.bin",
        size_mb: 181,
        note: "体积小、速度快",
    },
    ModelSpec {
        id: "base",
        name: "Whisper base",
        engine: "whisper",
        repo: "ggerganov/whisper.cpp",
        file: "ggml-base-q5_1.bin",
        size_mb: 57,
        note: "最快，适合试用",
    },
];

pub fn spec(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub engine: String,
    pub size_mb: u32,
    pub note: String,
    pub installed: bool,
    /// 软链指向的来源（如 SubCast / Hugging Face 缓存）；自下则为 None
    pub from: Option<String>,
}

pub fn models_dir(data: &Path) -> PathBuf {
    data.join("models")
}

fn engine_of(name: &str) -> Option<&'static str> {
    let n = name.to_lowercase();
    if n.starts_with("ggml-") && n.ends_with(".bin") && !n.contains("silero") && !n.contains("vad") {
        Some("whisper")
    } else if n.starts_with("qwen3-asr") && n.ends_with(".gguf") {
        Some("qwen3")
    } else {
        None
    }
}

fn looks_like_model(path: &Path, engine: &str) -> bool {
    use std::io::Read;
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    let min = if engine == "qwen3" { 300 } else { 30 } * 1_048_576;
    if meta.len() < min {
        return false;
    }
    let mut magic = [0u8; 4];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut magic))
        .is_ok()
        && if engine == "qwen3" {
            &magic == b"GGUF"
        } else {
            &magic == b"lmgg" || &magic == b"ggjt" || &magic == b"GGUF"
        }
}

fn linked_from(path: &Path) -> Option<String> {
    let target = std::fs::read_link(path).ok()?;
    let s = target.to_string_lossy();
    if s.contains("huggingface") {
        return Some("Hugging Face 缓存".into());
    }
    if s.contains("ai.qiaomu.subcast") || s.contains("/SubCast/") {
        return Some("SubCast".into());
    }
    for marker in ["Application Support/", "Containers/"] {
        if let Some(i) = s.find(marker) {
            if let Some(n) = s[i + marker.len()..].split('/').next() {
                return Some(n.to_string());
            }
        }
    }
    target
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
}

/// 优先扫这些目录（同机 SubCast / HF 缓存），再浅扫 Application Support。
fn model_roots() -> Vec<(PathBuf, usize)> {
    let h = dirs::home_dir().unwrap_or_default();
    let mut v = Vec::new();
    if let Some(d) = dirs::data_dir() {
        // 原站与常见姊妹应用的 models 目录：直接命中，不必全盘漫游
        for name in ["ai.qiaomu.subcast", "SubCast", "subcast", "Subpodcast"] {
            v.push((d.join(name).join("models"), 1));
            v.push((d.join(name), 2));
        }
        v.push((d.clone(), 3));
    }
    v.push((h.join(".cache/huggingface/hub"), 5));
    v.push((h.join(".cache"), 3));
    v.push((h.join("Downloads"), 1));
    v
}

static SCANNED: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);

/// 强制下次 list/resolve 再扫本机（设置「重新查找」）。
pub fn rescan() {
    *SCANNED.lock().unwrap() = None;
}

/// 把本机已有的同名模型软链进我们的 models/（不复制；删链不影响原件）。最多每分钟扫一次。
fn adopt_found(data: &Path) {
    {
        let mut last = SCANNED.lock().unwrap();
        if last.is_some_and(|t| t.elapsed().as_secs() < 60) {
            return;
        }
        *last = Some(std::time::Instant::now());
    }
    let dir = models_dir(data);
    let _ = std::fs::create_dir_all(&dir);
    let own = dir.canonicalize().unwrap_or(dir.clone());
    let mut found: Vec<PathBuf> = Vec::new();

    fn walk(p: &Path, depth: usize, own: &Path, out: &mut Vec<PathBuf>, budget: &mut usize) {
        if *budget == 0 {
            return;
        }
        let Ok(rd) = std::fs::read_dir(p) else {
            return;
        };
        for e in rd.flatten() {
            *budget = budget.saturating_sub(1);
            if *budget == 0 {
                return;
            }
            let Ok(ft) = e.file_type() else {
                continue;
            };
            let path = e.path();
            if path.starts_with(own) {
                continue;
            }
            // 跳过指向别处的软链，避免环；HF 缓存里的 blob 链保留
            if ft.is_symlink() && !path.to_string_lossy().contains("huggingface") {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if (ft.is_file() || ft.is_symlink()) && engine_of(&name).is_some() {
                out.push(path.clone());
            } else if ft.is_dir() && depth > 0 {
                if matches!(
                    name.as_str(),
                    "node_modules" | "Caches" | "Logs" | "CrashReporter" | "Photos" | "MobileSync"
                ) {
                    continue;
                }
                if name.starts_with('.') && name != ".cache" && !name.starts_with("models--") {
                    continue;
                }
                walk(&path, depth - 1, own, out, budget);
            }
        }
    }

    let mut budget = 40_000;
    for (root, depth) in model_roots() {
        walk(&root, depth, &own, &mut found, &mut budget);
    }

    for src in found {
        let Some(name) = src.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        let Some(engine) = engine_of(&name) else {
            continue;
        };
        // 只收养目录里登记的文件名，避免杂乱 ggml 误入
        if !MODELS.iter().any(|m| m.file == name) {
            continue;
        }
        let real = src.canonicalize().unwrap_or(src.clone());
        let dest = dir.join(&name);
        if dest.exists() || !looks_like_model(&real, engine) {
            continue;
        }
        // llama.cpp 分体（同目录 mmproj）CrispASR 用不了
        if engine == "qwen3"
            && real
                .parent()
                .and_then(|d| std::fs::read_dir(d).ok())
                .is_some_and(|rd| {
                    rd.flatten()
                        .any(|e| e.file_name().to_string_lossy().to_lowercase().starts_with("mmproj"))
                })
        {
            continue;
        }
        #[cfg(unix)]
        let _ = std::os::unix::fs::symlink(&real, &dest);
        #[cfg(windows)]
        {
            let _ = std::fs::hard_link(&real, &dest)
                .or_else(|_| std::os::windows::fs::symlink_file(&real, &dest));
        }
    }
}

pub fn list_models(data: &Path) -> Vec<ModelInfo> {
    adopt_found(data);
    let dir = models_dir(data);
    MODELS
        .iter()
        .map(|m| {
            let path = dir.join(m.file);
            ModelInfo {
                id: m.id.into(),
                name: m.name.into(),
                engine: m.engine.into(),
                size_mb: m.size_mb,
                note: m.note.into(),
                installed: path.is_file(),
                from: linked_from(&path),
            }
        })
        .collect()
}

pub struct Resolved {
    #[allow(dead_code)]
    pub id: String,
    pub engine: &'static str,
    pub path: PathBuf,
}

pub fn resolve(data: &Path, id: &str) -> Option<Resolved> {
    adopt_found(data);
    let m = spec(id)?;
    Some(Resolved {
        id: m.id.into(),
        engine: m.engine,
        path: models_dir(data).join(m.file),
    })
}

pub fn delete_model(data: &Path, id: &str) -> Result<()> {
    let m = spec(id).ok_or_else(|| anyhow!("未知模型"))?;
    let path = models_dir(data).join(m.file);
    // 只删我们这边的文件/软链，绝不碰原站或 HF 缓存里的原件
    if path.is_symlink() || path.is_file() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

pub async fn download_file(
    url: &str,
    dest: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<()> {
    let res = net::client().get(url).send().await?;
    if !res.status().is_success() {
        return Err(anyhow!("下载失败（{}）", res.status().as_u16()));
    }
    let total = res.content_length();
    let part = dest.with_extension("part");
    if let Some(dir) = dest.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let mut file = tokio::fs::File::create(&part).await?;
    let mut stream = res.bytes_stream();
    let mut received = 0u64;
    let mut last = std::time::Instant::now();
    let dl: Result<()> = async {
        while let Some(chunk) = stream.next().await {
            if cancel.load(Ordering::Relaxed) {
                return Err(anyhow!("已取消"));
            }
            let chunk = chunk?;
            file.write_all(&chunk).await?;
            received += chunk.len() as u64;
            if last.elapsed().as_millis() > 200 {
                // 无 Content-Length 时用渐进估值，避免界面一直停在 0%
                let report_total = total.or_else(|| Some((received * 5 / 4).max(received + 1)));
                progress(received, report_total);
                last = std::time::Instant::now();
            }
        }
        file.flush().await?;
        if let Some(t) = total {
            if received < t {
                return Err(anyhow!("下载不完整"));
            }
        }
        Ok(())
    }
    .await;
    drop(file);
    if let Err(err) = dl {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(err);
    }
    if let Err(err) = tokio::fs::rename(&part, dest).await {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(err.into());
    }
    progress(received, total);
    Ok(())
}

pub async fn download_model(
    data: &Path,
    id: &str,
    cancel: &AtomicBool,
    mirror_first: bool,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<()> {
    let m = spec(id).ok_or_else(|| anyhow!("未知模型"))?;
    let dest = models_dir(data).join(m.file);
    let hosts = if mirror_first {
        ["hf-mirror.com", "huggingface.co"]
    } else {
        ["huggingface.co", "hf-mirror.com"]
    };
    let mut err = anyhow!("下载失败");
    for host in hosts {
        let url = format!("https://{host}/{}/resolve/main/{}", m.repo, m.file);
        match download_file(&url, &dest, cancel, &mut progress).await {
            Ok(()) => return Ok(()),
            Err(e) if cancel.load(Ordering::Relaxed) => return Err(e),
            Err(e) => err = e,
        }
    }
    Err(err)
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

const CRISPASR_VERSION: &str = "v0.8.54";

fn crispasr_asset() -> Option<&'static str> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("crispasr-macos-arm64.tar.gz")
    } else if cfg!(target_os = "macos") {
        Some("crispasr-macos-x86_64.tar.gz")
    } else if cfg!(windows) {
        Some("crispasr-windows-x86_64-cpu.zip")
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some("crispasr-linux-arm64.tar.gz")
    } else if cfg!(target_os = "linux") {
        Some("crispasr-linux-x86_64.tar.gz")
    } else {
        None
    }
}

fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(f) = find_file(&p, name) {
                return Some(f);
            }
        } else if p.file_name().is_some_and(|n| n == name) {
            return Some(p);
        }
    }
    None
}

pub fn find_crispasr(data: &Path) -> Option<PathBuf> {
    find_file(&data.join("bin").join(format!("crispasr-{CRISPASR_VERSION}")), &exe("crispasr"))
}

pub async fn ensure_crispasr(
    data: &Path,
    cancel: &AtomicBool,
    progress: impl FnMut(u64, Option<u64>),
) -> Result<PathBuf> {
    if let Some(p) = find_crispasr(data) {
        return Ok(p);
    }
    let asset = crispasr_asset().ok_or_else(|| anyhow!("这个系统暂不支持 Qwen3-ASR"))?;
    let archive = data.join("bin").join(asset);
    download_file(
        &format!("https://github.com/CrispStrobe/CrispASR/releases/download/{CRISPASR_VERSION}/{asset}"),
        &archive,
        cancel,
        progress,
    )
    .await?;
    let dest = data.join("bin").join(format!("crispasr-{CRISPASR_VERSION}"));
    let (a, d) = (archive.clone(), dest.clone());
    tokio::task::spawn_blocking(move || -> Result<()> {
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d)?;
        let file = std::fs::File::open(&a)?;
        if a.extension().is_some_and(|e| e == "zip") {
            zip::ZipArchive::new(file)?.extract(&d)?;
        } else {
            tar::Archive::new(flate2::read::GzDecoder::new(file)).unpack(&d)?;
        }
        Ok(())
    })
    .await??;
    let _ = std::fs::remove_file(&archive);
    let bin = find_crispasr(data).ok_or_else(|| anyhow!("识别程序安装不完整"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(bin)
}

/// URL 末尾扩展名；播客 enclosure 常带 query，取不到时默认 mp3。
pub fn audio_ext(url: &str) -> String {
    url.split('?')
        .next()
        .and_then(|u| u.rsplit('/').next())
        .and_then(|f| f.rsplit_once('.'))
        .map(|(_, x)| x)
        .filter(|x| (2..=5).contains(&x.len()) && x.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("mp3")
        .to_lowercase()
}

/// 直下播客 enclosure 到 dest（带进度）。小宇宙 dts-api 先还原成 xyzcdn 直链。
pub async fn download_audio_url(
    url: &str,
    dest: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f64),
) -> Result<()> {
    let url = crate::shared::canonical_audio_url(url);
    download_file(&url, dest, cancel, |recv, total| {
        if let Some(t) = total.filter(|t| *t > 0) {
            progress((recv as f64 / t as f64).clamp(0.0, 1.0));
        }
    })
    .await
}

/// 复用本集已下载过的音频：offline downloads/ 或未清理的 work/{id}-*/audio.*。
pub fn find_cached_audio(data: &Path, episode_id: &str) -> Option<PathBuf> {
    if let Some(s) = crate::offline::find(data, episode_id) {
        let p = PathBuf::from(s.path);
        if p.is_file() {
            return Some(p);
        }
    }
    let work = data.join("work");
    let Ok(rd) = std::fs::read_dir(&work) else {
        return None;
    };
    let prefix = format!("{episode_id}-");
    let mut best: Option<(u64, PathBuf)> = None;
    for ent in rd.flatten() {
        let dir = ent.path();
        if !dir.is_dir() {
            continue;
        }
        let name = ent.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(&prefix) {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&dir) else {
            continue;
        };
        for f in files.flatten() {
            let p = f.path();
            let Some(fname) = p.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !fname.starts_with("audio.") || fname.ends_with(".part") || fname.ends_with(".wav") {
                continue;
            }
            let len = f.metadata().map(|m| m.len()).unwrap_or(0);
            if len < 64_000 {
                continue;
            }
            if best.as_ref().map(|(n, _)| len > *n).unwrap_or(true) {
                best = Some((len, p));
            }
        }
    }
    best.map(|(_, p)| p)
}

/// YouTube：直下原生 m4a / AAC，不经 ffmpeg `-x` remux。
pub async fn youtube_audio(
    data: &Path,
    video_id: &str,
    dir: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf> {
    youtube_audio_with_progress(data, video_id, dir, cancel, |_| {}).await
}

/// 同上，并从 yt-dlp stderr 解析下载百分比（0–1）。
pub async fn youtube_audio_with_progress(
    data: &Path,
    video_id: &str,
    dir: &Path,
    cancel: Arc<AtomicBool>,
    on_progress: impl FnMut(f64) + Send + 'static,
) -> Result<PathBuf> {
    let ytdlp = crate::ytdlp::ensure_ytdlp(data).await?;
    let progress = Arc::new(std::sync::Mutex::new(Box::new(on_progress)
        as Box<dyn FnMut(f64) + Send>));
    crate::ytdlp::with_bot_fallback(|extra| {
        let (y, v, d, c, p) = (
            ytdlp.clone(),
            video_id.to_string(),
            dir.to_path_buf(),
            cancel.clone(),
            progress.clone(),
        );
        async move {
            let x: Vec<&str> = extra.iter().map(String::as_str).collect();
            youtube_audio_with(&y, &v, &d, c, &x, p).await
        }
    })
    .await
}

fn parse_ytdlp_pct(line: &str) -> Option<f64> {
    // [download]  45.2% of …
    let i = line.find('%')?;
    let start = line[..i].rfind(|c: char| c.is_ascii_whitespace() || c == ']')? + 1;
    line[start..i]
        .trim()
        .parse::<f64>()
        .ok()
        .map(|p| (p / 100.0).clamp(0.0, 0.99))
}

async fn youtube_audio_with(
    ytdlp: &Path,
    video_id: &str,
    dir: &Path,
    cancel: Arc<AtomicBool>,
    extra: &[&str],
    progress: Arc<std::sync::Mutex<Box<dyn FnMut(f64) + Send>>>,
) -> Result<PathBuf> {
    tokio::fs::create_dir_all(dir).await?;
    let template = dir.join(format!("{video_id}.%(ext)s"));
    crate::ytdlp::warm_ytdlp(ytdlp).await;
    let mut cmd = crate::ytdlp::ytdlp_command(ytdlp);
    // 只要音轨；-N 并发拉 DASH 分片，避免单连接被油管限速拖死。
    cmd.args([
        "-f",
        "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio/best",
        "-N",
        "8",
        "--no-playlist",
        "--no-part",
        "--newline",
    ])
    .args(extra)
    .arg("-o")
    .arg(&template)
    .arg(format!("https://www.youtube.com/watch?v={video_id}"))
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().context("无法启动 yt-dlp")?;
    let mut lines = BufReader::new(child.stderr.take().unwrap()).lines();
    let mut last_line = String::new();
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill().await;
            return Err(anyhow!("已取消"));
        }
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                if let Some(p) = parse_ytdlp_pct(&line) {
                    if let Ok(mut f) = progress.lock() {
                        f(p);
                    }
                }
                last_line = line;
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(300)) => {
                if let Some(_status) = child.try_wait()? {
                    // 进程已退出但 stderr 管道可能还有最后几行 ERROR，继续 drain 到 EOF
                    while let Ok(Some(line)) = lines.next_line().await {
                        if !line.trim().is_empty() {
                            last_line = line;
                        }
                    }
                    break;
                }
            }
        }
    }
    let status = child.wait().await?;
    if !status.success() {
        return Err(anyhow!(
            "下载 YouTube 音频失败：{}",
            last_line.chars().take(200).collect::<String>()
        ));
    }
    if let Ok(mut f) = progress.lock() {
        f(1.0);
    }
    let mut entries = tokio::fs::read_dir(dir).await?;
    while let Some(e) = entries.next_entry().await? {
        if e.file_name().to_string_lossy().starts_with(video_id) {
            return Ok(e.path());
        }
    }
    Err(anyhow!("没有找到下载的音频"))
}

/// 离线下载用：有 enclosure 先直链，否则 YouTube 音轨。
pub async fn fetch_episode_audio(
    data: &Path,
    work: &Path,
    audio_url: Option<&str>,
    video_id: Option<&str>,
    cancel: Arc<AtomicBool>,
    mut progress: impl FnMut(f64),
) -> Result<PathBuf> {
    std::fs::create_dir_all(work)?;
    if let Some(url) = audio_url.filter(|u| !u.is_empty()) {
        let dest = work.join(format!("audio.{}", audio_ext(url)));
        download_audio_url(url, &dest, &cancel, &mut progress).await?;
        return Ok(dest);
    }
    let vid = video_id
        .filter(|v| !v.is_empty())
        .ok_or_else(|| anyhow!("这集没有可识别的音频"))?;
    progress(0.05);
    let found = youtube_audio(data, vid, work, cancel).await?;
    progress(1.0);
    Ok(found)
}

pub fn write_wav(path: &Path, samples: &[f32]) -> Result<()> {
    use std::io::Write;
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    let data_len = (samples.len() * 2) as u32;
    f.write_all(b"RIFF")?;
    f.write_all(&(36 + data_len).to_le_bytes())?;
    f.write_all(b"WAVEfmt ")?;
    f.write_all(&16u32.to_le_bytes())?;
    f.write_all(&1u16.to_le_bytes())?;
    f.write_all(&1u16.to_le_bytes())?;
    f.write_all(&16000u32.to_le_bytes())?;
    f.write_all(&32000u32.to_le_bytes())?;
    f.write_all(&2u16.to_le_bytes())?;
    f.write_all(&16u16.to_le_bytes())?;
    f.write_all(b"data")?;
    f.write_all(&data_len.to_le_bytes())?;
    for s in samples {
        f.write_all(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())?;
    }
    f.flush()?;
    Ok(())
}

pub struct Resampler {
    ratio: f64,
    width: usize,
    hist: std::collections::VecDeque<f32>,
    acc: f32,
    count: usize,
    prev: Option<f32>,
    next: usize,
    out: Vec<f32>,
}

impl Resampler {
    pub fn new(from: u32, to: u32) -> Self {
        let ratio = from as f64 / to as f64;
        let width = ratio.ceil().max(1.0) as usize;
        Self {
            ratio,
            width,
            hist: std::collections::VecDeque::with_capacity(width + 1),
            acc: 0.0,
            count: 0,
            prev: None,
            next: 0,
            out: Vec::new(),
        }
    }
    pub fn push(&mut self, x: f32) {
        let f = if self.width > 1 {
            self.acc += x;
            self.hist.push_back(x);
            if self.hist.len() > self.width {
                self.acc -= self.hist.pop_front().unwrap_or(0.0);
            }
            self.acc / self.hist.len() as f32
        } else {
            x
        };
        let i = self.count;
        self.count += 1;
        if let Some(p) = self.prev {
            loop {
                let pos = self.next as f64 * self.ratio;
                let j = pos as usize;
                if j + 1 != i {
                    break;
                }
                let frac = (pos - j as f64) as f32;
                self.out.push(p + (f - p) * frac);
                self.next += 1;
            }
        }
        self.prev = Some(f);
    }
    pub fn finish(mut self) -> Vec<f32> {
        let n = (self.count as f64 / self.ratio) as usize;
        if let Some(p) = self.prev {
            while self.next < n {
                self.out.push(p);
                self.next += 1;
            }
        }
        self.out.truncate(n);
        self.out
    }
}

/// 带字节进度的可读文件，供 symphonia 顺序解码时上报 0–1。
/// MediaSource 要求 Sync，进度走 mpsc::Sender（Sync），不用 FnMut。
struct ProgressFile {
    inner: std::fs::File,
    total: u64,
    pos: u64,
    last: std::time::Instant,
    cancel: Arc<AtomicBool>,
    progress: Option<std::sync::mpsc::Sender<f64>>,
}

impl std::io::Read for ProgressFile {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "已取消"));
        }
        let n = self.inner.read(buf)?;
        self.pos = self.pos.saturating_add(n as u64);
        if self.total > 0 && self.last.elapsed().as_millis() > 200 {
            if let Some(tx) = &self.progress {
                let _ = tx.send((self.pos as f64 / self.total as f64).clamp(0.0, 0.99));
            }
            self.last = std::time::Instant::now();
        }
        Ok(n)
    }
}

impl std::io::Seek for ProgressFile {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        self.pos = self.inner.seek(pos)?;
        Ok(self.pos)
    }
}

impl symphonia::core::io::MediaSource for ProgressFile {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        Some(self.total)
    }
}

pub fn decode_16k_mono(path: &Path) -> Result<Vec<f32>> {
    decode_16k_mono_progressive(path, Arc::new(AtomicBool::new(false)), None)
}

/// 解码为 16 kHz 单声道；优先选带 sample_rate 的音轨（避开 mp4 里的视频轨）。
/// `progress` 按已读字节发送 0–1。
pub fn decode_16k_mono_progressive(
    path: &Path,
    cancel: Arc<AtomicBool>,
    progress: Option<std::sync::mpsc::Sender<f64>>,
) -> Result<Vec<f32>> {
    use symphonia::core::{
        audio::SampleBuffer, codecs::DecoderOptions, errors::Error, formats::FormatOptions,
        io::MediaSourceStream, meta::MetadataOptions, probe::Hint,
    };
    let file = std::fs::File::open(path)?;
    let total = file.metadata().map(|m| m.len()).unwrap_or(0);
    let source = ProgressFile {
        inner: file,
        total,
        pos: 0,
        last: std::time::Instant::now(),
        cancel: cancel.clone(),
        progress,
    };
    let mss = MediaSourceStream::new(Box::new(source), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| anyhow!("无法识别音频格式：{e}"))?;
    let mut format = probed.format;
    // mp4 等容器里视频轨常排在前面；只认带采样率/声道的轨。
    let track = format
        .tracks()
        .iter()
        .find(|t| {
            t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL
                && (t.codec_params.sample_rate.is_some() || t.codec_params.channels.is_some())
        })
        .or_else(|| {
            format
                .tracks()
                .iter()
                .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        })
        .ok_or_else(|| anyhow!("没有音轨"))?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| anyhow!("不支持的音频编码：{e}"))?;
    let mut resampler: Option<Resampler> = None;
    let mut buf: Option<SampleBuffer<f32>> = None;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(anyhow!("已取消"));
        }
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::Interrupted => {
                return Err(anyhow!("已取消"));
            }
            Err(Error::ResetRequired) => break,
            Err(e) => return Err(anyhow!("读取音频失败：{e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(Error::DecodeError(_)) => continue,
            Err(e) => return Err(anyhow!("解码失败：{e}")),
        };
        let spec = *decoded.spec();
        let r = resampler.get_or_insert_with(|| Resampler::new(spec.rate, 16000));
        let channels = spec.channels.count().max(1);
        if buf.as_ref().is_none_or(|b| b.capacity() < decoded.capacity() * channels) {
            buf = Some(SampleBuffer::new(decoded.capacity() as u64, spec));
        }
        let b = buf.as_mut().unwrap();
        b.copy_interleaved_ref(decoded);
        for frame in b.samples().chunks(channels) {
            r.push(frame.iter().sum::<f32>() / channels as f32);
        }
    }
    Ok(resampler.map(Resampler::finish).unwrap_or_default())
}

/// 按原生采样率顺序解码为单声道分片回调，供声纹对齐流式消费（数小时音频也不占满内存）。
pub fn decode_mono_stream(
    path: &Path,
    mut on_chunk: impl FnMut(u32, &[f32]),
) -> Result<()> {
    use symphonia::core::{
        audio::SampleBuffer, codecs::DecoderOptions, errors::Error, formats::FormatOptions,
        io::MediaSourceStream, meta::MetadataOptions, probe::Hint,
    };
    let file = std::fs::File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| anyhow!("无法识别音频格式：{e}"))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| {
            t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL
                && (t.codec_params.sample_rate.is_some() || t.codec_params.channels.is_some())
        })
        .or_else(|| {
            format
                .tracks()
                .iter()
                .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        })
        .ok_or_else(|| anyhow!("没有音轨"))?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| anyhow!("不支持的音频编码：{e}"))?;
    let mut buf: Option<SampleBuffer<f32>> = None;
    let mut mono: Vec<f32> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(Error::ResetRequired) => break,
            Err(e) => return Err(anyhow!("读取音频失败：{e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(Error::DecodeError(_)) => continue,
            Err(e) => return Err(anyhow!("解码失败：{e}")),
        };
        let spec = *decoded.spec();
        let channels = spec.channels.count().max(1);
        if buf
            .as_ref()
            .is_none_or(|b| b.capacity() < decoded.capacity() * channels)
        {
            buf = Some(SampleBuffer::new(decoded.capacity() as u64, spec));
        }
        let b = buf.as_mut().unwrap();
        b.copy_interleaved_ref(decoded);
        mono.clear();
        for frame in b.samples().chunks(channels) {
            mono.push(frame.iter().sum::<f32>() / channels as f32);
        }
        if !mono.is_empty() {
            on_chunk(spec.rate, &mono);
        }
    }
    Ok(())
}

pub async fn run_crispasr(
    bin: &Path,
    model: &Path,
    wav: &Path,
    language: &str,
    cancel: Arc<AtomicBool>,
    mut on_progress: impl FnMut(f64),
) -> Result<Vec<Segment>> {
    let out = wav.with_extension("");
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("-m")
        .arg(model)
        .arg("-f")
        .arg(wav)
        .args(["-oj", "-np", "-pp"])
        .arg("-of")
        .arg(&out);
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8);
    cmd.args(["-t", &threads.to_string()]);
    if language == "auto" {
        cmd.args(["-l", "auto", "--lid-backend", "off"]);
    } else {
        cmd.args(["-l", language]);
    }
    cmd.kill_on_drop(true)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().context("无法启动 Qwen3-ASR 识别程序")?;
    let mut lines = BufReader::new(child.stderr.take().unwrap()).lines();
    let re = regex::Regex::new(r"progress\s*=\s*(\d+)%").unwrap();
    let mut tail: Vec<String> = Vec::new();
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill().await;
            return Err(anyhow!("已取消"));
        }
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                if let Some(c) = re.captures(&line) {
                    on_progress(c[1].parse::<f64>().unwrap_or(0.0) / 100.0);
                } else if !line.starts_with("ggml_") {
                    tail.push(line);
                    if tail.len() > 6 { tail.remove(0); }
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(300)) => {}
        }
    }
    let status = child.wait().await?;
    let json_path = out.with_extension("json");
    if !status.success() || !json_path.is_file() {
        return Err(anyhow!(
            "Qwen3-ASR 识别失败：{}",
            tail.last().cloned().unwrap_or_default()
        ));
    }
    let v: serde_json::Value = serde_json::from_str(&tokio::fs::read_to_string(&json_path).await?)?;
    let mut segs = Vec::new();
    for t in v["transcription"].as_array().into_iter().flatten() {
        let start = t["offsets"]["from"].as_f64().unwrap_or(0.0) / 1000.0;
        let end = t["offsets"]["to"].as_f64().unwrap_or(0.0) / 1000.0;
        let text = t["text"].as_str().unwrap_or("").trim();
        if !text.is_empty() {
            segs.extend(crate::captions::split_timed(text, start, end));
        }
    }
    Ok(segs)
}

pub enum WorkerEvent {
    Progress(f64),
    Segment(Segment),
}

pub struct WorkerResult {
    pub language: String,
    pub segments: Vec<Segment>,
}

/// Whisper：子进程跑同一可执行文件的 `--asr-worker`，崩溃不拖垮主进程。
pub async fn run_whisper_worker(
    audio: &Path,
    model: &Path,
    language: &str,
    cancel: Arc<AtomicBool>,
    mut on: impl FnMut(WorkerEvent),
) -> Result<WorkerResult> {
    let me = std::env::current_exe()?;
    let mut cmd = tokio::process::Command::new(me);
    cmd.arg("--asr-worker")
        .arg(audio)
        .arg(model)
        .arg(language)
        .arg("")
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn()?;
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let stderr = child.stderr.take().unwrap();
    let errtail = tokio::spawn(async move {
        let mut tail = Vec::new();
        let mut l = BufReader::new(stderr).lines();
        while let Ok(Some(x)) = l.next_line().await {
            tail.push(x);
            if tail.len() > 8 {
                tail.remove(0);
            }
        }
        tail.join("\n")
    });
    let mut segments = Vec::new();
    let mut language_out = language.to_string();
    let mut error: Option<String> = None;
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill().await;
            return Err(anyhow!("已取消"));
        }
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                match v["type"].as_str() {
                    Some("progress") => on(WorkerEvent::Progress(v["p"].as_f64().unwrap_or(0.0))),
                    Some("segment") => {
                        let s = Segment {
                            start: v["start"].as_f64().unwrap_or(0.0),
                            end: v["end"].as_f64().unwrap_or(0.0),
                            text: v["text"].as_str().unwrap_or("").trim().to_string(),
                        };
                        if !s.text.is_empty() {
                            on(WorkerEvent::Segment(s.clone()));
                            segments.push(s);
                        }
                    }
                    Some("language") => language_out = v["language"].as_str().unwrap_or(language).to_string(),
                    Some("error") => error = v["message"].as_str().map(String::from),
                    _ => {}
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(300)) => {}
        }
    }
    let status = child.wait().await?;
    let tail = errtail.await.unwrap_or_default();
    if let Some(e) = error {
        return Err(anyhow!(e));
    }
    if !status.success() {
        return Err(anyhow!(
            "转写进程异常退出：{}",
            tail.lines().last().unwrap_or("")
        ));
    }
    Ok(WorkerResult {
        language: language_out,
        segments,
    })
}

fn emit(v: serde_json::Value) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

pub fn worker_main(args: &[String]) -> i32 {
    let run = || -> Result<()> {
        let [audio, model, language, _prompt] = args else {
            return Err(anyhow!("参数错误"));
        };
        let samples = decode_16k_mono(Path::new(audio))?;
        emit(serde_json::json!({"type": "progress", "p": 0.02}));
        use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};
        let ctx = WhisperContext::new_with_params(model, WhisperContextParameters::default())
            .map_err(|e| anyhow!("加载模型失败：{e}"))?;
        let mut state = ctx.create_state().map_err(|e| anyhow!("{e}"))?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(8) as i32;
        params.set_n_threads(threads);
        params.set_language(if language.as_str() == "auto" {
            None
        } else {
            Some(language.as_str())
        });
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);
        params.set_no_context(true);
        params.set_progress_callback_safe(|p: i32| {
            emit(serde_json::json!({"type": "progress", "p": (p as f64 / 100.0).max(0.02)}))
        });
        params.set_segment_callback_safe_lossy(|s: whisper_rs::SegmentCallbackData| {
            emit(serde_json::json!({
                "type": "segment",
                "start": s.start_timestamp as f64 / 100.0,
                "end": s.end_timestamp as f64 / 100.0,
                "text": s.text
            }));
        });
        state
            .full(params, &samples)
            .map_err(|e| anyhow!("转写失败：{e}"))?;
        if let Ok(id) = state.full_lang_id_from_state() {
            if let Some(l) = whisper_rs::get_lang_str(id) {
                emit(serde_json::json!({"type": "language", "language": l}));
            }
        }
        emit(serde_json::json!({"type": "progress", "p": 1.0}));
        Ok(())
    };
    match run() {
        Ok(()) => 0,
        Err(e) => {
            emit(serde_json::json!({"type": "error", "message": e.to_string()}));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_qwen_and_whisper() {
        assert!(spec("qwen3-asr").is_some_and(|m| m.engine == "qwen3"));
        assert!(spec("base").is_some_and(|m| m.engine == "whisper"));
    }

    #[test]
    fn audio_ext_from_url() {
        assert_eq!(audio_ext("https://a.com/x/ep.MP3?t=1"), "mp3");
        assert_eq!(audio_ext("https://a.com/x/ep.m4a"), "m4a");
        assert_eq!(audio_ext("https://a.com/x/redirect"), "mp3");
    }

    #[test]
    fn adopts_sibling_qwen_via_symlink() {
        let root = std::env::temp_dir().join(format!(
            "subpodcast-asr-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let data = root.join("Subpodcast");
        let sibling = root.join("ai.qiaomu.subcast").join("models");
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::create_dir_all(models_dir(&data)).unwrap();
        let src = sibling.join("qwen3-asr-0.6b-q8_0.gguf");
        let mut bytes = b"GGUF".to_vec();
        bytes.resize(64, 0);
        std::fs::write(&src, &bytes).unwrap();
        assert_eq!(engine_of("qwen3-asr-0.6b-q8_0.gguf"), Some("qwen3"));
        #[cfg(unix)]
        {
            let dest = models_dir(&data).join("qwen3-asr-0.6b-q8_0.gguf");
            std::os::unix::fs::symlink(&src, &dest).unwrap();
            assert!(dest.is_symlink());
            assert_eq!(linked_from(&dest).as_deref(), Some("SubCast"));
            std::fs::remove_file(&dest).unwrap();
            assert!(src.is_file(), "删软链不碰原件");
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}
