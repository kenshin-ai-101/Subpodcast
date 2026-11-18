/**
 * [INPUT]: 依赖 keyring
 * [OUTPUT]: API Key 的存取与探测
 * [POS]: 密钥只进系统钥匙串，不进 SQLite
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use anyhow::Result;
use keyring::Entry;

const SERVICE: &str = "app.subpodcast.desktop";

pub fn set_key(provider: &str, key: &str) -> Result<()> {
    let entry = Entry::new(SERVICE, provider)?;
    if key.trim().is_empty() {
        let _ = entry.delete_credential();
    } else {
        entry.set_password(key.trim())?;
    }
    Ok(())
}

pub fn get_key(provider: &str) -> Result<Option<String>> {
    let entry = Entry::new(SERVICE, provider)?;
    match entry.get_password() {
        Ok(p) if !p.is_empty() => Ok(Some(p)),
        _ => Ok(None),
    }
}

pub fn has_key(provider: &str) -> bool {
    matches!(get_key(provider), Ok(Some(_)))
}
