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

pub fn list(data: &Path) -> Vec<Saved> {
    let Ok(rd) = std::fs::read_dir(dir(data)) else {
        return vec![];
    };
    let mut out: Vec<Saved> = rd.flatten().filter_map(|e| saved_file(&e.path())).collect();
    out.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    out
}

pub fn find(data: &Path, episode_id: &str) -> Option<Saved> {
    list(data).into_iter().find(|s| s.episode_id == episode_id)
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

/// 下载单集音频到 downloads/{id}.{ext}。
pub async fn download(
    data: &Path,
    ep: &Episode,
    cancel: Arc<AtomicBool>,
    mut progress: impl FnMut(Option<f64>),
) -> Result<Saved> {
    let d = dir(data);
    tokio::fs::create_dir_all(&d).await?;
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
}
