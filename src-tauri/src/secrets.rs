/**
 * [INPUT]: keyring（正式签名包）；debug / ad-hoc 时改为本机文件
 * [OUTPUT]: API Key 的存取与探测（进程内缓存，避免反复弹钥匙串）
 * [POS]: 密钥不进 SQLite；开发态不碰 Keychain ACL（CDHash 一变就失效）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

const SERVICE: &str = "app.subpodcast.desktop";

/// provider → 已探过的结果（None = 确认没有 Key）
static CACHE: Lazy<Mutex<HashMap<String, Option<String>>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static FILE_SEEDED: AtomicBool = AtomicBool::new(false);

fn store_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Subpodcast")
}

fn file_path() -> PathBuf {
    store_dir().join("secrets.json")
}

/// 开发构建，或 macOS ad-hoc / 未签：钥匙串 ACL 绑 CDHash，重编必弹窗。
fn use_file_store() -> bool {
    static FLAG: Lazy<bool> = Lazy::new(|| {
        if cfg!(debug_assertions) {
            return true;
        }
        #[cfg(target_os = "macos")]
        {
            return !macos_identity_signed();
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    });
    *FLAG
}

#[cfg(target_os = "macos")]
fn macos_identity_signed() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let Ok(out) = std::process::Command::new("/usr/bin/codesign")
        .args(["-dv", "--verbose=2"])
        .arg(&exe)
        .output()
    else {
        return false;
    };
    if !out.status.success() {
        return false;
    }
    // codesign 诊断写在 stderr
    let text = String::from_utf8_lossy(&out.stderr);
    if text.contains("Signature=adhoc") || text.contains("(adhoc)") {
        return false;
    }
    text.contains("Authority=")
}

fn seed_file_cache(cache: &mut HashMap<String, Option<String>>) {
    if !use_file_store() || FILE_SEEDED.swap(true, Ordering::SeqCst) {
        return;
    }
    let path = file_path();
    let Ok(raw) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(map) = serde_json::from_str::<HashMap<String, String>>(&raw) else {
        return;
    };
    for (k, v) in map {
        if !v.is_empty() {
            cache.insert(k, Some(v));
        }
    }
}

fn persist_file(cache: &HashMap<String, Option<String>>) -> Result<()> {
    let dir = store_dir();
    fs::create_dir_all(&dir).context("创建密钥目录失败")?;
    let map: HashMap<&str, &str> = cache
        .iter()
        .filter_map(|(k, v)| v.as_ref().map(|val| (k.as_str(), val.as_str())))
        .collect();
    let path = file_path();
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(&map)?;
    {
        use std::io::Write;
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(&tmp, &path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn keyring_get(provider: &str) -> Option<String> {
    let entry = keyring::Entry::new(SERVICE, provider).ok()?;
    match entry.get_password() {
        Ok(p) if !p.is_empty() => Some(p),
        _ => None,
    }
}

fn keyring_set(provider: &str, key: &str) -> Result<()> {
    let entry = keyring::Entry::new(SERVICE, provider)?;
    if key.is_empty() {
        let _ = entry.delete_credential();
    } else {
        entry.set_password(key)?;
    }
    Ok(())
}

pub fn set_key(provider: &str, key: &str) -> Result<()> {
    let trimmed = key.trim();
    let mut cache = CACHE.lock().map_err(|_| anyhow::anyhow!("密钥缓存锁损坏"))?;
    seed_file_cache(&mut cache);

    if use_file_store() {
        if trimmed.is_empty() {
            cache.insert(provider.to_string(), None);
        } else {
            cache.insert(provider.to_string(), Some(trimmed.to_string()));
        }
        persist_file(&cache)?;
        return Ok(());
    }

    keyring_set(provider, trimmed)?;
    if trimmed.is_empty() {
        cache.insert(provider.to_string(), None);
    } else {
        cache.insert(provider.to_string(), Some(trimmed.to_string()));
    }
    Ok(())
}

pub fn get_key(provider: &str) -> Result<Option<String>> {
    let mut cache = CACHE.lock().map_err(|_| anyhow::anyhow!("密钥缓存锁损坏"))?;
    seed_file_cache(&mut cache);

    if let Some(hit) = cache.get(provider) {
        return Ok(hit.clone());
    }

    if use_file_store() {
        // 文件已全部灌进缓存；未命中即无 Key，勿再碰钥匙串
        cache.insert(provider.to_string(), None);
        return Ok(None);
    }

    let found = keyring_get(provider);
    cache.insert(provider.to_string(), found.clone());
    Ok(found)
}

pub fn has_key(provider: &str) -> bool {
    matches!(get_key(provider), Ok(Some(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_avoids_repeat_lookup_shape() {
        let mut m: HashMap<String, Option<String>> = HashMap::new();
        m.insert("deepseek".into(), Some("sk-test".into()));
        m.insert("empty".into(), None);
        assert_eq!(m.get("deepseek").cloned().flatten().as_deref(), Some("sk-test"));
        assert!(m.get("empty").is_some_and(|v| v.is_none()));
    }

    #[test]
    fn debug_builds_prefer_file_store() {
        assert_eq!(use_file_store(), cfg!(debug_assertions) || {
            #[cfg(target_os = "macos")]
            {
                !macos_identity_signed()
            }
            #[cfg(not(target_os = "macos"))]
            {
                false
            }
        });
    }
}
