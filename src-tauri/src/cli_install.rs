/**
 * [INPUT]: 当前可执行文件目录（同级 subpodcast-cli）、系统 PATH、目标安装目录
 * [OUTPUT]: CliStatus / inspect / install / ensure_updated — 桌面端一键安装与升级 subpodcast CLI 软链
 * [POS]: 供 SettingsDialog 与启动自检调用，让终端和外部 Agent（Claude/Codex/Cursor）直接运行 `subpodcast mcp`
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub bundled: bool,
    pub bundled_path: Option<String>,
    pub installed: bool,
    pub link_path: Option<String>,
    pub target_path: Option<String>,
    pub needs_update: bool,
    pub in_path: bool,
    /// 可直接写入 MCP 配置的命令路径（PATH 可达时为 "subpodcast"，否则给完整路径）。
    pub command: String,
}

fn bundled_binary_name() -> &'static str {
    if cfg!(windows) {
        "subpodcast-cli.exe"
    } else {
        "subpodcast-cli"
    }
}

pub fn bundled_cli_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let cand = dir.join(bundled_binary_name());
    cand.is_file().then_some(cand)
}

fn install_candidates() -> Vec<PathBuf> {
    let mut list = Vec::new();
    #[cfg(unix)]
    {
        list.push(PathBuf::from("/usr/local/bin/subpodcast"));
        if let Some(home) = dirs::home_dir() {
            list.push(home.join(".local").join("bin").join("subpodcast"));
        }
    }
    #[cfg(windows)]
    {
        if let Some(local) = dirs::data_local_dir() {
            list.push(local.join("Subpodcast").join("bin").join("subpodcast.exe"));
        }
    }
    list
}

fn dir_in_path(dir: &Path) -> bool {
    let canon = std::fs::canonicalize(dir).ok();
    std::env::var_os("PATH").is_some_and(|raw| {
        std::env::split_paths(&raw).any(|p| {
            p == dir || (canon.is_some() && std::fs::canonicalize(&p).ok() == canon)
        })
    })
}

fn same_target(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => a == b,
    }
}

pub fn inspect() -> CliStatus {
    let bundled = bundled_cli_path();
    let mut installed = false;
    let mut link_path: Option<PathBuf> = None;
    let mut target_path: Option<PathBuf> = None;
    let mut needs_update = false;
    let mut in_path = false;

    for cand in install_candidates() {
        let Ok(meta) = std::fs::symlink_metadata(&cand) else {
            continue;
        };
        if !meta.file_type().is_symlink() && !meta.is_file() {
            continue;
        }
        installed = true;
        let resolved = std::fs::canonicalize(&cand).ok();
        if let Some(ref b) = bundled {
            needs_update = resolved.as_ref().is_none_or(|r| !same_target(b, r));
        }
        in_path = cand.parent().is_some_and(dir_in_path);
        link_path = Some(cand);
        target_path = resolved;
        break;
    }

    let command = if installed && in_path {
        "subpodcast".to_string()
    } else if let Some(ref lp) = link_path {
        lp.to_string_lossy().into_owned()
    } else if let Some(ref bp) = bundled {
        bp.to_string_lossy().into_owned()
    } else {
        "subpodcast".to_string()
    };

    CliStatus {
        bundled: bundled.is_some(),
        bundled_path: bundled.map(|p| p.to_string_lossy().into_owned()),
        installed,
        link_path: link_path.map(|p| p.to_string_lossy().into_owned()),
        target_path: target_path.map(|p| p.to_string_lossy().into_owned()),
        needs_update,
        in_path,
        command,
    }
}

#[cfg(unix)]
fn link_at(src: &Path, dst: &Path) -> Result<()> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if let Ok(meta) = std::fs::symlink_metadata(dst) {
        if meta.file_type().is_symlink() {
            std::fs::remove_file(dst)?;
        } else {
            return Err(anyhow!(
                "{} 已存在且不是软链接，为避免误覆盖已跳过",
                dst.display()
            ));
        }
    }
    std::os::unix::fs::symlink(src, dst)
        .with_context(|| format!("无法在 {} 创建软链接", dst.display()))?;
    Ok(())
}

#[cfg(windows)]
fn link_at(src: &Path, dst: &Path) -> Result<()> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, dst).with_context(|| format!("无法复制到 {}", dst.display()))?;
    Ok(())
}

/// 将随应用附带的 `subpodcast-cli` 安装为 `subpodcast` 命令。
pub fn install() -> Result<CliStatus> {
    let src = bundled_cli_path().ok_or_else(|| {
        anyhow!("当前构建未找到 subpodcast-cli（开发态可先运行 cargo build --bin subpodcast-cli）")
    })?;
    let mut last_err: Option<anyhow::Error> = None;
    for dst in install_candidates() {
        match link_at(&src, &dst) {
            Ok(()) => return Ok(inspect()),
            Err(err) => last_err = Some(err),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("无法安装 subpodcast 命令")))
}

/// 启动时静默同步：若检测到已安装旧链过期，或未安装且具备写入权限，自动链接到当前版本。
pub fn ensure_synced() {
    let st = inspect();
    if !st.bundled {
        return;
    }
    if !st.installed || st.needs_update {
        let _ = install();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_replaces_stale_symlink_but_protects_regular_file() {
        let dir = std::env::temp_dir().join(format!("subpodcast-cli-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let src1 = dir.join("bin1");
        let src2 = dir.join("bin2");
        let dst = dir.join("subpodcast");
        std::fs::write(&src1, b"1").unwrap();
        std::fs::write(&src2, b"2").unwrap();

        link_at(&src1, &dst).unwrap();
        assert!(same_target(&src1, &dst));
        link_at(&src2, &dst).unwrap();
        assert!(same_target(&src2, &dst));

        let regular = dir.join("regular");
        std::fs::write(&regular, b"keep").unwrap();
        #[cfg(unix)]
        assert!(link_at(&src2, &regular).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
