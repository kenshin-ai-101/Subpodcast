/**
 * [INPUT]: 依赖 dirs、net、asr::download_file；应用 data 目录
 * [OUTPUT]: find_tool（data/bin → PATH → homebrew）；定位/镜像安装 yt-dlp；ytdlp_command
 * [POS]: import、本机 ASR 抽音轨、videoclip 高光切片共用的外部工具链入口
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use tokio::sync::Mutex as AsyncMutex;

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Dock 启动的 App 看不到终端 PATH；补上常见安装目录，供 yt-dlp 找 deno/node/bun。
fn child_path() -> std::ffi::OsString {
    let home = dirs::home_dir().unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for rel in [
        ".local/bin",
        ".bun/bin",
        ".npm-global/bin",
        ".cargo/bin",
        ".volta/bin",
        "bin",
    ] {
        dirs.push(home.join(rel));
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        dirs.push(d.into());
    }
    for base in [home.join(".nvm/versions/node"), home.join(".volta/tools/image/node")] {
        if let Ok(rd) = std::fs::read_dir(&base) {
            let mut vers: Vec<PathBuf> = rd.flatten().map(|e| e.path().join("bin")).collect();
            vers.sort();
            dirs.extend(vers.into_iter().rev());
        }
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|p| seen.insert(p.clone()));
    std::env::join_paths(dirs).unwrap_or_default()
}

/// 命令行工具：先 data/bin 自带副本，再 PATH 与常见包管理器目录（Dock 启动看不到终端 PATH）。
pub fn find_tool(data: &Path, name: &str) -> Option<PathBuf> {
    let own = data.join("bin").join(exe(name));
    if own.is_file() {
        return Some(own);
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/opt/local/bin"] {
        dirs.push(d.into());
    }
    if let Some(h) = dirs::home_dir() {
        dirs.push(h.join(".local/bin"));
    }
    dirs.into_iter()
        .map(|d| d.join(exe(name)))
        .find(|p| p.is_file())
}

pub fn find_ytdlp(data: &Path) -> Option<PathBuf> {
    find_tool(data, "yt-dlp")
}

/// 国内可达镜像（与 SubCast 同源）；GitHub 作兜底。
const YTDLP_MIRROR: &str = "https://subcast.qiaomu.ai/tools/yt-dlp";
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

static INSTALLING: Lazy<AsyncMutex<()>> = Lazy::new(|| AsyncMutex::new(()));
static JS_RUNTIME: Lazy<Mutex<HashMap<PathBuf, bool>>> = Lazy::new(Default::default);

fn knows_js_runtimes(ytdlp: &Path) -> bool {
    if let Some(v) = JS_RUNTIME.lock().unwrap().get(ytdlp) {
        return *v;
    }
    let mut c = std::process::Command::new(ytdlp);
    c.arg("--help").env("PATH", child_path());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    let ok = c
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("--js-runtimes"))
        .unwrap_or(false);
    JS_RUNTIME.lock().unwrap().insert(ytdlp.to_path_buf(), ok);
    ok
}

/// 异步路径上先暖一下，避免真正下载时再冷启 `--help`。
pub async fn warm_ytdlp(ytdlp: &Path) {
    let p = ytdlp.to_path_buf();
    let _ = tokio::task::spawn_blocking(move || knows_js_runtimes(&p)).await;
}

/// 带代理、socket 超时、JS runtime 的 yt-dlp 命令。
pub fn ytdlp_command(ytdlp: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(ytdlp);
    cmd.env("PATH", child_path());
    if knows_js_runtimes(ytdlp) {
        cmd.args([
            "--js-runtimes",
            "deno",
            "--js-runtimes",
            "node",
            "--js-runtimes",
            "bun",
        ]);
    }
    let proxy = crate::net::effective_proxy();
    if !proxy.is_empty() {
        cmd.args(["--proxy", &proxy]);
    }
    cmd.args(["--socket-timeout", "15"]);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }
    cmd.kill_on_drop(true);
    cmd
}

async fn fetch_checked(
    base: &str,
    name: &str,
    dest: &Path,
    cancel: &AtomicBool,
) -> Result<()> {
    let sums = crate::net::get_text(&format!("{base}/SHA2-256SUMS")).await?;
    let want = sums
        .lines()
        .find_map(|l| {
            let mut it = l.split_whitespace();
            let (hash, file) = (it.next()?, it.next()?);
            (file.trim_start_matches('*') == name).then(|| hash.to_lowercase())
        })
        .ok_or_else(|| anyhow!("校验清单里没有 {name}"))?;
    let tmp = dest.with_extension("download");
    crate::asr::download_file(&format!("{base}/{name}"), &tmp, cancel, |_, _| {}).await?;
    let got = hex::encode(Sha256::digest(tokio::fs::read(&tmp).await?));
    if got != want {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(anyhow!("yt-dlp 校验失败（{base}）"));
    }
    tokio::fs::rename(&tmp, dest).await?;
    Ok(())
}

pub async fn install_ytdlp(data: &Path, cancel: &AtomicBool) -> Result<PathBuf> {
    let name = ytdlp_asset();
    let dest = data.join("bin").join(exe("yt-dlp"));
    std::fs::create_dir_all(dest.parent().unwrap())?;
    let mut failure = None;
    for base in [YTDLP_MIRROR, YTDLP_GITHUB] {
        match fetch_checked(base, name, &dest, cancel).await {
            Ok(()) => {
                failure = None;
                break;
            }
            Err(e) if e.to_string().contains("已取消") => return Err(e),
            Err(e) => failure = Some(e),
        }
    }
    if let Some(e) = failure {
        return Err(e);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(dest)
}

/// 优先本机副本；没有则镜像 → GitHub 装到 data/bin。
pub async fn ensure_ytdlp(data: &Path) -> Result<PathBuf> {
    if let Some(p) = find_ytdlp(data) {
        return Ok(p);
    }
    let _one = INSTALLING.lock().await;
    if let Some(p) = find_ytdlp(data) {
        return Ok(p);
    }
    install_ytdlp(data, &AtomicBool::new(false)).await
}

/// YouTube 机器人校验时换 client 再试一次。
pub async fn with_bot_fallback<T, F, Fut>(job: F) -> Result<T>
where
    F: Fn(Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    match job(vec![]).await {
        Err(e) if bot_check(&e.to_string()) => {
            let alt = vec![
                "--extractor-args".into(),
                "youtube:player_client=tv,web_safari,mweb".into(),
            ];
            job(alt)
                .await
                .map_err(|e2| {
                    if bot_check(&e2.to_string()) {
                        anyhow!("YouTube 要求验证「不是机器人」。请在设置里用已登录的浏览器导入 Cookie 后再试")
                    } else {
                        e2
                    }
                })
        }
        other => other,
    }
}

fn bot_check(msg: &str) -> bool {
    let m = msg.to_lowercase();
    (m.contains("confirm you") && m.contains("bot")) || m.contains("sign in to confirm")
}
