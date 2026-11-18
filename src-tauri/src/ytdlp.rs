/**
 * [INPUT]: 依赖 dirs、net；应用 data 目录
 * [OUTPUT]: 定位或下载 yt-dlp（导入 YouTube 订阅用）
 * [POS]: import 的工具依赖；本机 ASR 二期可复用
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

pub fn find_ytdlp(data: &Path) -> Option<PathBuf> {
    let own = data.join("bin").join(exe("yt-dlp"));
    if own.is_file() {
        return Some(own);
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        dirs.push(d.into());
    }
    if let Some(h) = dirs::home_dir() {
        dirs.push(h.join(".local/bin"));
    }
    dirs.into_iter().map(|d| d.join(exe("yt-dlp"))).find(|p| p.is_file())
}

const YTDLP_GITHUB: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";

fn ytdlp_asset() -> &'static str {
    if cfg!(target_os = "macos") {
        "yt-dlp_macos"
    } else if cfg!(windows) {
        "yt-dlp.exe"
    } else if cfg!(target_arch = "aarch64") {
        "yt-dlp_linux_aarch64"
    } else {
        "yt-dlp_linux"
    }
}

static INSTALLING: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// 优先本机已有副本；没有则从 GitHub 下载到 data/bin。
pub async fn ensure_ytdlp(data: &Path) -> Result<PathBuf> {
    if let Some(p) = find_ytdlp(data) {
        return Ok(p);
    }
    let _one = INSTALLING.lock().await;
    if let Some(p) = find_ytdlp(data) {
        return Ok(p);
    }
    let dest = data.join("bin").join(exe("yt-dlp"));
    std::fs::create_dir_all(dest.parent().unwrap())?;
    let url = format!("{YTDLP_GITHUB}/{}", ytdlp_asset());
    let bytes = crate::net::get_bytes(&url)
        .await
        .map_err(|e| anyhow!("下载 yt-dlp 失败：{e}"))?;
    let tmp = dest.with_extension("download");
    tokio::fs::write(&tmp, &bytes).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    }
    tokio::fs::rename(&tmp, &dest).await?;
    Ok(dest)
}
