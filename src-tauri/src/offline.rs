/**
 * [INPUT]: asr.fetch_episode_audio（enclosure 优先，否则 YouTube 原生 m4a）；Episode
 * [OUTPUT]: downloads/ 下按 episode_id 存的离线音频；list/find/remove/clear
 * [POS]: 单集页下载；本机 ASR 优先复用 find() 结果
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use crate::asr;
use crate::model::Episode;
use anyhow::{anyhow, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub episode_id: String,
    pub path: String,
    pub bytes: u64,
    pub saved_at: i64,
}

pub fn dir(data: &Path) -> PathBuf {
    data.join("downloads")
}

/// 字幕对齐临时音频缓存目录（上限 2 GB，超出按旧到新清理）。
pub fn cache_dir(data: &Path) -> PathBuf {
    data.join("audio-cache")
}

const CACHE_CAP_BYTES: u64 = 2 * 1024 * 1024 * 1024;

pub fn cache_path(data: &Path, episode_id: &str, url: &str) -> PathBuf {
    let ext = asr::audio_ext(&crate::shared::canonical_audio_url(url));
    cache_dir(data).join(format!("{episode_id}.{ext}"))
}

fn saved_file(p: &Path) -> Option<Saved> {
    let id = p.file_stem()?.to_str()?;
    let ext = p.extension()?.to_str()?;
    if ext == "part" || id.starts_with('.') {
        return None;
    }
    let meta = std::fs::metadata(p).ok().filter(|m| m.is_file())?;
    let saved_at = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(Saved {
        episode_id: id.to_string(),
        path: p.to_string_lossy().into_owned(),
        bytes: meta.len(),
        saved_at,
    })
}

fn list_in(folder: &Path) -> Vec<Saved> {
    let Ok(rd) = std::fs::read_dir(folder) else {
        return vec![];
    };
    let mut out: Vec<Saved> = rd.flatten().filter_map(|e| saved_file(&e.path())).collect();
    out.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    out
}

pub fn list(data: &Path) -> Vec<Saved> {
    list_in(&dir(data))
}

pub fn find(data: &Path, episode_id: &str) -> Option<Saved> {
    list(data).into_iter().find(|s| s.episode_id == episode_id)
}

pub fn list_cached(data: &Path) -> Vec<Saved> {
    list_in(&cache_dir(data))
}

pub fn find_cached(data: &Path, episode_id: &str) -> Option<Saved> {
    let found = list_cached(data)
        .into_iter()
        .find(|s| s.episode_id == episode_id)?;
    // 命中时刷新 mtime，使 audio-cache/ 严格按最近使用（LRU）淘汰
    let _ = std::fs::File::options()
        .write(true)
        .open(&found.path)
        .and_then(|f| f.set_modified(std::time::SystemTime::now()));
    Some(found)
}

/// 将对齐下载完成的 .part 原子移入 audio-cache/，并按 LRU 控制总占用。
pub fn commit_cached(data: &Path, episode_id: &str, part: &Path, ext: &str) -> Result<Saved> {
    let folder = cache_dir(data);
    std::fs::create_dir_all(&folder)?;
    // 清掉同集旧扩展名缓存，避免重名残留
    for old in list_cached(data) {
        if old.episode_id == episode_id {
            let _ = std::fs::remove_file(&old.path);
        }
    }
    let dest = folder.join(format!("{episode_id}.{ext}"));
    std::fs::rename(part, &dest)?;
    let kept = saved_file(&dest).ok_or_else(|| anyhow!("缓存音频写入失败"))?;
    let mut all = list_cached(data);
    let mut total: u64 = all.iter().map(|s| s.bytes).sum();
    while total > CACHE_CAP_BYTES && all.len() > 1 {
        if let Some(oldest) = all.pop() {
            if oldest.episode_id == episode_id {
                continue;
            }
            if std::fs::remove_file(&oldest.path).is_ok() {
                total = total.saturating_sub(oldest.bytes);
            }
        }
    }
    Ok(kept)
}

pub fn clear_cached(data: &Path) -> Result<()> {
    let d = cache_dir(data);
    if d.is_dir() {
        std::fs::remove_dir_all(&d)?;
    }
    Ok(())
}

pub fn remove(data: &Path, episode_id: &str) -> Result<()> {
    if let Some(s) = find(data, episode_id) {
        std::fs::remove_file(s.path)?;
    }
    Ok(())
}

pub fn clear(data: &Path) -> Result<()> {
    let d = dir(data);
    if d.is_dir() {
        std::fs::remove_dir_all(&d)?;
    }
    Ok(())
}

/// 下载单集音频到 downloads/{id}.{ext}；若 audio-cache/ 已有同集缓存则直接转正，避免重复下载并锁定同一份剪辑。
pub async fn download(
    data: &Path,
    ep: &Episode,
    cancel: Arc<AtomicBool>,
    mut progress: impl FnMut(Option<f64>),
) -> Result<Saved> {
    let d = dir(data);
    tokio::fs::create_dir_all(&d).await?;
    // 优先转正 audio-cache/ 已有缓存（仅缓存播客直链文件，与 enclosure 路线一致）
    if ep.audio_url.as_deref().is_some_and(|u| !u.is_empty()) {
        if let Some(cached) = find_cached(data, &ep.id) {
            let src = PathBuf::from(&cached.path);
            let ext = src
                .extension()
                .and_then(|x| x.to_str())
                .unwrap_or("mp3")
                .to_string();
            for old in list(data) {
                if old.episode_id == ep.id {
                    let _ = tokio::fs::remove_file(&old.path).await;
                }
            }
            let dest = d.join(format!("{}.{ext}", ep.id));
            let part = d.join(format!("{}.{ext}.part", ep.id));
            if tokio::fs::copy(&src, &part).await.is_ok()
                && tokio::fs::rename(&part, &dest).await.is_ok()
            {
                let _ = tokio::fs::remove_file(&src).await;
                progress(Some(1.0));
                if let Some(s) = saved_file(&dest) {
                    return Ok(s);
                }
            } else {
                let _ = tokio::fs::remove_file(&part).await;
            }
        }
    }
    let work = d.join(format!(".tmp-{}", ep.id));
    let _ = tokio::fs::remove_dir_all(&work).await;
    tokio::fs::create_dir_all(&work).await?;
    progress(Some(0.0));
    let file = asr::fetch_episode_audio(
        data,
        &work,
        ep.audio_url.as_deref(),
        ep.video_id.as_deref(),
        cancel.clone(),
        |p| progress(Some(p.clamp(0.0, 0.95))),
    )
    .await;
    let result = match file {
        Ok(src) => {
            let ext = src
                .extension()
                .and_then(|x| x.to_str())
                .unwrap_or("m4a")
                .to_string();
            for old in list(data) {
                if old.episode_id == ep.id {
                    let _ = tokio::fs::remove_file(&old.path).await;
                }
            }
            let dest = d.join(format!("{}.{ext}", ep.id));
            tokio::fs::rename(&src, &dest)
                .await
                .map(|_| dest)
                .map_err(anyhow::Error::from)
        }
        Err(err) => Err(err),
    };
    let _ = tokio::fs::remove_dir_all(&work).await;
    let dest = result?;
    progress(Some(1.0));
    saved_file(&dest).ok_or_else(|| anyhow!("下载失败"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_only_finished_files() {
        let data = std::env::temp_dir().join(format!(
            "subpodcast-offline-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir(&data)).unwrap();
        std::fs::write(dir(&data).join("a.mp3"), b"123").unwrap();
        std::fs::write(dir(&data).join("b.part"), b"1").unwrap();
        let l = list(&data);
        assert_eq!(l.len(), 1);
        assert_eq!((l[0].episode_id.as_str(), l[0].bytes), ("a", 3));
        remove(&data, "a").unwrap();
        assert!(find(&data, "a").is_none());
        clear(&data).unwrap();
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn audio_cache_is_isolated_from_downloads() {
        let data = std::env::temp_dir().join(format!(
            "subpodcast-cache-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(cache_dir(&data)).unwrap();
        let part = cache_dir(&data).join("ep1.part");
        std::fs::write(&part, b"abcdef").unwrap();
        let saved = commit_cached(&data, "ep1", &part, "mp3").unwrap();
        assert_eq!(saved.episode_id, "ep1");
        assert_eq!(saved.bytes, 6);
        assert!(find(&data, "ep1").is_none());
        assert!(find_cached(&data, "ep1").is_some());
        clear_cached(&data).unwrap();
        assert!(find_cached(&data, "ep1").is_none());
        let _ = std::fs::remove_dir_all(&data);
    }
}
