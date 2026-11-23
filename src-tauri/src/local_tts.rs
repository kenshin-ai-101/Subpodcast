//! [INPUT]: 固定版本的 sherpa-onnx、模型清单、net 与任务取消标记
//! [OUTPUT]: 安装状态、下载进度、离线 WAV
//! [POS]: Melo / Kokoro 模型管理与推理
//! [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

use anyhow::{anyhow, bail, Result};
use futures_util::{stream, StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use sha2::Sha256;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

const VERSION: &str = "v1.13.8";
const MODELS: [&str; 2] = ["melo", "kokoro"];
static INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static MODEL_FILES: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());

#[derive(Deserialize)]
struct Manifest {
    repo: String,
    revision: String,
    files: Vec<ModelFile>,
}

#[derive(Deserialize)]
struct ModelFile {
    path: String,
    size: u64,
    sha1: Option<String>,
    sha256: Option<String>,
}

static MANIFESTS: once_cell::sync::Lazy<HashMap<String, Manifest>> =
    once_cell::sync::Lazy::new(|| {
        serde_json::from_str(include_str!("local_tts_models.json")).expect("内置语音模型清单无效")
    });

fn manifest(id: &str) -> Result<&'static Manifest> {
    MANIFESTS
        .get(id)
        .ok_or_else(|| anyhow!("未知的本地语音模型"))
}

fn runtime_asset() -> Option<(&'static str, &'static str)> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some((
            "osx-arm64-shared",
            "b10e5c7e2c30ea03de9c442655d14860d9edc475c6251d58a8f5f06e913a1d56",
        )),
        ("macos", "x86_64") => Some((
            "osx-x64-shared",
            "54aad64acee9d2d596535a6080d6f22602a720af5460e1d50461b1e1b06bee40",
        )),
        ("linux", "aarch64") => Some((
            "linux-aarch64-shared-cpu",
            "4e3734f82bc1379fd91f219f5869c7e9d03b7a4f7561907d8abca4849c51a789",
        )),
        ("linux", "x86_64") => Some((
            "linux-x64-shared-cpu",
            "c0bdb7907d3a74bba1d55d22bf4d9fa75586cf1530614ebe88a27b9118e015c4",
        )),
        _ => None,
    }
}

pub fn models_dir(data: &Path) -> PathBuf {
    data.join("tts-models")
}

fn runtime_dir(data: &Path) -> PathBuf {
    models_dir(data).join(format!("sherpa-onnx-{VERSION}"))
}

fn executable(runtime: &Path) -> PathBuf {
    runtime.join("bin/sherpa-onnx-offline-tts")
}

fn installed(dir: &Path, spec: &Manifest) -> bool {
    std::fs::read_to_string(dir.join(".complete")).is_ok_and(|revision| revision == spec.revision)
        && spec
            .files
            .iter()
            .all(|f| file_size_matches(&dir.join(&f.path), f.size))
}

fn file_size_matches(path: &Path, bytes: u64) -> bool {
    path.metadata()
        .is_ok_and(|f| f.is_file() && f.len() == bytes)
}

#[derive(Serialize)]
struct ModelState {
    id: &'static str,
    installed: bool,
    bytes: u64,
}

#[derive(Serialize)]
pub struct Status {
    supported: bool,
    runtime: bool,
    models: Vec<ModelState>,
}

pub fn status(data: &Path) -> Status {
    let runtime = executable(&runtime_dir(data)).is_file();
    Status {
        supported: runtime_asset().is_some(),
        runtime,
        models: MODELS
            .into_iter()
            .map(|id| {
                let spec = &MANIFESTS[id];
                ModelState {
                    id,
                    installed: runtime && installed(&models_dir(data).join(id), spec),
                    bytes: spec.files.iter().map(|f| f.size).sum(),
                }
            })
            .collect(),
    }
}

pub fn delete(data: &Path, id: &str) -> Result<()> {
    manifest(id)?;
    let _install = INSTALL
        .try_lock()
        .map_err(|_| anyhow!("请先结束模型下载"))?;
    let _files = MODEL_FILES
        .try_write()
        .map_err(|_| anyhow!("请先停止本地朗读"))?;
    let dir = models_dir(data).join(id);
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    Ok(())
}

fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        bail!("已取消");
    }
    Ok(())
}

async fn download(
    url: &str,
    dest: &Path,
    cancel: &AtomicBool,
    progress: impl FnMut(u64, Option<u64>),
) -> Result<()> {
    check_cancel(cancel)?;
    let cancelled = async {
        while !cancel.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        anyhow!("已取消")
    };
    tokio::select! {
        result = crate::asr::download_file(url, dest, cancel, progress) => result,
        error = cancelled => Err(error),
    }
}

async fn install_runtime(
    data: &Path,
    asset: &str,
    expected_hash: &str,
    cancel: &AtomicBool,
    progress: &(impl Fn(u64, Option<u64>) + Sync),
) -> Result<()> {
    let dest = runtime_dir(data);
    if executable(&dest).is_file() {
        return Ok(());
    }
    std::fs::create_dir_all(models_dir(data))?;
    let temp = tempfile::tempdir_in(models_dir(data))?;
    let name = format!("sherpa-onnx-{VERSION}-{asset}");
    let archive = temp.path().join("runtime.tar.bz2");
    let url =
        format!("https://github.com/k2-fsa/sherpa-onnx/releases/download/{VERSION}/{name}.tar.bz2");
    let downloaded = download(&url, &archive, cancel, progress).await;
    check_cancel(cancel)?;
    downloaded.map_err(|_| anyhow!("下载本地语音程序失败，请检查网络"))?;
    let want = expected_hash.to_owned();
    let extracted = tokio::task::spawn_blocking(move || -> Result<_> {
        let mut hash = Sha256::new();
        std::io::copy(&mut std::fs::File::open(&archive)?, &mut hash)?;
        if hex::encode(hash.finalize()) != want {
            bail!("本地语音程序校验失败");
        }
        let reader = bzip2::read::BzDecoder::new(std::fs::File::open(archive)?);
        tar::Archive::new(reader).unpack(temp.path())?;
        let unpacked = temp.path().join(name);
        if !executable(&unpacked).is_file() {
            bail!("本地语音程序解包不完整");
        }
        Ok((temp, unpacked))
    })
    .await??;
    check_cancel(cancel)?;
    if dest.exists() {
        std::fs::remove_dir_all(&dest)?;
    }
    std::fs::rename(&extracted.1, dest)?;
    Ok(())
}

async fn verify(path: PathBuf, spec: &'static ModelFile) -> Result<bool> {
    tokio::task::spawn_blocking(move || -> Result<bool> {
        if !file_size_matches(&path, spec.size) {
            return Ok(false);
        }
        let mut file = std::fs::File::open(path)?;
        if let Some(want) = &spec.sha256 {
            let mut hash = Sha256::new();
            std::io::copy(&mut file, &mut hash)?;
            return Ok(hex::encode(hash.finalize()) == *want);
        }
        if let Some(want) = &spec.sha1 {
            // 小文件的清单使用 Git blob ID，哈希包含对象头。
            use std::io::Write;
            let mut hash = Sha1::new();
            write!(hash, "blob {}\0", spec.size)?;
            std::io::copy(&mut file, &mut hash)?;
            return Ok(hex::encode(hash.finalize()) == *want);
        }
        Ok(false)
    })
    .await?
}

pub async fn install(
    data: &Path,
    id: &str,
    cancel: &AtomicBool,
    mirror_first: bool,
    progress: impl Fn(u64, Option<u64>) + Sync,
) -> Result<()> {
    let _install = INSTALL
        .try_lock()
        .map_err(|_| anyhow!("已有本地语音模型正在下载"))?;
    let spec = manifest(id)?;
    let (asset, hash) = runtime_asset().ok_or_else(|| anyhow!("此平台暂不支持本地语音模型"))?;
    let dir = models_dir(data).join(id);
    let runtime = runtime_dir(data);
    if executable(&runtime).is_file() && installed(&dir, spec) {
        return Ok(());
    }
    install_runtime(data, asset, hash, cancel, &progress).await?;
    tokio::fs::create_dir_all(&dir).await?;
    let marker = dir.join(".complete");
    if marker.exists() {
        tokio::fs::remove_file(&marker).await?;
    }
    let mut hosts = ["huggingface.co", "hf-mirror.com"];
    if mirror_first {
        hosts.swap(0, 1);
    }

    let workspace = tempfile::tempdir_in(models_dir(data))?;
    let total = spec.files.iter().map(|f| f.size).sum::<u64>();
    let received = AtomicU64::new(0);
    let progress = &progress;
    let received = &received;
    progress(0, Some(total));
    let mut files = Vec::new();
    for file in &spec.files {
        let path = dir.join(&file.path);
        let stage = workspace.path().join(format!("{}.download", file.path));
        files.push(async move {
            check_cancel(cancel)?;
            if !verify(path.clone(), file).await? {
                let partial = stage.with_extension("part");
                let mut valid = false;
                for host in hosts {
                    let url = format!(
                        "https://{host}/{}/resolve/{}/{}",
                        spec.repo, spec.revision, file.path
                    );
                    let mut reported = 0;
                    let result = download(&url, &stage, cancel, |bytes, _| {
                        let next = bytes.min(file.size);
                        let n = received.fetch_add(next - reported, Ordering::Relaxed) + next
                            - reported;
                        reported = next;
                        progress(n, Some(total));
                    })
                    .await;
                    received.fetch_sub(reported, Ordering::Relaxed);
                    let _ = tokio::fs::remove_file(&partial).await;
                    if result.is_ok() && verify(stage.clone(), file).await? {
                        check_cancel(cancel)?;
                        if let Some(parent) = path.parent() {
                            tokio::fs::create_dir_all(parent).await?;
                        }
                        tokio::fs::rename(&stage, &path).await?;
                        valid = true;
                        break;
                    }
                    let _ = tokio::fs::remove_file(&stage).await;
                    check_cancel(cancel)?;
                }
                if !valid {
                    bail!("下载或校验本地语音文件失败（{}）", file.path);
                }
            }
            let n = received.fetch_add(file.size, Ordering::Relaxed) + file.size;
            progress(n, Some(total));
            Ok(())
        });
    }
    stream::iter(files)
        .buffer_unordered(6)
        .try_for_each(|()| async { Ok(()) })
        .await?;
    check_cancel(cancel)?;
    tokio::fs::write(marker, &spec.revision).await?;
    Ok(())
}

pub async fn synthesize(
    data: &Path,
    model: &str,
    voice: &str,
    text: &str,
    rate: f64,
) -> Result<Vec<u8>> {
    let _files = MODEL_FILES.read().await;
    let model = if model.is_empty() { "melo" } else { model };
    let spec = manifest(model)?;
    let dir = models_dir(data).join(model);
    let runtime = executable(&runtime_dir(data));
    if !runtime.is_file() || !installed(&dir, spec) {
        bail!("请先在「设置 › 朗读」下载本地语音模型");
    }

    let work = tempfile::tempdir()?;
    let output = work.path().join("speech.wav");
    let mut command = tokio::process::Command::new(runtime);
    let path = |name: &str| dir.join(name).display().to_string();
    if model == "melo" {
        command.args([
            format!("--vits-model={}", path("model.onnx")),
            format!("--vits-tokens={}", path("tokens.txt")),
            format!("--vits-lexicon={}", path("lexicon.txt")),
            format!("--vits-dict-dir={}", path("dict")),
            format!(
                "--tts-rule-fsts={},{}",
                path("date.fst"),
                path("number.fst")
            ),
        ]);
    } else {
        let sid = [
            "zf_001", "zf_002", "zf_003", "zf_004", "zm_009", "zm_010", "zm_011", "zm_012",
        ]
        .iter()
        .position(|id| *id == voice)
        .map(|i| [3, 4, 5, 6, 58, 59, 60, 61][i])
        .unwrap_or(3);
        command.args([
            format!("--kokoro-model={}", path("model.onnx")),
            format!("--kokoro-voices={}", path("voices.bin")),
            format!("--kokoro-tokens={}", path("tokens.txt")),
            format!("--kokoro-data-dir={}", path("espeak-ng-data")),
            format!("--kokoro-dict-dir={}", path("dict")),
            format!(
                "--kokoro-lexicon={},{}",
                path("lexicon-us-en.txt"),
                path("lexicon-zh.txt")
            ),
            format!(
                "--tts-rule-fsts={},{}",
                path("date-zh.fst"),
                path("number-zh.fst")
            ),
            format!("--sid={sid}"),
        ]);
    }
    let result = command
        .args(["--num-threads=2", &format!("--speed={rate:.2}")])
        .arg(format!("--output-filename={}", output.display()))
        .arg(format!(" {}", text.replace(['\r', '\n'], " ")))
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|_| anyhow!("无法启动本地语音程序"))?;
    if !result.status.success() {
        bail!("本地语音合成失败");
    }
    Ok(tokio::fs::read(output).await?)
}
