/**
 * [INPUT]: 聚合 db/feeds/captions/qiaomu/shared/translate/llm/secrets/net/asr/offline
 * [OUTPUT]: Tauri 命令面（含 shared_* / share_guide / tts_speak / translate_texts / fetch_official）与启动
 * [POS]: Rust 侧总控；新命令需同步 build.rs COMMANDS 与 capabilities
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
mod asr;
mod captions;
mod db;
mod feeds;
mod import;
mod llm;
mod model;
mod net;
mod offline;
mod qiaomu;
mod secrets;
mod shared;
mod translate;
mod tts;
mod ui;
mod ytdlp;

use model::{now_ms, short_hash, Episode, Show, Transcript};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

struct AppState {
    db: Mutex<rusqlite::Connection>,
    /// 应用数据目录（yt-dlp、本机 ASR 模型）
    data: PathBuf,
    /// 可取消任务：episodeId / model:{id}
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

type Res<T> = Result<T, String>;
fn e(err: impl ToString) -> String {
    err.to_string()
}

fn install_id(conn: &rusqlite::Connection) -> String {
    if let Ok(Some(id)) = db::get_setting(conn, "install") {
        return id;
    }
    let id = Uuid::new_v4().to_string();
    let _ = db::set_setting(conn, "install", &id);
    id
}

fn share_on(conn: &rusqlite::Connection) -> bool {
    db::get_setting(conn, "app")
        .ok()
        .flatten()
        .and_then(|r| serde_json::from_str::<serde_json::Value>(&r).ok())
        .and_then(|s| s["shareTranscripts"].as_bool())
        .unwrap_or(true)
}

/// 共享库命中则落库字幕，并写入节目方译文（engine=shared）。
async fn take_shared(state: &AppState, ep: &Episode) -> Option<Transcript> {
    let mut hit = shared::lookup(&shared::keys(ep)).await?;
    let translation = hit.translation.take();
    let t = shared::into_transcript(&ep.id, hit);
    {
        let conn = state.db.lock().ok()?;
        db::save_transcript(&conn, &t).ok()?;
        if let Some(tr) =
            translation.filter(|tr| tr.items.len() == t.segments.len() && tr.lang.starts_with("zh"))
        {
            let _ = db::set_blob(
                &conn,
                &ep.id,
                "zh",
                &serde_json::to_string(&tr.items).unwrap_or_default(),
            );
            let _ = db::set_blob(&conn, &ep.id, "zh-engine", "shared");
        }
    }
    Some(t)
}

fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Subpodcast")
}

#[tauri::command]
async fn add_subscription(state: State<'_, AppState>, input: String) -> Res<Show> {
    let resolved = feeds::resolve(&input).await.map_err(e)?;
    let mut conn = state.db.lock().map_err(e)?;
    db::upsert_show(&conn, &resolved.show).map_err(e)?;
    db::sync_episodes(&mut conn, &resolved.show.id, &resolved.episodes).map_err(e)?;
    Ok(resolved.show)
}

#[tauri::command]
async fn refresh_show(state: State<'_, AppState>, show_id: String) -> Res<u32> {
    let show = {
        let conn = state.db.lock().map_err(e)?;
        db::get_show(&conn, &show_id).map_err(e)?.ok_or_else(|| "节目不存在".to_string())?
    };
    let resolved = feeds::refresh(&show.feed_url, &show.kind).await.map_err(e)?;
    let before = {
        let conn = state.db.lock().map_err(e)?;
        db::list_episodes(&conn, Some(&show_id), 5000).map_err(e)?.len()
    };
    let mut conn = state.db.lock().map_err(e)?;
    let mut show = resolved.show;
    show.id = show_id.clone();
    db::upsert_show(&conn, &show).map_err(e)?;
    let mut eps = resolved.episodes;
    feeds::rebind_episodes(&mut eps, &show_id);
    db::sync_episodes(&mut conn, &show_id, &eps).map_err(e)?;
    let after = db::list_episodes(&conn, Some(&show_id), 5000).map_err(e)?.len();
    Ok(after.saturating_sub(before) as u32)
}

#[tauri::command]
async fn refresh_all(state: State<'_, AppState>) -> Res<u32> {
    let shows = {
        let conn = state.db.lock().map_err(e)?;
        db::list_shows(&conn).map_err(e)?
    };
    let mut total = 0u32;
    for s in shows {
        if let Ok(n) = refresh_show(state.clone(), s.id).await {
            total += n;
        }
    }
    Ok(total)
}

#[tauri::command]
fn list_shows(state: State<'_, AppState>) -> Res<Vec<Show>> {
    let conn = state.db.lock().map_err(e)?;
    db::list_shows(&conn).map_err(e)
}

#[tauri::command]
fn list_episodes(state: State<'_, AppState>, show_id: Option<String>, limit: Option<i64>) -> Res<Vec<Episode>> {
    let conn = state.db.lock().map_err(e)?;
    db::list_episodes(&conn, show_id.as_deref(), limit.unwrap_or(100)).map_err(e)
}

#[tauri::command]
fn recent_episodes(state: State<'_, AppState>, limit: Option<i64>) -> Res<Vec<Episode>> {
    let conn = state.db.lock().map_err(e)?;
    db::recent_episodes(&conn, limit.unwrap_or(60)).map_err(e)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Preview {
    show: Show,
    episodes: Vec<Episode>,
    fetched_at: i64,
}

/// 发现页缓存键：精读站 / 直链用稳定 feed id；否则用输入串哈希（与 preview 双写对齐）。
fn cache_keys(input: &str) -> Vec<String> {
    let raw = input.trim();
    if raw.is_empty() {
        return vec![];
    }
    let normalized = if raw.starts_with("http") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let mut keys = vec![short_hash(raw, 16)];
    if let Some(id) = qiaomu::rss_source_id(&normalized) {
        keys.push(short_hash(&qiaomu::rss_feed_url(&id), 16));
    }
    if let Some(id) = qiaomu::site_id(&normalized) {
        keys.push(short_hash(&qiaomu::feed_url(&id), 16));
    }
    keys.sort();
    keys.dedup();
    keys
}

#[tauri::command]
fn cached_show(state: State<'_, AppState>, input: String) -> Res<Option<Preview>> {
    let conn = state.db.lock().map_err(e)?;
    for id in cache_keys(&input) {
        let Some(json) = db::get_blob(&conn, &id, "show-json").map_err(e)? else {
            continue;
        };
        let Ok(show) = serde_json::from_str::<Show>(&json) else {
            continue;
        };
        let fetched_at = db::get_blob(&conn, &id, "fetched-at")
            .map_err(e)?
            .and_then(|t| t.parse().ok())
            .unwrap_or(0);
        let episodes = db::list_episodes(&conn, Some(&show.id), feeds::MAX_EPISODES as i64).map_err(e)?;
        if episodes.is_empty() {
            continue;
        }
        return Ok(Some(Preview {
            show,
            episodes,
            fetched_at,
        }));
    }
    Ok(None)
}

/// 发现页预览：只写单集与 show 缓存，不进订阅侧栏。
#[tauri::command]
async fn preview_show(state: State<'_, AppState>, input: String) -> Res<Preview> {
    let resolved = feeds::resolve(&input).await.map_err(e)?;
    let show = resolved.show;
    let mut conn = state.db.lock().map_err(e)?;
    db::sync_episodes(&mut conn, &show.id, &resolved.episodes).map_err(e)?;
    let now = now_ms();
    let json = serde_json::to_string(&show).map_err(e)?;
    let mut keys = cache_keys(&input);
    keys.push(show.id.clone());
    keys.sort();
    keys.dedup();
    for id in keys {
        db::set_blob(&conn, &id, "show-json", &json).map_err(e)?;
        db::set_blob(&conn, &id, "fetched-at", &now.to_string()).map_err(e)?;
    }
    let episodes = db::list_episodes(&conn, Some(&show.id), feeds::MAX_EPISODES as i64).map_err(e)?;
    Ok(Preview {
        show,
        episodes,
        fetched_at: now,
    })
}

#[tauri::command]
fn log_listen(
    state: State<'_, AppState>,
    episode_id: String,
    show_id: String,
    seconds: f64,
    translated: bool,
) -> Res<()> {
    let conn = state.db.lock().map_err(e)?;
    db::log_listen(&conn, &episode_id, &show_id, seconds, translated).map_err(e)
}

#[tauri::command]
fn listening_stats(state: State<'_, AppState>, since: String) -> Res<Vec<serde_json::Value>> {
    let conn = state.db.lock().map_err(e)?;
    db::listens_since(&conn, &since).map_err(e)
}

#[tauri::command]
fn get_episode(state: State<'_, AppState>, episode_id: String) -> Res<Option<Episode>> {
    let conn = state.db.lock().map_err(e)?;
    db::get_episode(&conn, &episode_id).map_err(e)
}

#[tauri::command]
fn remove_show(state: State<'_, AppState>, show_id: String) -> Res<()> {
    let conn = state.db.lock().map_err(e)?;
    db::delete_show(&conn, &show_id).map_err(e)
}

#[tauri::command]
fn set_progress(state: State<'_, AppState>, episode_id: String, progress: f64) -> Res<()> {
    let conn = state.db.lock().map_err(e)?;
    db::set_progress(&conn, &episode_id, progress).map_err(e)
}

#[tauri::command]
async fn search_podcasts(term: String, country: Option<String>) -> Res<Vec<Show>> {
    let cc = country.unwrap_or_else(|| "US".into());
    feeds::search_podcasts(&term, &cc).await.map_err(e)
}

#[tauri::command]
async fn youtube_subscriptions(state: State<'_, AppState>, browser: String) -> Res<Vec<import::Channel>> {
    let bin = ytdlp::ensure_ytdlp(&state.data).await.map_err(e)?;
    import::youtube_subscriptions(&bin, &browser).await.map_err(e)
}

#[tauri::command]
fn open_privacy_settings() -> Res<()> {
    import::open_privacy_settings().map_err(e)
}

#[tauri::command]
fn load_transcript(state: State<'_, AppState>, episode_id: String) -> Res<Option<Transcript>> {
    let conn = state.db.lock().map_err(e)?;
    db::load_transcript(&conn, &episode_id).map_err(e)
}

/// 拉一条 YouTube 轨为 transcript；非中文口语时把节目方中文轨对齐进 blob zh。
/// 原文：clean+resegment；中文对齐轨只 clean，保留细时间戳。
async fn youtube_transcript(
    state: &AppState,
    ep: &Episode,
    info: &captions::VideoInfo,
    track: &captions::Track,
) -> anyhow::Result<Transcript> {
    let segs = captions::resegment(captions::clean(captions::fetch_track_raw(track).await?));
    let t = Transcript {
        episode_id: ep.id.clone(),
        source: if track.auto {
            "youtube-auto".into()
        } else {
            "youtube".into()
        },
        language: track.language.clone(),
        segments: segs,
    };
    if t.segments.is_empty() {
        return Ok(t);
    }
    {
        let conn = state.db.lock().map_err(|x| anyhow::anyhow!("{x}"))?;
        db::save_transcript(&conn, &t)?;
    }
    if let Some(zh) = captions::official_chinese(&info.tracks, &track.language) {
        if let Ok(raw) = captions::fetch_track_raw(zh).await {
            let items = captions::align(&t.segments, &captions::clean(raw));
            if items.iter().filter(|x| x.is_some()).count() * 10 >= items.len() * 6 {
                let conn = state.db.lock().map_err(|x| anyhow::anyhow!("{x}"))?;
                db::set_blob(&conn, &ep.id, "zh", &serde_json::to_string(&items)?)?;
                db::set_blob(&conn, &ep.id, "zh-engine", "youtube")?;
            }
        }
    }
    Ok(t)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackChoice {
    language: String,
    auto: bool,
}

#[tauri::command]
async fn youtube_tracks(state: State<'_, AppState>, episode_id: String) -> Res<Vec<TrackChoice>> {
    let ep = {
        let conn = state.db.lock().map_err(e)?;
        db::get_episode(&conn, &episode_id)
            .map_err(e)?
            .ok_or_else(|| "单集不存在".to_string())?
    };
    let Some(vid) = &ep.video_id else {
        return Ok(vec![]);
    };
    let info = captions::video_info(vid).await.map_err(e)?;
    let mut out: Vec<TrackChoice> = Vec::new();
    for t in info
        .tracks
        .iter()
        .filter(|t| !t.auto)
        .chain(info.tracks.iter().filter(|t| t.auto))
    {
        if !out.iter().any(|c| c.language == t.language) {
            out.push(TrackChoice {
                language: t.language.clone(),
                auto: t.auto,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
async fn use_youtube_track(
    state: State<'_, AppState>,
    episode_id: String,
    language: String,
    auto: bool,
) -> Res<Transcript> {
    let ep = {
        let conn = state.db.lock().map_err(e)?;
        db::get_episode(&conn, &episode_id)
            .map_err(e)?
            .ok_or_else(|| "单集不存在".to_string())?
    };
    let vid = ep
        .video_id
        .clone()
        .ok_or_else(|| "不是视频节目".to_string())?;
    let info = captions::video_info(&vid).await.map_err(e)?;
    let track = info
        .tracks
        .iter()
        .find(|t| t.language == language && t.auto == auto)
        .ok_or_else(|| "没有这个语言的字幕".to_string())?
        .clone();
    let t = youtube_transcript(&state, &ep, &info, &track)
        .await
        .map_err(e)?;
    if t.segments.is_empty() {
        return Err("这条字幕是空的".into());
    }
    {
        let conn = state.db.lock().map_err(e)?;
        db::set_blob(&conn, &episode_id, "track-picked", "1").map_err(e)?;
    }
    Ok(t)
}

#[tauri::command]
async fn fetch_official_transcript(
    state: State<'_, AppState>,
    episode_id: String,
) -> Res<Option<Transcript>> {
    let mut ep = {
        let conn = state.db.lock().map_err(e)?;
        db::get_episode(&conn, &episode_id)
            .map_err(e)?
            .ok_or_else(|| "单集不存在".to_string())?
    };
    // 纯音频订阅（如词元 Anchor）开集时补 YouTube 配对，才能直接拉官方字幕、不必 ASR 下音频
    if ep.video_id.as_ref().map(|v| v.is_empty()).unwrap_or(true) {
        let (feed, title) = {
            let conn = state.db.lock().map_err(e)?;
            let show = db::get_show(&conn, &ep.show_id).map_err(e)?;
            (
                show.as_ref()
                    .map(|s| s.feed_url.clone())
                    .unwrap_or_default(),
                show.as_ref()
                    .map(|s| s.title.clone())
                    .or_else(|| ep.show_title.clone())
                    .unwrap_or_default(),
            )
        };
        if let Some(vid) = feeds::fill_youtube_twin(&ep, &feed, &title).await {
            if let Ok(conn) = state.db.lock() {
                let _ = db::set_video_id(&conn, &ep.id, &vid);
            }
            ep.video_id = Some(vid);
        }
    }

    let t = if let Some(vid) = &ep.video_id {
        let info = captions::video_info(vid).await.map_err(e)?;
        let hint =
            captions::script_hint(&info.title).or_else(|| captions::script_hint(&ep.title));
        match captions::choose(&info.tracks, info.original_language.as_deref(), hint) {
            Some(track) => {
                let t = youtube_transcript(&state, &ep, &info, track)
                    .await
                    .map_err(e)?;
                return Ok((!t.segments.is_empty()).then_some(t));
            }
            None => None,
        }
    } else if let Some(url) = ep
        .transcript_url
        .as_ref()
        .filter(|_| ep.transcript_type.as_deref() != Some("podscribe"))
    {
        let kind = ep.transcript_type.clone().unwrap_or_default();
        let segs = captions::fetch_rss_transcript(url, &kind).await.map_err(e)?;
        (!segs.is_empty()).then(|| Transcript {
            episode_id: ep.id.clone(),
            source: "rss".into(),
            language: "auto".into(),
            segments: segs,
        })
    } else {
        None
    };

    let t = match t {
        Some(t) => Some(t),
        None if ep.transcript_type.as_deref() == Some("podscribe") && ep.transcript_url.is_some() => {
            let segs = qiaomu::podscribe_transcript(ep.transcript_url.as_ref().unwrap())
                .await
                .map_err(e)?;
            (!segs.is_empty()).then(|| Transcript {
                episode_id: ep.id.clone(),
                source: "podscribe".into(),
                language: "en".into(),
                segments: captions::resegment(segs),
            })
        }
        None if ep.transcript_type.as_deref() == Some("qiaomu") => match &ep.link {
            Some(link) => {
                let d = qiaomu::detail(link).await.map_err(e)?;
                d.transcript.map(|text| Transcript {
                    episode_id: ep.id.clone(),
                    source: "qiaomu".into(),
                    language: "auto".into(),
                    segments: qiaomu::transcript_segments(
                        &text,
                        ep.duration.unwrap_or(3600.0),
                    ),
                })
            }
            None => None,
        },
        None => None,
    };

    if let Some(ref transcript) = t {
        if transcript.segments.is_empty() {
            return Ok(None);
        }
        let conn = state.db.lock().map_err(e)?;
        db::save_transcript(&conn, transcript).map_err(e)?;
    }
    Ok(t)
}

/// 开集官方未命中时查共享库，避免无谓下载模型。
#[tauri::command]
async fn shared_transcript(state: State<'_, AppState>, episode_id: String) -> Res<Option<Transcript>> {
    let ep = {
        let conn = state.db.lock().map_err(e)?;
        db::get_episode(&conn, &episode_id)
            .map_err(e)?
            .ok_or_else(|| "单集不存在".to_string())?
    };
    Ok(take_shared(&state, &ep).await)
}

/// 列表用：哪些单集已有共享字幕。
#[tauri::command]
async fn shared_exists(state: State<'_, AppState>, episode_ids: Vec<String>) -> Res<Vec<String>> {
    let eps: Vec<Episode> = {
        let conn = state.db.lock().map_err(e)?;
        episode_ids
            .iter()
            .take(200)
            .filter_map(|id| db::get_episode(&conn, id).ok().flatten())
            .collect()
    };
    let lists: Vec<Vec<String>> = eps.iter().map(shared::keys).collect();
    let hits = shared::existing(&lists).await;
    Ok(eps
        .into_iter()
        .zip(hits)
        .filter(|(_, h)| *h)
        .map(|(ep, _)| ep.id)
        .collect())
}

/// 别人分享的导读；命中后写入 blob summary + summary-from=shared。
#[tauri::command]
async fn shared_guide(state: State<'_, AppState>, episode_id: String) -> Res<Option<String>> {
    let ep = {
        let conn = state.db.lock().map_err(e)?;
        db::get_episode(&conn, &episode_id)
            .map_err(e)?
            .ok_or_else(|| "单集不存在".to_string())?
    };
    let Some(text) = shared::lookup_guide(&shared::keys(&ep)).await else {
        return Ok(None);
    };
    let conn = state.db.lock().map_err(e)?;
    let _ = db::set_blob(&conn, &episode_id, "summary", &text);
    let _ = db::set_blob(&conn, &episode_id, "summary-from", "shared");
    Ok(Some(text))
}

/// 匿名上传本机导读（受 shareTranscripts 约束）；同时清掉 summary-from。
#[tauri::command]
async fn share_guide(
    state: State<'_, AppState>,
    episode_id: String,
    text: String,
    model: String,
) -> Res<String> {
    let (ep, on, install) = {
        let conn = state.db.lock().map_err(e)?;
        let ep = db::get_episode(&conn, &episode_id)
            .map_err(e)?
            .ok_or_else(|| "单集不存在".to_string())?;
        let on = share_on(&conn);
        let _ = db::set_blob(&conn, &episode_id, "summary-from", "");
        (ep, on, install_id(&conn))
    };
    let keys = shared::keys(&ep);
    if !on || keys.is_empty() {
        return Ok("skipped".into());
    }
    shared::upload_guide(
        &keys,
        &ep.title,
        ep.show_title.as_deref().unwrap_or(""),
        &model,
        &text,
        install,
    )
    .await
    .map_err(e)
}

/// 豆包 TTS：返回 base64 WAV（至多 1000 字）。
#[tauri::command]
async fn tts_speak(text: String, voice: String, resource: Option<String>) -> Res<String> {
    use base64::Engine;
    let wav = tts::synthesize(&voice, resource.as_deref().unwrap_or(""), &text)
        .await
        .map_err(e)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(wav))
}

/// 匿名上传已完成的中文机翻（仅 ASR/共享来源；受 shareTranscripts 约束）。
#[tauri::command]
async fn share_translation(
    state: State<'_, AppState>,
    episode_id: String,
    engine: String,
    model: String,
) -> Res<String> {
    let (ep, t, items, made_by, on, install) = {
        let conn = state.db.lock().map_err(e)?;
        let ep = db::get_episode(&conn, &episode_id)
            .map_err(e)?
            .ok_or_else(|| "单集不存在".to_string())?;
        let t = db::load_transcript(&conn, &episode_id)
            .map_err(e)?
            .ok_or_else(|| "没有字幕".to_string())?;
        let items: Vec<Option<String>> = db::get_blob(&conn, &episode_id, "zh")
            .map_err(e)?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let made_by = db::get_blob(&conn, &episode_id, "asr-meta")
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
        let on = share_on(&conn);
        (ep, t, items, made_by, on, install_id(&conn))
    };
    if !on || !matches!(engine.as_str(), "llm" | "google") {
        return Ok("skipped".into());
    }
    let (source, asr_model) = match (t.source.as_str(), &made_by) {
        ("whisper" | "cloud" | "qwen3", Some(m)) => (
            m["source"].as_str().unwrap_or("whisper").to_string(),
            m["model"].as_str().unwrap_or("").to_string(),
        ),
        (s, _) if s.starts_with("shared:") => {
            (s.trim_start_matches("shared:").to_string(), String::new())
        }
        _ => return Ok("skipped".into()),
    };
    if !matches!(source.as_str(), "whisper" | "qwen3" | "cloud") || items.len() != t.segments.len() {
        return Ok("skipped".into());
    }
    let filled = items
        .iter()
        .filter(|i| i.as_ref().is_some_and(|s| !s.is_empty()))
        .count();
    if filled * 10 < items.len() * 9 {
        return Ok("skipped".into());
    }
    let keys = shared::keys(&ep);
    if keys.is_empty() {
        return Ok("skipped".into());
    }
    let meta = shared::UploadMeta {
        title: ep.title.clone(),
        show: ep.show_title.clone().unwrap_or_default(),
        duration: ep
            .duration
            .unwrap_or(0.0)
            .max(t.segments.last().map(|s| s.end).unwrap_or(0.0))
            .max(1.0),
        source,
        model: asr_model,
        language: t.language.clone(),
        install,
        translation: Some(("zh-CN".to_string(), items)),
    };
    shared::upload_with(&keys, meta, &t.segments, &engine, &model)
        .await
        .map_err(e)
}

#[tauri::command]
fn get_blob(state: State<'_, AppState>, episode_id: String, kind: String) -> Res<Option<String>> {
    let conn = state.db.lock().map_err(e)?;
    db::get_blob(&conn, &episode_id, &kind).map_err(e)
}

#[tauri::command]
fn set_blob(state: State<'_, AppState>, episode_id: String, kind: String, data: String) -> Res<()> {
    let conn = state.db.lock().map_err(e)?;
    db::set_blob(&conn, &episode_id, &kind, &data).map_err(e)
}

/// 乔木精读单集：补音频、缓存 deep-read HTML。字幕仍走 fetch_official。
#[tauri::command]
async fn qiaomu_detail(state: State<'_, AppState>, episode_id: String) -> Res<qiaomu::Detail> {
    let ep = {
        let conn = state.db.lock().map_err(e)?;
        db::get_episode(&conn, &episode_id)
            .map_err(e)?
            .ok_or_else(|| "单集不存在".to_string())?
    };
    let tt = ep.transcript_type.as_deref().unwrap_or("");
    let mut d = if tt == "qiaomu-rss" || tt == "podscribe" {
        qiaomu::Detail {
            audio: None,
            deep_read: qiaomu::rss_rewrite(&ep.guid).await.map_err(e)?,
            transcript: None,
        }
    } else {
        let link = ep
            .link
            .as_deref()
            .ok_or_else(|| "这集没有精读页面链接".to_string())?;
        qiaomu::detail(link).await.map_err(e)?
    };
    {
        let conn = state.db.lock().map_err(e)?;
        if let Some(a) = &d.audio {
            if ep.audio_url.is_none() {
                let _ = db::set_audio_url(&conn, &ep.id, a);
            }
        }
        if let Some(h) = &d.deep_read {
            let _ = db::set_blob(&conn, &ep.id, "deep-read", h);
        }
    }
    // 字幕走官方瀑布，不在这里塞进返回值
    d.transcript = None;
    Ok(d)
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Res<Option<String>> {
    let conn = state.db.lock().map_err(e)?;
    db::get_setting(&conn, "app").map_err(e)
}

#[tauri::command]
fn set_settings(state: State<'_, AppState>, value: String) -> Res<()> {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&value) {
        let proxy = v.get("proxy").and_then(|x| x.as_str()).map(str::to_string);
        let _ = net::set_proxy(proxy);
    }
    let conn = state.db.lock().map_err(e)?;
    db::set_setting(&conn, "app", &value).map_err(e)
}

#[tauri::command]
fn set_api_key(provider: String, key: String) -> Res<()> {
    secrets::set_key(&provider, &key).map_err(e)
}

#[tauri::command]
fn has_api_key(provider: String) -> Res<bool> {
    Ok(secrets::has_key(&provider))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatReq {
    provider: String,
    base_url: String,
    model: String,
    protocol: String,
    messages: Vec<llm::ChatMessage>,
    stream: Option<bool>,
}

#[tauri::command]
async fn llm_chat(app: AppHandle, req: ChatReq) -> Res<String> {
    let key = secrets::get_key(&req.provider)
        .map_err(e)?
        .ok_or_else(|| "请先在设置里保存 API Key".to_string())?;
    let cfg = llm::LlmConfig {
        base_url: req.base_url,
        model: req.model,
        protocol: req.protocol,
        api_key: key,
    };
    if req.stream.unwrap_or(true) {
        let app2 = app.clone();
        llm::chat_stream(&cfg, &req.messages, move |delta| {
            let _ = app2.emit("llm-delta", delta);
        })
        .await
        .map_err(e)
    } else {
        llm::chat_once(&cfg, &req.messages).await.map_err(e)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslateReq {
    texts: Vec<String>,
    target: Option<String>,
    engine: Option<String>,
    provider: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    protocol: Option<String>,
}

#[tauri::command]
async fn translate_batch(req: TranslateReq) -> Res<Vec<String>> {
    let target = req.target.unwrap_or_else(|| "zh-CN".into());
    let engine = req.engine.unwrap_or_else(|| "google".into());
    if engine == "llm" {
        let provider = req.provider.ok_or_else(|| "缺少 provider".to_string())?;
        let key = secrets::get_key(&provider)
            .map_err(e)?
            .ok_or_else(|| "请先保存 API Key".to_string())?;
        let cfg = llm::LlmConfig {
            base_url: req.base_url.unwrap_or_default(),
            model: req.model.unwrap_or_default(),
            protocol: req.protocol.unwrap_or_else(|| "openai".into()),
            api_key: key,
        };
        translate::llm_batch(&cfg, &req.texts, &target).await.map_err(e)
    } else {
        translate::google_batch(&req.texts, &target).await.map_err(e)
    }
}

/// 谷歌机翻 + 持久化行缓存；字幕并发批与标题翻译共用。
#[tauri::command]
async fn translate_texts(
    state: State<'_, AppState>,
    texts: Vec<String>,
    target: Option<String>,
) -> Res<Vec<String>> {
    let tl = target.unwrap_or_else(|| "zh-CN".into());
    let keys: Vec<String> = texts
        .iter()
        .map(|t| short_hash(&format!("{tl}|{t}"), 24))
        .collect();
    let mut out: Vec<Option<String>> = {
        let conn = state.db.lock().map_err(e)?;
        keys.iter()
            .map(|k| db::tr_get(&conn, k).ok().flatten())
            .collect()
    };
    let missing: Vec<usize> = (0..texts.len())
        .filter(|&i| out[i].is_none() && !texts[i].trim().is_empty())
        .collect();
    if !missing.is_empty() {
        let lines: Vec<String> = missing.iter().map(|&i| texts[i].clone()).collect();
        let done = translate::google_batch(&lines, &tl).await.map_err(e)?;
        let conn = state.db.lock().map_err(e)?;
        for (j, &i) in missing.iter().enumerate() {
            if let Some(t) = done.get(j) {
                let _ = db::tr_put(&conn, &keys[i], t);
                out[i] = Some(t.clone());
            }
        }
    }
    Ok(out.into_iter().map(Option::unwrap_or_default).collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudAsrReq {
    episode_id: String,
    audio_url: String,
    provider: String,
    base_url: String,
    model: String,
    language: Option<String>,
}

/// 云端 Whisper 兼容接口（OpenAI /audio/transcriptions）。
#[tauri::command]
async fn cloud_transcribe(state: State<'_, AppState>, req: CloudAsrReq) -> Res<Transcript> {
    let ep = {
        let conn = state.db.lock().map_err(e)?;
        db::get_episode(&conn, &req.episode_id)
            .map_err(e)?
            .ok_or_else(|| "单集不存在".to_string())?
    };
    if let Some(t) = take_shared(&state, &ep).await {
        return Ok(t);
    }
    let key = secrets::get_key(&req.provider).map_err(e)?;
    let bytes = net::get_bytes(&req.audio_url).await.map_err(e)?;
    let url = format!("{}/audio/transcriptions", req.base_url.trim_end_matches('/'));
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name("audio.mp3")
        .mime_str("audio/mpeg")
        .map_err(e)?;
    let mut form = reqwest::multipart::Form::new()
        .text("model", req.model.clone())
        .text("response_format", "verbose_json")
        .part("file", part);
    if let Some(lang) = req.language.filter(|s| s != "auto") {
        form = form.text("language", lang);
    }
    let mut req_builder = net::client().post(&url).multipart(form);
    if let Some(k) = key.filter(|s| !s.is_empty()) {
        req_builder = req_builder.bearer_auth(k);
    } else if !req.provider.starts_with("asr.local") && req.provider != "local-server" {
        return Err("云端识别需要 API Key".into());
    }
    let resp = req_builder.send().await.map_err(e)?;
    if !resp.status().is_success() {
        let status = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(format!("识别失败 HTTP {status}: {t}"));
    }
    let v: serde_json::Value = resp.json().await.map_err(e)?;
    let mut segments = Vec::new();
    for s in v["segments"].as_array().into_iter().flatten() {
        let text = s["text"].as_str().unwrap_or("").trim().to_string();
        if text.is_empty() {
            continue;
        }
        segments.push(model::Segment {
            start: s["start"].as_f64().unwrap_or(0.0),
            end: s["end"].as_f64().unwrap_or(0.0),
            text,
        });
    }
    if segments.is_empty() {
        if let Some(text) = v["text"].as_str().filter(|t| !t.trim().is_empty()) {
            segments.push(model::Segment {
                start: 0.0,
                end: 0.0,
                text: text.trim().to_string(),
            });
        }
    }
    let segments = captions::resegment(captions::clean(segments));
    if segments.is_empty() {
        return Err("没有识别出文字".into());
    }
    let t = Transcript {
        episode_id: ep.id.clone(),
        source: "cloud".into(),
        language: v["language"].as_str().unwrap_or("auto").into(),
        segments,
    };
    let share_keys = shared::keys(&ep);
    {
        let conn = state.db.lock().map_err(e)?;
        db::save_transcript(&conn, &t).map_err(e)?;
        let meta = serde_json::json!({ "source": "cloud", "model": req.model });
        let _ = db::set_blob(&conn, &ep.id, "asr-meta", &meta.to_string());
    }
    if !share_keys.is_empty() {
        let (on, install) = {
            let conn = state.db.lock().map_err(e)?;
            (share_on(&conn), install_id(&conn))
        };
        if on {
            let last_end = t.segments.last().map(|s| s.end).unwrap_or(0.0);
            let meta = shared::UploadMeta {
                title: ep.title.clone(),
                show: ep.show_title.clone().unwrap_or_default(),
                duration: ep.duration.unwrap_or(0.0).max(last_end).max(1.0),
                source: "cloud".into(),
                model: req.model.clone(),
                language: t.language.clone(),
                install,
                translation: None,
            };
            let segs = t.segments.clone();
            tokio::spawn(async move {
                let _ = shared::upload_with(&share_keys, meta, &segs, "google", "").await;
            });
        }
    }
    Ok(t)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListModelsReq {
    provider: String,
    base_url: String,
    protocol: String,
}

/// OpenAI 兼容 /models；Anthropic 暂返回空，前端可手填。
#[tauri::command]
async fn list_models(req: ListModelsReq) -> Res<Vec<String>> {
    if req.protocol == "anthropic" {
        return Ok(vec![]);
    }
    let key = secrets::get_key(&req.provider).map_err(e)?.unwrap_or_default();
    let url = format!("{}/models", req.base_url.trim_end_matches('/'));
    let mut b = net::client().get(&url);
    if !key.is_empty() {
        b = b.bearer_auth(key);
    }
    let resp = b.send().await.map_err(e)?;
    if !resp.status().is_success() {
        let status = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(format!("获取模型列表失败 HTTP {status}: {t}"));
    }
    let v: serde_json::Value = resp.json().await.map_err(e)?;
    let mut ids: Vec<String> = v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m["id"].as_str().map(str::to_string))
        .collect();
    ids.sort();
    Ok(ids)
}

/// 把订阅写成 OPML，落到系统「下载」。
#[tauri::command]
fn export_opml(state: State<'_, AppState>) -> Res<String> {
    let conn = state.db.lock().map_err(e)?;
    let shows = db::list_shows(&conn).map_err(e)?;
    let list: Vec<(String, String)> = shows
        .into_iter()
        .filter(|s| s.feed_url.starts_with("http"))
        .map(|s| (s.title, s.feed_url))
        .collect();
    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "找不到下载文件夹".to_string())?;
    let path = dir.join(format!(
        "Subpodcast-{}.opml",
        chrono::Local::now().format("%Y%m%d")
    ));
    std::fs::write(&path, import::opml(&list)).map_err(e)?;
    Ok(path.to_string_lossy().into())
}

fn dir_bytes(path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let Ok(rd) = std::fs::read_dir(path) else {
        return 0;
    };
    for ent in rd.flatten() {
        let p = ent.path();
        if p.is_dir() {
            total = total.saturating_add(dir_bytes(&p));
        } else if let Ok(m) = ent.metadata() {
            total = total.saturating_add(m.len());
        }
    }
    total
}

#[tauri::command(async)]
fn storage_info(state: State<'_, AppState>) -> serde_json::Value {
    let d = &state.data;
    let library: u64 = ["library.db", "library.db-wal", "library.db-shm"]
        .iter()
        .map(|f| std::fs::metadata(d.join(f)).map(|m| m.len()).unwrap_or(0))
        .sum();
    serde_json::json!({
        "downloads": dir_bytes(&offline::dir(d)),
        "models": dir_bytes(&d.join("models")),
        "library": library,
        "temp": dir_bytes(&d.join("work")),
    })
}

#[tauri::command]
async fn download_episode(
    app: AppHandle,
    state: State<'_, AppState>,
    episode_id: String,
) -> Res<offline::Saved> {
    if let Some(s) = offline::find(&state.data, &episode_id) {
        return Ok(s);
    }
    let ep = {
        let conn = state.db.lock().map_err(e)?;
        db::get_episode(&conn, &episode_id)
            .map_err(e)?
            .ok_or_else(|| "单集不存在".to_string())?
    };
    let job = format!("dl:{episode_id}");
    let cancel = begin_job(&state, &job);
    let data = state.data.clone();
    let id = episode_id.clone();
    let result = offline::download(&data, &ep, cancel, |p| {
        let _ = app.emit(
            "offline",
            serde_json::json!({ "episodeId": id, "progress": p }),
        );
    })
    .await;
    end_job(&state, &job);
    result.map_err(e)
}

#[tauri::command]
fn list_downloads(state: State<'_, AppState>) -> Vec<offline::Saved> {
    offline::list(&state.data)
}

#[tauri::command]
fn delete_download(state: State<'_, AppState>, episode_id: String) -> Res<()> {
    offline::remove(&state.data, &episode_id).map_err(e)
}

#[tauri::command]
fn open_data_folder(app: AppHandle, state: State<'_, AppState>, kind: String) -> Res<()> {
    use tauri_plugin_opener::OpenerExt;
    let dir = match kind.as_str() {
        "downloads" => offline::dir(&state.data),
        "models" => state.data.join("models"),
        _ => state.data.clone(),
    };
    std::fs::create_dir_all(&dir).map_err(e)?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(e)
}

#[tauri::command(async)]
fn clear_temp(state: State<'_, AppState>) -> Res<()> {
    let dir = state.data.join("work");
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(e)?;
    }
    Ok(())
}

fn begin_job(state: &AppState, id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut jobs) = state.jobs.lock() {
        if let Some(old) = jobs.insert(id.to_string(), flag.clone()) {
            old.store(true, Ordering::Relaxed);
        }
    }
    flag
}

fn end_job(state: &AppState, id: &str) {
    if let Ok(mut jobs) = state.jobs.lock() {
        jobs.remove(id);
    }
}

#[tauri::command]
fn asr_models(state: State<'_, AppState>) -> Res<Vec<asr::ModelInfo>> {
    Ok(asr::list_models(&state.data))
}

#[tauri::command]
fn rescan_asr_models(state: State<'_, AppState>) -> Res<Vec<asr::ModelInfo>> {
    asr::rescan();
    Ok(asr::list_models(&state.data))
}

#[tauri::command]
async fn download_asr_model(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    mirror_first: Option<bool>,
) -> Res<()> {
    let job = format!("model:{id}");
    let cancel = begin_job(&state, &job);
    let data = state.data.clone();
    let mirror = mirror_first.unwrap_or(true);
    let result = asr::download_model(&data, &id, &cancel, mirror, |received, total| {
        let _ = app.emit(
            "model-download",
            serde_json::json!({ "id": id, "received": received, "total": total }),
        );
    })
    .await;
    end_job(&state, &job);
    result.map_err(e)
}

#[tauri::command]
fn delete_asr_model(state: State<'_, AppState>, id: String) -> Res<()> {
    asr::delete_model(&state.data, &id).map_err(e)
}

#[tauri::command]
fn cancel_job(state: State<'_, AppState>, id: String) -> Res<()> {
    if let Ok(jobs) = state.jobs.lock() {
        if let Some(f) = jobs.get(&id) {
            f.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalAsrReq {
    episode_id: String,
    model: String,
    language: Option<String>,
}

/// 本机识别：拉音频 → 16k → Qwen3/CrispASR 或 Whisper 子进程 → 存库。
#[tauri::command]
async fn local_transcribe(app: AppHandle, state: State<'_, AppState>, req: LocalAsrReq) -> Res<Transcript> {
    let ep = {
        let conn = state.db.lock().map_err(e)?;
        db::get_episode(&conn, &req.episode_id)
            .map_err(e)?
            .ok_or_else(|| "单集不存在".to_string())?
    };
    let share_keys = shared::keys(&ep);
    if let Some(t) = take_shared(&state, &ep).await {
        let _ = app.emit(
            "asr",
            serde_json::json!({
                "episodeId": req.episode_id,
                "stage": "done",
                "progress": 1.0,
            }),
        );
        return Ok(t);
    }
    let resolved = asr::resolve(&state.data, &req.model).ok_or_else(|| "未知模型".to_string())?;
    if !resolved.path.is_file() {
        return Err("请先下载本机模型".into());
    }
    let cancel = begin_job(&state, &req.episode_id);
    let work = state.data.join("work").join(format!("{}-{}", ep.id, Uuid::new_v4()));
    let language = req.language.unwrap_or_else(|| "auto".into());
    let emit_asr = |stage: &str, progress: f64, message: Option<&str>| {
        let _ = app.emit(
            "asr",
            serde_json::json!({
                "episodeId": ep.id,
                "stage": stage,
                "progress": progress,
                "message": message,
            }),
        );
    };

    let run = async {
        emit_asr("download", 0.0, Some("准备音频…"));
        let audio = asr::fetch_episode_audio(
            &state.data,
            &work,
            ep.audio_url.as_deref(),
            ep.video_id.as_deref(),
            &cancel,
            |p| emit_asr("download", p, None),
        )
        .await
        .map_err(e)?;

        emit_asr("transcribe", 0.4, Some("识别中…"));
        let (language_out, segments) = if resolved.engine == "qwen3" {
            let bin = asr::ensure_crispasr(&state.data, &cancel, |_, _| {})
                .await
                .map_err(e)?;
            let samples = tokio::task::spawn_blocking({
                let audio = audio.clone();
                move || asr::decode_16k_mono(&audio)
            })
            .await
            .map_err(e)?
            .map_err(e)?;
            let wav = work.join("audio.wav");
            asr::write_wav(&wav, &samples).map_err(e)?;
            let segs = asr::run_crispasr(
                &bin,
                &resolved.path,
                &wav,
                &language,
                cancel.clone(),
                |p| emit_asr("transcribe", 0.4 + p * 0.55, None),
            )
            .await
            .map_err(e)?;
            (language.clone(), segs)
        } else {
            let result = asr::run_whisper_worker(
                &audio,
                &resolved.path,
                &language,
                cancel.clone(),
                |ev| match ev {
                    asr::WorkerEvent::Progress(p) => emit_asr("transcribe", 0.4 + p * 0.55, None),
                    asr::WorkerEvent::Segment(s) => {
                        let _ = app.emit(
                            "asr",
                            serde_json::json!({
                                "episodeId": ep.id,
                                "stage": "segment",
                                "progress": 0.7,
                                "segment": s,
                            }),
                        );
                    }
                },
            )
            .await
            .map_err(e)?;
            (result.language, result.segments)
        };

        let segments = captions::resegment(captions::clean(segments));
        if segments.is_empty() {
            return Err("没有识别出文字（可能是静音或纯音乐）".into());
        }
        let source = if resolved.engine == "qwen3" {
            "qwen3"
        } else {
            "whisper"
        };
        let t = Transcript {
            episode_id: ep.id.clone(),
            source: source.into(),
            language: language_out,
            segments,
        };
        {
            let conn = state.db.lock().map_err(e)?;
            db::save_transcript(&conn, &t).map_err(e)?;
            let meta = serde_json::json!({ "source": source, "model": req.model });
            let _ = db::set_blob(&conn, &ep.id, "asr-meta", &meta.to_string());
        }
        emit_asr("done", 1.0, None);
        Ok(t)
    };

    let result = run.await;
    let _ = std::fs::remove_dir_all(&work);
    end_job(&state, &req.episode_id);
    if let (Ok(ref t), false) = (&result, share_keys.is_empty()) {
        let (on, install) = match state.db.lock() {
            Ok(conn) => (share_on(&conn), install_id(&conn)),
            Err(_) => (false, String::new()),
        };
        if on {
            let last_end = t.segments.last().map(|s| s.end).unwrap_or(0.0);
            let source = t.source.clone();
            let meta = shared::UploadMeta {
                title: ep.title.clone(),
                show: ep.show_title.clone().unwrap_or_default(),
                duration: ep.duration.unwrap_or(0.0).max(last_end).max(1.0),
                source: source.clone(),
                model: req.model.clone(),
                language: t.language.clone(),
                install,
                translation: None,
            };
            let segs = t.segments.clone();
            let keys = share_keys;
            tokio::spawn(async move {
                let _ = shared::upload_with(&keys, meta, &segs, "google", "").await;
            });
        }
    }
    if let Err(ref err) = result {
        let _ = app.emit(
            "asr",
            serde_json::json!({
                "episodeId": req.episode_id,
                "stage": "error",
                "progress": 0.0,
                "message": err,
            }),
        );
    }
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--asr-worker") {
        std::process::exit(asr::worker_main(&args[2..]));
    }

    let dir = data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let db_path = dir.join("library.db");
    let conn = db::open(&db_path).expect("open db");
    if let Ok(Some(raw)) = db::get_setting(&conn, "app") {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            let proxy = v.get("proxy").and_then(|x| x.as_str()).map(str::to_string);
            let _ = net::set_proxy(proxy);
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            db: Mutex::new(conn),
            data: dir,
            jobs: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            add_subscription,
            refresh_show,
            refresh_all,
            list_shows,
            list_episodes,
            recent_episodes,
            get_episode,
            remove_show,
            set_progress,
            search_podcasts,
            youtube_subscriptions,
            open_privacy_settings,
            load_transcript,
            fetch_official_transcript,
            youtube_tracks,
            use_youtube_track,
            shared_transcript,
            shared_exists,
            shared_guide,
            share_guide,
            share_translation,
            tts_speak,
            get_blob,
            set_blob,
            qiaomu_detail,
            download_episode,
            list_downloads,
            delete_download,
            get_settings,
            set_settings,
            set_api_key,
            has_api_key,
            llm_chat,
            translate_batch,
            translate_texts,
            cloud_transcribe,
            local_transcribe,
            asr_models,
            rescan_asr_models,
            download_asr_model,
            delete_asr_model,
            cancel_job,
            list_models,
            export_opml,
            storage_info,
            open_data_folder,
            clear_temp,
            log_listen,
            listening_stats,
            preview_show,
            cached_show,
        ])
        .setup(|app| {
            // 开发：Vite；发行：http://localhost（YouTube 拒绝 tauri://）
            #[cfg(debug_assertions)]
            let url = tauri::WebviewUrl::App("index.html".into());
            #[cfg(not(debug_assertions))]
            let url = {
                let port = ui::serve_bundled_ui(app.handle());
                tauri::WebviewUrl::External(
                    format!("http://localhost:{port}")
                        .parse()
                        .expect("localhost url"),
                )
            };
            tauri::WebviewWindowBuilder::new(app, "main", url)
                .title("Subpodcast · 声译")
                .inner_size(1280.0, 840.0)
                .min_inner_size(960.0, 640.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Subpodcast");
}
