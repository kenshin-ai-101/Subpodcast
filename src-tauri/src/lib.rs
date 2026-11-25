/**
 * [INPUT]: 聚合 db/feeds/captions/qiaomu/shared/translate/llm/secrets/net/asr/offline/clip/anki/speech/local_tts
 * [OUTPUT]: Tauri 命令面（含 shared_* / tts_* / local_tts_* / learn_clip / export_anki / video_clip_* / fetch_cover_data_url / reveal_file）与启动
 * [POS]: Rust 侧总控；新命令需同步 build.rs COMMANDS 与 capabilities
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
mod align;
mod anki;
pub mod asr;
mod captions;
pub mod cli_install;
mod clip;
mod db;
mod edge_gec;
mod edge_tts;
mod feeds;
mod import;
mod llm;
mod local_tts;
pub mod mcp;
mod mcp_connect;
mod model;
mod net;
mod offline;
mod qiaomu;
mod secrets;
mod shared;
mod speech;
mod translate;
mod tts;
mod ui;
mod videoclip;
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
    /// 可取消任务：episodeId / model:{id} / llm:{id}
    jobs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

/// RAII 任务守卫：退出/panic/取消时只清理自己注册的那份 cancel flag（Arc::ptr_eq），不误删替代任务。
struct JobGuard {
    jobs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    id: String,
    flag: Arc<AtomicBool>,
}

impl JobGuard {
    fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.flag.clone()
    }
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = self.jobs.lock() {
            if map.get(&self.id).is_some_and(|cur| Arc::ptr_eq(cur, &self.flag)) {
                map.remove(&self.id);
            }
        }
    }
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

/// 默认关闭匿名上传（隐私保护）；仅当用户显式开启时返回 true。
fn share_on(conn: &rusqlite::Connection) -> bool {
    db::get_setting(conn, "app")
        .ok()
        .flatten()
        .and_then(|r| serde_json::from_str::<serde_json::Value>(&r).ok())
        .and_then(|s| s["shareTranscripts"].as_bool())
        .unwrap_or(false)
}

/// 私有/含鉴权参数或内网订阅源永不上传共享库。
fn is_private_episode(conn: &rusqlite::Connection, ep: &Episode) -> bool {
    let urls = [
        ep.audio_url.as_deref().unwrap_or(""),
        ep.link.as_deref().unwrap_or(""),
    ];
    let feed_url = db::get_show(conn, &ep.show_id)
        .ok()
        .flatten()
        .map(|s| s.feed_url)
        .unwrap_or_default();
    for raw in urls.into_iter().chain(std::iter::once(feed_url.as_str())) {
        if raw.is_empty() {
            continue;
        }
        let Ok(u) = reqwest::Url::parse(raw) else {
            continue;
        };
        if !u.username().is_empty() || u.password().is_some() {
            return true;
        }
        if let Some(host) = u.host_str() {
            let h = host.to_ascii_lowercase();
            if h == "localhost"
                || h.ends_with(".local")
                || h.starts_with("127.")
                || h.starts_with("10.")
                || h.starts_with("192.168.")
                || h == "::1"
            {
                return true;
            }
        }
        if let Some(q) = u.query() {
            let ql = q.to_ascii_lowercase();
            if ql.contains("token=")
                || ql.contains("api_key=")
                || ql.contains("apikey=")
                || ql.contains("auth=")
                || ql.contains("pass=")
                || ql.contains("secret=")
                || ql.contains("signature=")
            {
                return true;
            }
        }
    }
    false
}

fn validate_outbound_base_url(raw: &str) -> Res<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let parsed = reqwest::Url::parse(trimmed).map_err(|_| "服务地址格式无效".to_string())?;
    let host = parsed
        .host_str()
        .map(|h| h.to_ascii_lowercase())
        .unwrap_or_default();
    let is_local = host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]";
    match parsed.scheme() {
        "https" => Ok(trimmed.to_string()),
        "http" if is_local => Ok(trimmed.to_string()),
        _ => Err("服务地址必须使用 https://（仅本机服务允许 http://）".into()),
    }
}

/// 从已持久化 settings 中解析 provider 对应的 baseUrl，阻断前端单次传参把密钥发往任意第三方域名。
fn resolve_saved_base_url(
    state: &AppState,
    section: &str,
    provider: &str,
    fallback: &str,
) -> Res<String> {
    let saved = state
        .db
        .lock()
        .ok()
        .and_then(|conn| db::get_setting(&conn, "app").ok().flatten())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| {
            v.get(section)?
                .get(provider)?
                .get("baseUrl")?
                .as_str()
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty());
    if let Some(url) = saved {
        return validate_outbound_base_url(&url);
    }
    // 尚未写库前的首次预设调用：仅放行常见官方域名或本机地址
    let checked = validate_outbound_base_url(fallback)?;
    let parsed = reqwest::Url::parse(&checked).map_err(|_| "服务地址格式无效".to_string())?;
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    const KNOWN_SUFFIXES: &[&str] = &[
        "openai.com",
        "anthropic.com",
        "deepseek.com",
        "googleapis.com",
        "openrouter.ai",
        "siliconflow.cn",
        "bigmodel.cn",
        "moonshot.cn",
        "groq.com",
        "dashscope.aliyuncs.com",
        "volces.com",
        "minimaxi.com",
        "minimax.chat",
        "elevenlabs.io",
        "xiaomimimo.com",
        "x.ai",
        "mistral.ai",
        "perplexity.ai",
        "together.xyz",
        "fireworks.ai",
        "aliyuncs.com",
    ];
    let is_local = host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]";
    let is_known = KNOWN_SUFFIXES
        .iter()
        .any(|s| host == *s || host.ends_with(&format!(".{s}")));
    if is_local || is_known {
        Ok(checked)
    } else {
        Err("请先在设置中保存该自定义服务地址后再调用".into())
    }
}

/// 共享库命中则落库字幕，并写入节目方译文（engine=shared）及参考音频元信息（audio-ref）。
async fn take_shared(state: &AppState, ep: &Episode) -> Option<Transcript> {
    let mut hit = shared::lookup(&shared::keys(ep)).await?;
    let translation = hit.translation.take();
    let audio_ref = hit.audio.take().map(|a| align::AudioRef {
        bytes: a.bytes,
        etag: a.etag,
        secs: a.secs,
        fp: None,
        shared_id: (!hit.id.is_empty()).then(|| hit.id.clone()),
        has_fp: a.fp,
    });
    let t = shared::into_transcript(&ep.id, hit);
    {
        let conn = state.db.lock().ok()?;
        db::save_transcript(&conn, &t).ok()?;
        if let Some(ref aref) = audio_ref {
            let _ = db::set_blob(
                &conn,
                &ep.id,
                "audio-ref",
                &serde_json::to_string(aref).unwrap_or_default(),
            );
        }
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

fn load_audio_ref(state: &AppState, episode_id: &str) -> Option<align::AudioRef> {
    let conn = state.db.lock().ok()?;
    db::get_blob(&conn, episode_id, "audio-ref")
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<align::AudioRef>(&s).ok())
        .filter(|r| r.fp.is_some())
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
    if resolved.catalog_partial {
        db::upsert_episodes(&mut conn, &resolved.episodes).map_err(e)?;
    } else {
        db::sync_episodes(&mut conn, &resolved.show.id, &resolved.episodes).map_err(e)?;
    }
    Ok(resolved.show)
}

#[tauri::command]
async fn refresh_show(state: State<'_, AppState>, show_id: String) -> Res<u32> {
    let show = {
        let conn = state.db.lock().map_err(e)?;
        db::get_show(&conn, &show_id).map_err(e)?.ok_or_else(|| "节目不存在".to_string())?
    };
    // slug 版 xyz / 半量 SSR：优先带上节目标题以便命中乔木精读全量；音频 URL 可反推 hex pid。
    let feed_url = {
        let mut feed = show.feed_url.clone();
        if (show.kind == "xiaoyuzhou" || feeds::is_xyzfm(&feed))
            && feeds::xiaoyuzhou_podcast_id(&feed).is_none()
        {
            let conn = state.db.lock().map_err(e)?;
            let hints = db::list_episodes(&conn, Some(&show_id), 40).map_err(e)?;
            'find_pid: for ep in hints {
                for blob in [ep.audio_url.as_deref(), ep.link.as_deref()]
                    .into_iter()
                    .flatten()
                {
                    if let Some(pid) = feeds::xiaoyuzhou_podcast_id(blob) {
                        feed = format!("https://www.xiaoyuzhoufm.com/podcast/{pid}");
                        break 'find_pid;
                    }
                }
            }
        }
        feed
    };
    let resolved = feeds::refresh_with_title(&feed_url, &show.kind, &show.title)
        .await
        .map_err(e)?;
    let before = {
        let conn = state.db.lock().map_err(e)?;
        db::count_episodes(&conn, &show_id).map_err(e)?
    };
    // 空目录同步会误删本地未听单集；小宇宙 HTML 壳失败时宁可报错。
    if resolved.episodes.is_empty() && before > 0 {
        return Err("刷新未拿到单集目录，已保留本地列表".into());
    }
    let mut conn = state.db.lock().map_err(e)?;
    let mut show = resolved.show;
    show.id = show_id.clone();
    db::upsert_show(&conn, &show).map_err(e)?;
    let mut eps = resolved.episodes;
    feeds::rebind_episodes(&mut eps, &show_id);
    // 半量目录只合并，避免把本地已有旧集当孤儿删掉。
    if resolved.catalog_partial {
        db::upsert_episodes(&mut conn, &eps).map_err(e)?;
    } else {
        db::sync_episodes(&mut conn, &show_id, &eps).map_err(e)?;
    }
    let after = db::count_episodes(&conn, &show_id).map_err(e)?;
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
        let episodes =
            db::list_episodes(&conn, Some(&show.id), feeds::LIST_EPISODES_CAP).map_err(e)?;
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
    if resolved.catalog_partial {
        db::upsert_episodes(&mut conn, &resolved.episodes).map_err(e)?;
    } else {
        db::sync_episodes(&mut conn, &show.id, &resolved.episodes).map_err(e)?;
    }
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
    let episodes =
        db::list_episodes(&conn, Some(&show.id), feeds::LIST_EPISODES_CAP).map_err(e)?;
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
        None if ep.transcript_type.as_deref() == Some("podscribe") => {
            if let Some(url) = ep.transcript_url.as_deref() {
                let segs = qiaomu::podscribe_transcript(url).await.map_err(e)?;
                (!segs.is_empty()).then(|| Transcript {
                    episode_id: ep.id.clone(),
                    source: "podscribe".into(),
                    language: "en".into(),
                    segments: captions::resegment(segs),
                })
            } else {
                None
            }
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

/// 合成朗读音频，返回本机缓存路径和时长。
#[tauri::command]
async fn tts_synthesize(
    state: State<'_, AppState>,
    req: speech::TtsRequest,
) -> Res<speech::TtsResult> {
    speech::synthesize(&state.data, req).await.map_err(e)
}

#[tauri::command(async)]
fn tts_system_voices() -> Vec<speech::SystemVoice> {
    speech::list_system_voices()
}

#[tauri::command(async)]
fn clear_tts_cache(state: State<'_, AppState>) -> Res<()> {
    speech::clear_cache(&state.data).map_err(e)
}

#[tauri::command(async)]
fn local_tts_status(state: State<'_, AppState>) -> local_tts::Status {
    local_tts::status(&state.data)
}

#[tauri::command]
async fn local_tts_install(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    mirror_first: bool,
) -> Res<()> {
    let job = format!("local-tts:{id}");
    let _guard = {
        let flag = Arc::new(AtomicBool::new(false));
        let mut jobs = state.jobs.lock().map_err(e)?;
        if jobs.contains_key(&job) {
            return Err("语音模型正在下载".into());
        }
        jobs.insert(job.clone(), flag.clone());
        JobGuard {
            jobs: state.jobs.clone(),
            id: job.clone(),
            flag,
        }
    };
    let cancel = _guard.cancel_flag();
    let result = local_tts::install(&state.data, &id, &cancel, mirror_first, |received, total| {
        let _ = app.emit(
            "local-tts-download",
            serde_json::json!({ "id": id, "received": received, "total": total }),
        );
    })
    .await;
    result.map_err(e)
}

#[tauri::command(async)]
fn local_tts_delete(state: State<'_, AppState>, id: String) -> Res<()> {
    local_tts::delete(&state.data, &id).map_err(e)
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
        audio: load_audio_ref(&state, &episode_id),
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
        net::set_proxy(proxy).map_err(|err| format!("代理设置无效：{err}"))?;
    }
    let conn = state.db.lock().map_err(e)?;
    db::set_setting(&conn, "app", &value).map_err(e)
}

#[tauri::command(async)]
fn set_api_key(provider: String, key: String) -> Res<()> {
    secrets::set_key(&provider, &key).map_err(e)
}

#[tauri::command(async)]
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
    max_tokens: Option<u32>,
    json_mode: Option<bool>,
    quick: Option<bool>,
    job_id: Option<String>,
}

#[tauri::command]
async fn llm_chat(app: AppHandle, state: State<'_, AppState>, req: ChatReq) -> Res<String> {
    let base_url = resolve_saved_base_url(&state, "providers", &req.provider, &req.base_url)?;
    let key = secrets::get_key(&req.provider).map_err(e)?.unwrap_or_default();
    if req.protocol == "anthropic" && key.is_empty() {
        return Err("请先在设置里保存 API Key".to_string());
    }
    let cfg = llm::LlmConfig {
        base_url,
        model: req.model,
        protocol: req.protocol,
        api_key: key,
    };
    let opts = llm::ChatOpts {
        max_tokens: req.max_tokens,
        json_mode: req.json_mode.unwrap_or(false),
        quick: req.quick.unwrap_or(false),
    };
    let guard = req
        .job_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .map(|id| begin_job(&state, id));
    let cancel = guard
        .as_ref()
        .map(|g| g.cancel_flag())
        .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
    if req.stream.unwrap_or(true) {
        let app2 = app.clone();
        let req_id = req.job_id.clone().unwrap_or_default();
        llm::chat_stream_opts(&cfg, &req.messages, &opts, &cancel, move |delta| {
            let _ = app2.emit(
                "llm-delta",
                serde_json::json!({ "requestId": req_id, "delta": delta }),
            );
        })
        .await
        .map_err(e)
    } else {
        llm::chat_once_opts(&cfg, &req.messages, &opts)
            .await
            .map_err(e)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslateReq {
    texts: Vec<String>,
    target: Option<String>,
    engine: Option<String>,
    quality: Option<String>,
    provider: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    protocol: Option<String>,
}

#[tauri::command]
async fn translate_batch(state: State<'_, AppState>, req: TranslateReq) -> Res<Vec<String>> {
    let target = req.target.unwrap_or_else(|| "zh-CN".into());
    let engine = req.engine.unwrap_or_else(|| "google".into());
    let quality = req.quality.unwrap_or_else(|| "fast".into());
    if engine == "llm" {
        let provider = req.provider.ok_or_else(|| "缺少 provider".to_string())?;
        let base_url = resolve_saved_base_url(
            &state,
            "providers",
            &provider,
            req.base_url.as_deref().unwrap_or(""),
        )?;
        let protocol = req.protocol.unwrap_or_else(|| "openai".into());
        let key = secrets::get_key(&provider).map_err(e)?.unwrap_or_default();
        if protocol == "anthropic" && key.is_empty() {
            return Err("请先保存 API Key".to_string());
        }
        let cfg = llm::LlmConfig {
            base_url,
            model: req.model.unwrap_or_default(),
            protocol,
            api_key: key,
        };
        translate::llm_batch_quality(&cfg, &req.texts, &target, &quality)
            .await
            .map_err(e)
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
        let mut pairs: Vec<(String, String)> = Vec::with_capacity(missing.len());
        for (j, &i) in missing.iter().enumerate() {
            if let Some(t) = done.get(j) {
                pairs.push((keys[i].clone(), t.clone()));
                out[i] = Some(t.clone());
            }
        }
        if !pairs.is_empty() {
            let mut conn = state.db.lock().map_err(e)?;
            let _ = db::tr_put_batch(&mut conn, &pairs);
        }
    }
    Ok(out.into_iter().map(Option::unwrap_or_default).collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudAsrReq {
    episode_id: String,
    #[serde(default)]
    audio_url: Option<String>,
    provider: String,
    base_url: String,
    model: String,
    language: Option<String>,
}

/// 统一 ASR 音频选源（本机与云端共用）：
/// - 双形态单集（有 video_id）优先抓 YouTube 音轨，保证视频播放与字幕严格同源；失败且有 audio_url 时再回退播客音频。
/// - 纯播客单集（无 video_id）优先复用 downloads/ → audio-cache/ → 断点 work/，否则下载到 audio-cache/（不污染 downloads/）。
/// 返回 `(音频路径, 是否播客直链音频)`；仅播客直链音频需要生成声纹与 TimeMap::same。
async fn prepare_asr_audio(
    app: &AppHandle,
    state: &AppState,
    ep: &Episode,
    fallback_url: Option<&str>,
    work: &std::path::Path,
    cancel: Arc<AtomicBool>,
) -> Res<(PathBuf, bool)> {
    let emit_dl = |progress: f64, message: &str| {
        let _ = app.emit(
            "asr",
            serde_json::json!({
                "episodeId": ep.id,
                "stage": "download",
                "progress": progress,
                "message": message,
            }),
        );
    };
    let audio_url = ep
        .audio_url
        .as_deref()
        .filter(|u| !u.is_empty())
        .or_else(|| fallback_url.filter(|u| !u.is_empty()));
    let video_id = ep.video_id.as_deref().filter(|v| !v.is_empty());

    emit_dl(0.0, "准备音频…");
    if let Some(vid) = video_id {
        // 纯 YouTube 单集若用户已离线下载，直接复用 downloads/
        if audio_url.is_none() {
            if let Some(saved) = offline::find(&state.data, &ep.id) {
                let p = PathBuf::from(saved.path);
                if p.is_file() {
                    emit_dl(1.0, "使用已下载的音频");
                    return Ok((p, false));
                }
            }
        }
        if crate::ytdlp::find_ytdlp(&state.data).is_none() {
            emit_dl(0.0, "正在准备 YouTube 下载工具…");
        } else {
            emit_dl(0.0, "正在从 YouTube 获取音轨…");
        }
        let app_yt = app.clone();
        let id_yt = ep.id.clone();
        match asr::youtube_audio_with_progress(
            &state.data,
            vid,
            work,
            cancel.clone(),
            move |p| {
                let _ = app_yt.emit(
                    "asr",
                    serde_json::json!({
                        "episodeId": id_yt,
                        "stage": "download",
                        "progress": p,
                        "message": "正在从 YouTube 获取音轨…",
                    }),
                );
            },
        )
        .await
        {
            Ok(got) => return Ok((got, false)),
            Err(yt_err) => {
                if cancel.load(Ordering::Relaxed) || audio_url.is_none() {
                    return Err(e(yt_err));
                }
            }
        }
    }

    if let Some(cached) = asr::find_cached_audio(&state.data, &ep.id) {
        emit_dl(1.0, "使用已下载的音频");
        return Ok((cached, true));
    }

    let Some(url) = audio_url else {
        return Err("这集没有音频地址".into());
    };
    emit_dl(0.0, "正在下载音频…");
    let ext = asr::audio_ext(&shared::canonical_audio_url(url)).to_string();
    let dest_cache = offline::cache_path(&state.data, &ep.id, url);
    let part = dest_cache.with_extension("part");
    let _ = tokio::fs::create_dir_all(offline::cache_dir(&state.data)).await;
    let res = asr::download_audio_url(url, &part, &cancel, |p| {
        emit_dl(p, "正在下载音频…");
    })
    .await;
    if let Err(err) = res {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(e(err));
    }
    match offline::commit_cached(&state.data, &ep.id, &part, &ext) {
        Ok(kept) => Ok((PathBuf::from(kept.path), true)),
        Err(_) => {
            let fallback = work.join(format!("audio.{ext}"));
            let _ = tokio::fs::rename(&part, &fallback).await;
            Ok((fallback, true))
        }
    }
}

/// 识别单个 16kHz 音频分片（云端 OpenAI 兼容接口）；自动适配 Whisper verbose_json 与纯文本模型。
async fn transcribe_cloud_chunk(
    url: &str,
    key: Option<&str>,
    model: &str,
    language: Option<&str>,
    wav_bytes: Vec<u8>,
    offset_sec: f64,
    chunk_dur_sec: f64,
    use_verbose_json: bool,
    omit_language: bool,
) -> anyhow::Result<(Option<String>, Vec<model::Segment>)> {
    let part = reqwest::multipart::Part::bytes(wav_bytes)
        .file_name("chunk.wav")
        .mime_str("audio/wav")?;
    let mut form = reqwest::multipart::Form::new()
        .text("model", model.to_string())
        .part("file", part);
    if use_verbose_json {
        form = form.text("response_format", "verbose_json");
    }
    if !omit_language {
        if let Some(lang) = language.filter(|s| !s.is_empty() && *s != "auto") {
            form = form.text("language", lang.to_string());
        }
    }
    let mut rb = net::client()
        .post(url)
        .timeout(std::time::Duration::from_secs(120))
        .multipart(form);
    if let Some(k) = key.filter(|s| !s.is_empty()) {
        rb = rb.bearer_auth(k);
    }
    let resp = rb.send().await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("识别失败 HTTP {status}: {body}");
    }
    let v: serde_json::Value = resp.json().await?;
    let lang_out = v["language"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let mut segs = Vec::new();
    let chunk_end = offset_sec + chunk_dur_sec;
    for s in v["segments"].as_array().into_iter().flatten() {
        let text = s["text"].as_str().unwrap_or("").trim().to_string();
        if text.is_empty() {
            continue;
        }
        let st = (offset_sec + s["start"].as_f64().unwrap_or(0.0)).max(offset_sec);
        let en = (offset_sec + s["end"].as_f64().unwrap_or(chunk_dur_sec))
            .max(st)
            .min(chunk_end + 0.5);
        segs.push(model::Segment {
            start: st,
            end: en,
            text,
        });
    }
    if segs.is_empty() {
        if let Some(text) = v["text"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
            segs = captions::split_timed(text, offset_sec, chunk_end);
        }
    }
    Ok((lang_out, segs))
}

/// 云端 Whisper 兼容接口（16kHz 单声道分片并发上传，支持播客与 YouTube、取消、进度、声纹对齐）。
#[tauri::command]
async fn cloud_transcribe(
    app: AppHandle,
    state: State<'_, AppState>,
    req: CloudAsrReq,
) -> Res<Transcript> {
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
    let base_url = resolve_saved_base_url(&state, "cloudAsr", &req.provider, &req.base_url)?;
    let key = secrets::get_key(&req.provider).map_err(e)?;
    if key.as_deref().unwrap_or("").is_empty()
        && !req.provider.starts_with("asr.local")
        && req.provider != "local-server"
    {
        return Err("云端识别需要 API Key".into());
    }
    let _guard = begin_job(&state, &req.episode_id);
    let cancel = _guard.cancel_flag();
    let work = state
        .data
        .join("work")
        .join(format!("{}-{}", ep.id, Uuid::new_v4()));
    let _ = tokio::fs::create_dir_all(&work).await;
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
        let (audio, is_podcast_audio) = prepare_asr_audio(
            &app,
            &state,
            &ep,
            req.audio_url.as_deref(),
            &work,
            cancel.clone(),
        )
        .await?;

        emit_asr("transcribe", 0.02, Some("正在解码音频…"));
        let (src, cancel_dec) = (audio.clone(), cancel.clone());
        let (tx, rx) = std::sync::mpsc::channel::<f64>();
        let decode_job = tokio::task::spawn_blocking(move || {
            asr::decode_16k_mono_progressive(src.as_path(), cancel_dec, Some(tx))
        });
        let app_prog = app.clone();
        let ep_prog = ep.id.clone();
        let pump = tokio::task::spawn_blocking(move || {
            while let Ok(p) = rx.recv() {
                let _ = app_prog.emit(
                    "asr",
                    serde_json::json!({
                        "episodeId": ep_prog,
                        "stage": "transcribe",
                        "progress": 0.02 + p * 0.14,
                        "message": "正在解码音频…",
                    }),
                );
            }
        });
        let samples = decode_job.await.map_err(e)?.map_err(e)?;
        let _ = pump.await;
        if samples.is_empty() {
            return Err("音频解码为空".into());
        }

        let endpoint = format!("{}/audio/transcriptions", base_url.trim_end_matches('/'));
        let lower_url = endpoint.to_lowercase();
        let lower_model = req.model.to_lowercase();
        let is_siliconflow = lower_url.contains("siliconflow");
        let is_bigmodel = lower_url.contains("bigmodel.cn");
        let is_local = req.provider.starts_with("asr.local") || req.provider == "local-server";
        // 仅 Whisper 类模型支持 verbose_json；gpt-4o-transcribe / 硅基流动 / GLM 走默认 JSON + 20s 分片摊分时间
        let use_verbose_json = !is_siliconflow && !is_bigmodel && lower_model.contains("whisper");
        let omit_language = is_siliconflow;
        // Whisper verbose_json 用 120s 分片兼顾上下文与速度（约 3.8MB WAV）；纯文本接口用 25s 分片保证时间粒度细腻
        let chunk_secs: usize = if use_verbose_json { 120 } else { 25 };
        let chunk_samples = chunk_secs * 16_000;
        let total_chunks = samples.len().div_ceil(chunk_samples);
        let concurrency = if is_local { 1 } else { 4 };
        let sem = Arc::new(tokio::sync::Semaphore::new(concurrency));
        let done_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let samples = Arc::new(samples);

        emit_asr("transcribe", 0.16, Some("上传并识别…"));
        let mut handles = Vec::with_capacity(total_chunks);
        for idx in 0..total_chunks {
            let sem = sem.clone();
            let cancel_c = cancel.clone();
            let samples_c = samples.clone();
            let endpoint_c = endpoint.clone();
            let key_c = key.clone();
            let model_c = req.model.clone();
            let lang_c = req.language.clone();
            let done_c = done_count.clone();
            let app_c = app.clone();
            let ep_id_c = ep.id.clone();

            handles.push(tokio::spawn(async move {
                let _permit = sem
                    .acquire()
                    .await
                    .map_err(|_| anyhow::anyhow!("任务已取消"))?;
                if cancel_c.load(Ordering::Relaxed) {
                    anyhow::bail!("已取消");
                }
                let start_sample = idx * chunk_samples;
                let end_sample = (start_sample + chunk_samples).min(samples_c.len());
                let slice = &samples_c[start_sample..end_sample];
                let offset_sec = start_sample as f64 / 16_000.0;
                let dur_sec = slice.len() as f64 / 16_000.0;
                // 纯静音分片直接跳过，省费用也避免 Whisper 静音幻觉
                let energy = slice
                    .iter()
                    .step_by(16)
                    .map(|x| x.abs())
                    .fold(0.0f32, f32::max);
                let res = if energy < 0.002 {
                    Ok((None, Vec::new()))
                } else {
                    let wav = asr::encode_wav_bytes(slice);
                    transcribe_cloud_chunk(
                        &endpoint_c,
                        key_c.as_deref(),
                        &model_c,
                        lang_c.as_deref(),
                        wav,
                        offset_sec,
                        dur_sec,
                        use_verbose_json,
                        omit_language,
                    )
                    .await
                };
                let finished = done_c.fetch_add(1, Ordering::Relaxed) + 1;
                let pct = 0.16 + 0.82 * (finished as f64 / total_chunks.max(1) as f64);
                let _ = app_c.emit(
                    "asr",
                    serde_json::json!({
                        "episodeId": ep_id_c,
                        "stage": "transcribe",
                        "progress": pct.min(0.98),
                        "message": "上传并识别…",
                    }),
                );
                res.map(|x| (idx, x))
            }));
        }

        let mut chunk_results = Vec::with_capacity(total_chunks);
        for h in handles {
            let pair = h.await.map_err(e)?.map_err(e)?;
            chunk_results.push(pair);
        }
        chunk_results.sort_by_key(|(idx, _)| *idx);

        let mut detected_lang: Option<String> = None;
        let mut all_segs = Vec::new();
        for (_, (lang_opt, segs)) in chunk_results {
            if detected_lang.is_none() {
                detected_lang = lang_opt;
            }
            all_segs.extend(segs);
        }

        let segments = captions::resegment(captions::clean(all_segs));
        if segments.is_empty() {
            return Err("没有识别出文字（可能是静音或纯音乐）".into());
        }
        let sample_text: String = segments.iter().take(5).map(|s| s.text.as_str()).collect();
        let language = detected_lang
            .or_else(|| req.language.clone().filter(|s| s != "auto"))
            .unwrap_or_else(|| {
                if sample_text
                    .chars()
                    .any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
                {
                    "zh".into()
                } else {
                    "auto".into()
                }
            });
        let t = Transcript {
            episode_id: ep.id.clone(),
            source: "cloud".into(),
            language,
            segments,
        };
        let file_bytes = std::fs::metadata(&audio).map(|m| m.len()).unwrap_or(0);
        let audio_ref = if is_podcast_audio && file_bytes > 0 {
            let audio_for_fp = audio.clone();
            tokio::task::spawn_blocking(move || align::fingerprint_audio(&audio_for_fp))
                .await
                .ok()
                .and_then(|r| r.ok())
                .map(|(secs, fp)| align::AudioRef {
                    bytes: file_bytes,
                    etag: String::new(),
                    secs,
                    fp: Some(align::encode_fp(&fp)),
                    shared_id: None,
                    has_fp: true,
                })
        } else {
            None
        };
        {
            let conn = state.db.lock().map_err(e)?;
            db::save_transcript(&conn, &t).map_err(e)?;
            let meta = serde_json::json!({ "source": "cloud", "model": req.model });
            let _ = db::set_blob(&conn, &ep.id, "asr-meta", &meta.to_string());
            if let Some(ref aref) = audio_ref {
                let _ = db::set_blob(
                    &conn,
                    &ep.id,
                    "audio-ref",
                    &serde_json::to_string(aref).unwrap_or_default(),
                );
                let _ = db::set_blob(
                    &conn,
                    &ep.id,
                    "tmap",
                    &serde_json::to_string(&align::TimeMap::same(file_bytes)).unwrap_or_default(),
                );
            }
        }
        emit_asr("done", 1.0, None);
        Ok((t, audio_ref))
    };

    let result = run.await;
    let _ = tokio::fs::remove_dir_all(&work).await;
    drop(_guard);
    if let (Ok((ref t, ref audio_ref)), false) = (&result, share_keys.is_empty()) {
        let (on, install) = match state.db.lock() {
            Ok(conn) => (
                share_on(&conn) && !is_private_episode(&conn, &ep),
                install_id(&conn),
            ),
            Err(_) => (false, String::new()),
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
                audio: audio_ref.clone(),
            };
            let segs = t.segments.clone();
            tokio::spawn(async move {
                let _ = shared::upload_with(&share_keys, meta, &segs, "google", "").await;
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
    result.map(|(t, _)| t)
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
async fn list_models(state: State<'_, AppState>, req: ListModelsReq) -> Res<Vec<String>> {
    if req.protocol == "anthropic" {
        return Ok(vec![]);
    }
    let base_url = resolve_saved_base_url(&state, "providers", &req.provider, &req.base_url)?;
    let key = secrets::get_key(&req.provider).map_err(e)?.unwrap_or_default();
    let url = format!("{}/models", base_url.trim_end_matches('/'));
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

fn downloads_dir() -> Res<PathBuf> {
    dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "找不到下载文件夹".to_string())
}

/// 文件名只留最后一段，去掉路径分隔与 Windows 非法字符。
fn safe_download_name(name: &str) -> Res<String> {
    let base = std::path::Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim();
    let cleaned: String = base
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned = cleaned.chars().take(120).collect::<String>();
    if cleaned.is_empty() {
        return Err("文件名无效".into());
    }
    Ok(cleaned)
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
    let path = downloads_dir()?.join(format!(
        "Subpodcast-{}.opml",
        chrono::Local::now().format("%Y%m%d")
    ));
    std::fs::write(&path, import::opml(&list)).map_err(e)?;
    Ok(path.to_string_lossy().into())
}

/// 英语学习：截取单句原声 WAV（离线文件 → audio_url Range → YouTube 下载后再截）。
#[tauri::command]
async fn learn_clip(
    state: State<'_, AppState>,
    episode_id: String,
    start: f64,
    end: f64,
) -> Res<String> {
    let data = state.data.clone();
    let done = clip::path_for(&data, &episode_id, start, end);
    if done.exists() {
        return Ok(done.to_string_lossy().into_owned());
    }
    let ep = {
        let conn = state.db.lock().map_err(e)?;
        db::get_episode(&conn, &episode_id)
            .map_err(e)?
            .ok_or_else(|| "节目不存在".to_string())?
    };
    if let Some(saved) = offline::find(&data, &episode_id).or_else(|| offline::find_cached(&data, &episode_id)) {
        let tmap = state
            .db
            .lock()
            .ok()
            .and_then(|conn| db::get_blob(&conn, &episode_id, "tmap").ok().flatten())
            .and_then(|raw| serde_json::from_str::<align::TimeMap>(&raw).ok())
            .filter(|m| m.play_bytes == saved.bytes && !m.pieces.is_empty());
        let (play_start, play_end) = match tmap {
            Some(m) => (m.to_play(start), m.to_play(end)),
            None => (start, end),
        };
        return clip::make(
            &data,
            clip::Source::File(PathBuf::from(saved.path)),
            &episode_id,
            play_start,
            play_end,
        )
        .await
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(e);
    }
    if let Some(url) = ep.audio_url.filter(|u| !u.is_empty()) {
        return clip::make(&data, clip::Source::Url(url), &episode_id, start, end)
            .await
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(e);
    }
    let vid = ep
        .video_id
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "这一集没有音频".to_string())?;
    // Subpodcast 无 youtube_stream_url：用独立临时目录避免同集并发删彼此工作目录。
    let clips_root = data.join("clips");
    tokio::fs::create_dir_all(&clips_root).await.map_err(e)?;
    let tmp = tempfile::Builder::new()
        .prefix(&format!(".yt-{episode_id}-"))
        .tempdir_in(&clips_root)
        .map_err(e)?;
    let work = tmp.path().to_path_buf();
    let cancel = Arc::new(AtomicBool::new(false));
    let file = asr::youtube_audio(&data, &vid, &work, cancel)
        .await
        .map_err(e)?;
    clip::make(
        &data,
        clip::Source::File(file),
        &episode_id,
        start,
        end,
    )
    .await
    .map(|p| p.to_string_lossy().into_owned())
    .map_err(e)
}

/// 英语学习：生词本导出为 Anki .apkg（路径由保存对话框选定）。
#[tauri::command]
async fn export_anki(
    state: State<'_, AppState>,
    path: String,
    deck: String,
    model: String,
    notes: Vec<anki::Note>,
) -> Res<usize> {
    let clips_dir = state.data.join("clips");
    let out = std::path::PathBuf::from(&path);
    if !out
        .extension()
        .and_then(|x| x.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("apkg"))
    {
        return Err("导出文件必须以 .apkg 结尾".into());
    }
    tokio::task::spawn_blocking(move || anki::write(&out, &deck, &model, &notes, &clips_dir))
        .await
        .map_err(e)?
        .map_err(e)
}

/// 英语学习：把文本（如 CSV）写到选定路径（仅允许白名单文本扩展名）。
#[tauri::command]
fn save_text(path: String, text: String) -> Res<()> {
    const ALLOWED_EXTS: &[&str] = &["csv", "txt", "md", "srt", "vtt", "ass", "lrc", "opml", "json"];
    let p = std::path::Path::new(&path);
    let ext_ok = p
        .extension()
        .and_then(|x| x.to_str())
        .is_some_and(|ext| ALLOWED_EXTS.contains(&ext.to_ascii_lowercase().as_str()));
    let hidden = p
        .file_name()
        .and_then(|x| x.to_str())
        .is_some_and(|n| n.starts_with('.'));
    if !ext_ok || hidden {
        return Err("不支持写入该类型的文件".into());
    }
    std::fs::write(p, text).map_err(e)
}

/// 高光切片：FFmpeg 是否就绪、能否硬编。
#[tauri::command(async)]
fn video_clip_env(state: State<'_, AppState>) -> videoclip::FfmpegStatus {
    videoclip::env_status(&state.data)
}

/// 高光切片：后台解析直链、备好 FFmpeg，再预取最可能被剪的几段。
#[tauri::command]
fn video_clip_warm(state: State<'_, AppState>, video_id: String, ranges: Option<Vec<(f64, f64)>>) {
    let data = state.data.clone();
    tauri::async_runtime::spawn(async move {
        videoclip::warm(&data, &video_id, &ranges.unwrap_or_default()).await;
    });
}

/// `video-clip-progress` 事件：{ jobId, stage, progress, message }。
fn clip_progress(app: &AppHandle, job_id: &str) -> impl FnMut(&str, f64, &str) + Send + 'static {
    let (app, job_id) = (app.clone(), job_id.to_string());
    move |stage, progress, message| {
        let _ = app.emit(
            "video-clip-progress",
            serde_json::json!({ "jobId": job_id, "stage": stage, "progress": progress, "message": message }),
        );
    }
}

/// 高光切片：取一段（多段 ranges 时拼成蒙太奇），可 cancel_job(jobId)。
#[tauri::command]
async fn video_clip_prepare(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    video_id: String,
    start: f64,
    end: f64,
    ranges: Option<Vec<(f64, f64)>>,
) -> Res<videoclip::PreparedClip> {
    let guard = begin_job(&state, &job_id);
    let cancel = guard.cancel_flag();
    let data = state.data.clone();
    let report = clip_progress(&app, &job_id);
    let result = match ranges.filter(|r| r.len() > 1) {
        Some(r) => videoclip::prepare_montage(&data, &video_id, &r, &cancel, report).await,
        None => videoclip::prepare_segment(&data, &video_id, start, end, &cancel, report).await,
    };
    result.map_err(e)
}

/// 高光/选区切片：纯音频播客取段（封面/深色底 + 截取音频 → MP4），可 cancel_job(jobId)。
#[tauri::command]
async fn video_clip_prepare_audio(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    episode_id: String,
    start: f64,
    end: f64,
    ranges: Option<Vec<(f64, f64)>>,
) -> Res<videoclip::PreparedClip> {
    let (audio_url, cover_url) = {
        let conn = state.db.lock().map_err(e)?;
        let ep = db::get_episode(&conn, &episode_id)
            .map_err(e)?
            .ok_or_else(|| "单集不存在".to_string())?;
        let audio = ep
            .audio_url
            .filter(|u| !u.trim().is_empty())
            .ok_or_else(|| "当前单集没有可用音频源".to_string())?;
        let cover = ep
            .cover
            .filter(|c| !c.trim().is_empty())
            .or_else(|| {
                db::get_show(&conn, &ep.show_id)
                    .ok()
                    .flatten()
                    .and_then(|s| s.cover)
                    .filter(|c| !c.trim().is_empty())
            });
        (audio, cover)
    };
    let guard = begin_job(&state, &job_id);
    let cancel = guard.cancel_flag();
    let data = state.data.clone();
    let report = clip_progress(&app, &job_id);
    let list = match ranges.filter(|r| r.len() > 1) {
        Some(r) => r,
        None => vec![(start, end)],
    };
    videoclip::prepare_audio_ranges(
        &data,
        &episode_id,
        &audio_url,
        cover_url.as_deref(),
        &list,
        cancel,
        report,
    )
    .await
    .map_err(e)
}

/// 安全获取远程封面图片的 data URL，供摘句海报与切片封面画布无 CORS 污染绘制。
#[tauri::command]
async fn fetch_cover_data_url(url: String) -> Res<Option<String>> {
    Ok(videoclip::fetch_image_data_url(&url).await)
}

/// SQLite 跨连接写版本号：CLI / MCP 改库后桌面端窗口聚焦时据此自动刷新。
#[tauri::command]
fn db_data_version(state: State<'_, AppState>) -> Res<i64> {
    let conn = state.db.lock().map_err(e)?;
    db::data_version(&conn).map_err(e)
}

/// 检查随应用附带的 `subpodcast-cli` 安装状态与 PATH 可达性。
#[tauri::command]
fn cli_status() -> cli_install::CliStatus {
    cli_install::inspect()
}

/// 将 `subpodcast-cli` 软链为 `subpodcast` 命令（/usr/local/bin 或 ~/.local/bin）。
#[tauri::command]
fn cli_install() -> Res<cli_install::CliStatus> {
    cli_install::install().map_err(e)
}

/// 探测本机已安装的外部 AI 工具（Claude Code / Claude Desktop / Codex / Cursor / Antigravity 等）及其 MCP 连接态。
#[tauri::command]
fn mcp_agents_detect() -> Vec<mcp_connect::AgentClientInfo> {
    mcp_connect::detect_clients()
}

/// 一键自动安装 CLI 软链并将 `subpodcast mcp` 写入所选本机 AI 工具的 MCP 配置。
#[tauri::command]
fn mcp_agents_connect(ids: Vec<String>) -> Res<Vec<mcp_connect::AgentClientInfo>> {
    mcp_connect::connect_clients(&ids).map_err(e)
}

/// 从指定本机 AI 工具的配置中移除 `subpodcast` MCP 条目（保留其他配置）。
#[tauri::command]
fn mcp_agent_disconnect(id: String) -> Res<Vec<mcp_connect::AgentClientInfo>> {
    mcp_connect::disconnect_client(&id).map_err(e)
}

/// 高光切片：叠字幕 / 标题 / 封面并导出 MP4，可 cancel_job(jobId)。
#[tauri::command]
async fn video_clip_render(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    req: videoclip::RenderRequest,
) -> Res<videoclip::RenderResult> {
    let guard = begin_job(&state, &job_id);
    let cancel = guard.cancel_flag();
    let data = state.data.clone();
    let result = videoclip::render(&data, req, &cancel, clip_progress(&app, &job_id)).await;
    result.map_err(e)
}

/// 在访达 / 资源管理器里打开路径：普通目录直接打开，文件或 macOS Bundle（.app/.pkg 等）仅选中不启动。
#[tauri::command]
fn reveal_file(app: AppHandle, path: String) -> Res<()> {
    use tauri_plugin_opener::OpenerExt;
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("找不到这个文件或文件夹".into());
    }
    const BUNDLE_EXTS: &[&str] = &["app", "pkg", "dmg", "command", "workflow", "action", "prefpane", "kext"];
    let is_bundle = p
        .extension()
        .and_then(|x| x.to_str())
        .is_some_and(|ext| BUNDLE_EXTS.contains(&ext.to_ascii_lowercase().as_str()));
    if p.is_dir() && !is_bundle {
        app.opener().open_path(path, None::<&str>).map_err(e)
    } else {
        app.opener().reveal_item_in_dir(&path).map_err(e)
    }
}

/// 本地路径是否仍在（高光「已导出」复用前校验；限定在应用数据 / 下载 / 导出目录内）。
#[tauri::command]
fn file_exists(state: State<'_, AppState>, path: String) -> bool {
    if path.is_empty() {
        return false;
    }
    let Ok(canon) = std::fs::canonicalize(&path) else {
        return false;
    };
    if !canon.is_file() {
        return false;
    }
    let mut allowed: Vec<PathBuf> = vec![state.data.clone()];
    if let Ok(dl) = downloads_dir() {
        allowed.push(dl);
    }
    if let Ok(conn) = state.db.lock() {
        if let Some(dir) = db::get_setting(&conn, "app")
            .ok()
            .flatten()
            .and_then(|r| serde_json::from_str::<serde_json::Value>(&r).ok())
            .and_then(|v| v.get("clipExportDir")?.as_str().map(PathBuf::from))
            .filter(|p| !p.as_os_str().is_empty())
        {
            allowed.push(dir);
        }
    }
    allowed
        .into_iter()
        .filter_map(|r| std::fs::canonicalize(r).ok())
        .any(|root| canon.starts_with(&root))
}

/// 写入系统剪贴板。WebView 在 await 后常丢 user activation，前端 Clipboard API 会 NotAllowedError。
#[tauri::command]
fn clipboard_write(text: String) -> Res<()> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|err| format!("写入剪贴板失败：{err}"))
}

/// 把文本或 base64 二进制写到系统「下载」；字幕 MD/PDF 与其它导出共用。
#[tauri::command]
fn save_download(name: String, data: String, binary: bool) -> Res<String> {
    const ALLOWED_EXTS: &[&str] = &[
        "srt", "vtt", "ass", "lrc", "txt", "md", "pdf", "csv", "json", "opml", "png", "jpg", "jpeg",
    ];
    let name = safe_download_name(&name)?;
    let ext_ok = std::path::Path::new(&name)
        .extension()
        .and_then(|x| x.to_str())
        .is_some_and(|ext| ALLOWED_EXTS.contains(&ext.to_ascii_lowercase().as_str()));
    if !ext_ok {
        return Err("不支持保存该类型的文件".into());
    }
    let dir = downloads_dir()?;
    let mut path = dir.join(&name);
    if path.exists() {
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("export")
            .to_string();
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("txt")
            .to_string();
        for idx in 1..1000u32 {
            let cand = dir.join(format!("{stem} ({idx}).{ext}"));
            if !cand.exists() {
                path = cand;
                break;
            }
        }
    }
    if binary {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let bytes = STANDARD
            .decode(data.trim())
            .map_err(|_| "文件内容无效".to_string())?;
        std::fs::write(&path, bytes).map_err(e)?;
    } else {
        std::fs::write(&path, data).map_err(e)?;
    }
    Ok(path.to_string_lossy().into())
}

fn dir_bytes(path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let Ok(rd) = std::fs::read_dir(path) else {
        return 0;
    };
    for ent in rd.flatten() {
        if let Ok(m) = ent.metadata() {
            if m.is_dir() {
                total = total.saturating_add(dir_bytes(&ent.path()));
            } else if m.is_file() {
                total = total.saturating_add(m.len());
            }
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
        "models": dir_bytes(&asr::models_dir(d)),
        "library": library,
        "temp": dir_bytes(&d.join("work")),
        "ttsCache": dir_bytes(&speech::cache_dir(d)),
        "ttsModels": dir_bytes(&local_tts::models_dir(d)),
        "audioCache": dir_bytes(&offline::cache_dir(d)),
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
    let _guard = begin_job(&state, &job);
    let cancel = _guard.cancel_flag();
    let data = state.data.clone();
    let id = episode_id.clone();
    let result = offline::download(&data, &ep, cancel, |p| {
        let _ = app.emit(
            "offline",
            serde_json::json!({ "episodeId": id, "progress": p }),
        );
    })
    .await;
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
fn clear_downloads(state: State<'_, AppState>) -> Res<()> {
    offline::clear(&state.data).map_err(e)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlignedResp {
    /// same | aligned | unknown | failed
    status: &'static str,
    map: Option<align::TimeMap>,
    path: Option<String>,
    local_bytes: u64,
}

/// 将单集字幕与当前播放音频对齐：
/// 1) 字节数一致直接返回 same；
/// 2) 有参考声纹（本机或共享库）则自动下载到 audio-cache 并做声纹分段对齐；
/// 3) 无参考声纹（YouTube 字幕播 RSS 音频 / 旧共享字幕 / Podscribe）且 `force=true` 时，用本机 ASR 做语音探针对齐。
#[tauri::command]
async fn align_audio(
    app: AppHandle,
    state: State<'_, AppState>,
    episode_id: String,
    force: bool,
    model: Option<String>,
) -> Res<AlignedResp> {
    let (ep, aref, saved_map) = {
        let conn = state.db.lock().map_err(e)?;
        let ep = db::get_episode(&conn, &episode_id)
            .map_err(e)?
            .ok_or_else(|| "单集不存在".to_string())?;
        let aref = db::get_blob(&conn, &episode_id, "audio-ref")
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str::<align::AudioRef>(&s).ok());
        let saved = db::get_blob(&conn, &episode_id, "tmap")
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str::<align::TimeMap>(&s).ok());
        (ep, aref, saved)
    };
    let local = offline::find(&state.data, &episode_id)
        .or_else(|| offline::find_cached(&state.data, &episode_id));
    let local_bytes = local.as_ref().map(|l| l.bytes).unwrap_or(0);
    let reply_none = |status: &'static str| {
        Ok(AlignedResp {
            status,
            map: None,
            path: None,
            local_bytes,
        })
    };

    let Some(audio_url) = ep.audio_url.clone().filter(|u| !u.is_empty()) else {
        return reply_none("same");
    };

    if !force {
        if let Some(m) = saved_map {
            let fits = m.play_bytes == local_bytes || (m.method == "same" && local.is_none());
            if fits && m.method == "same" {
                return reply_none("same");
            }
            if fits && m.method == "manual" && m.pieces.is_empty() {
                return reply_none("unknown");
            }
            if fits && m.method != "same" {
                return Ok(AlignedResp {
                    status: "aligned",
                    map: Some(m),
                    path: local.map(|l| l.path),
                    local_bytes,
                });
            }
        }
    }

    let has_fp = aref.as_ref().is_some_and(|a| a.fp.is_some() || a.has_fp);
    if !has_fp && !force {
        return reply_none("unknown");
    }

    let job_key = format!("al:{episode_id}");
    {
        let jobs = state.jobs.lock().map_err(e)?;
        if jobs.contains_key(&job_key) {
            return reply_none("unknown");
        }
    }
    let _guard = begin_job(&state, &job_key);
    let cancel = _guard.cancel_flag();

    let save_map = |m: &align::TimeMap| {
        if let Ok(conn) = state.db.lock() {
            let _ = db::set_blob(
                &conn,
                &episode_id,
                "tmap",
                &serde_json::to_string(m).unwrap_or_default(),
            );
        }
    };

    if let Some(ref a) = aref {
        let current_bytes = match &local {
            Some(l) => Some(l.bytes),
            None => align::fetch_remote_meta(&audio_url).await.map(|x| x.0),
        };
        if current_bytes == Some(a.bytes) && !force {
            save_map(&align::TimeMap::same(a.bytes));
            return reply_none("same");
        }
    }

    let path = match &local {
        Some(l) => PathBuf::from(&l.path),
        None => {
            let dest = offline::cache_path(&state.data, &episode_id, &audio_url);
            let ext = dest
                .extension()
                .and_then(|x| x.to_str())
                .unwrap_or("mp3")
                .to_string();
            let part = dest.with_extension("part");
            let _ = tokio::fs::create_dir_all(offline::cache_dir(&state.data)).await;
            let (app_dl, id_dl) = (app.clone(), episode_id.clone());
            asr::download_audio_url(&audio_url, &part, &cancel, move |pct| {
                let _ = app_dl.emit(
                    "align",
                    serde_json::json!({ "episodeId": id_dl, "progress": pct }),
                );
            })
            .await
            .map_err(e)?;
            let kept = offline::commit_cached(&state.data, &episode_id, &part, &ext).map_err(e)?;
            PathBuf::from(kept.path)
        }
    };
    let _ = app.emit(
        "align",
        serde_json::json!({ "episodeId": episode_id, "progress": null }),
    );
    let file_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let path_for_fp = path.clone();
    let (secs, play_fp) = tokio::task::spawn_blocking(move || align::fingerprint_audio(&path_for_fp))
        .await
        .map_err(e)?
        .map_err(e)?;

    let (pieces, method) = if let Some(mut a) = aref.clone().filter(|_| has_fp) {
        let ref_fp = match a.fp.as_deref().and_then(align::decode_fp) {
            Some(fp) => fp,
            None => {
                let sid = a.shared_id.as_deref().unwrap_or("");
                let fp = shared::fetch_fingerprint(sid)
                    .await
                    .ok_or_else(|| "没有拿到字幕对应音频的声纹".to_string())?;
                a.fp = Some(align::encode_fp(&fp));
                if let Ok(conn) = state.db.lock() {
                    let _ = db::set_blob(
                        &conn,
                        &episode_id,
                        "audio-ref",
                        &serde_json::to_string(&a).unwrap_or_default(),
                    );
                }
                fp
            }
        };
        (align::match_fingerprints(&ref_fp, &play_fp), "fingerprint")
    } else {
        let transcript = {
            let conn = state.db.lock().map_err(e)?;
            db::load_transcript(&conn, &episode_id)
                .map_err(e)?
                .ok_or_else(|| "这集还没有字幕".to_string())?
        };
        let picked_model = model
            .as_deref()
            .filter(|m| !m.is_empty())
            .and_then(|m| asr::resolve(&state.data, m).filter(|r| r.path.is_file()))
            .or_else(|| {
                asr::MODELS
                    .iter()
                    .find_map(|m| asr::resolve(&state.data, m.id).filter(|r| r.path.is_file()))
            })
            .ok_or_else(|| "请先在「设置 › 字幕」里下载任意一个本机识别模型，才能自动比对对齐".to_string())?;

        let mut anchors: Vec<(f64, f64)> = Vec::new();
        let stride = if secs > 3600.0 { 180.0 } else { 120.0 };
        let mut starts = align::initial_probe_points(secs, stride);
        for _round in 0..2 {
            if starts.is_empty() {
                break;
            }
            let heard = transcribe_probe_slices(
                &state,
                &path,
                &starts,
                &picked_model,
                &transcript.language,
                cancel.clone(),
            )
            .await?;
            anchors.extend(align::locate_probes(&transcript.segments, &heard, &starts));
            starts = align::refinement_probe_points(&anchors);
        }
        (align::build_pieces_from_anchors(&anchors), "probe")
    };

    let shared_secs: f64 = pieces.iter().map(|p| p.ref_end - p.ref_start).sum();
    if pieces.is_empty() || (method == "fingerprint" && shared_secs < secs / 3.0) {
        return Ok(AlignedResp {
            status: "failed",
            map: None,
            path: Some(path.to_string_lossy().into_owned()),
            local_bytes: file_bytes,
        });
    }
    let map = align::TimeMap {
        play_bytes: file_bytes,
        method: method.into(),
        pieces,
    };
    save_map(&map);
    Ok(AlignedResp {
        status: "aligned",
        map: Some(map),
        path: Some(path.to_string_lossy().into_owned()),
        local_bytes: file_bytes,
    })
}

async fn transcribe_probe_slices(
    state: &AppState,
    audio_path: &std::path::Path,
    starts: &[f64],
    model: &asr::Resolved,
    language: &str,
    cancel: Arc<AtomicBool>,
) -> Res<Vec<model::Segment>> {
    let work = state
        .data
        .join("work")
        .join(format!("align-{}", Uuid::new_v4().simple()));
    tokio::fs::create_dir_all(&work).await.map_err(e)?;
    let wav = work.join("probes.wav");
    let (src_path, starts_vec, wav_out) = (audio_path.to_path_buf(), starts.to_vec(), wav.clone());
    let build_res = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let ext = src_path
            .extension()
            .and_then(|x| x.to_str())
            .map(str::to_string);
        let slot_samples = (align::SLOT_LEN_SECS * 16000.0) as usize;
        let mut combined: Vec<f32> = Vec::with_capacity(slot_samples * starts_vec.len());
        for s in starts_vec {
            let file = std::fs::File::open(&src_path)?;
            let mut slice = clip::extract_raw(
                Box::new(file),
                ext.as_deref(),
                s,
                s + align::PROBE_LEN_SECS,
            )
            .unwrap_or_default();
            slice.resize(slot_samples, 0.0);
            combined.extend(slice);
        }
        asr::write_wav(&wav_out, &combined)
    })
    .await
    .map_err(e)?;

    let lang = if language.is_empty() || language == "und" {
        "auto"
    } else {
        language
    };

    let heard = match build_res {
        Err(err) => Err(e(err)),
        Ok(()) if model.engine == "qwen3" => {
            let bin = match asr::find_crispasr(&state.data) {
                Some(b) => Ok(b),
                None => asr::ensure_crispasr(&state.data, &cancel, |_, _| {})
                    .await
                    .map_err(e),
            };
            match bin {
                Ok(b) => asr::run_crispasr(&b, &model.path, &wav, lang, cancel, |_| {})
                    .await
                    .map_err(e),
                Err(err) => Err(err),
            }
        }
        Ok(()) => asr::run_whisper_worker(&wav, &model.path, lang, cancel, |_| {})
            .await
            .map(|r| r.segments)
            .map_err(e),
    };
    let _ = tokio::fs::remove_dir_all(&work).await;
    heard
}

#[tauri::command]
fn save_time_map(state: State<'_, AppState>, episode_id: String, map: align::TimeMap) -> Res<()> {
    let conn = state.db.lock().map_err(e)?;
    let raw = serde_json::to_string(&map).map_err(e)?;
    db::set_blob(&conn, &episode_id, "tmap", &raw).map_err(e)
}

#[tauri::command]
fn list_audio_cache(state: State<'_, AppState>) -> Vec<offline::Saved> {
    offline::list_cached(&state.data)
}

#[tauri::command]
fn clear_audio_cache(state: State<'_, AppState>) -> Res<()> {
    offline::clear_cached(&state.data).map_err(e)
}

#[tauri::command]
fn open_data_folder(app: AppHandle, state: State<'_, AppState>, kind: String) -> Res<()> {
    use tauri_plugin_opener::OpenerExt;
    let dir = match kind.as_str() {
        "downloads" => offline::dir(&state.data),
        "audio-cache" => offline::cache_dir(&state.data),
        "models" => asr::models_dir(&state.data),
        "tts-cache" => speech::cache_dir(&state.data),
        "tts-models" => local_tts::models_dir(&state.data),
        _ => state.data.clone(),
    };
    std::fs::create_dir_all(&dir).map_err(e)?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(e)
}

#[tauri::command(async)]
fn clear_temp(state: State<'_, AppState>) -> Res<()> {
    if let Ok(jobs) = state.jobs.lock() {
        if !jobs.is_empty() {
            return Err("有正在进行的识别或剪辑任务，请等待完成或取消后再清理临时文件".into());
        }
    }
    let dir = state.data.join("work");
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(e)?;
    }
    Ok(())
}

fn begin_job(state: &AppState, id: &str) -> JobGuard {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut jobs) = state.jobs.lock() {
        if let Some(old) = jobs.insert(id.to_string(), flag.clone()) {
            old.store(true, Ordering::Relaxed);
        }
    }
    JobGuard {
        jobs: state.jobs.clone(),
        id: id.to_string(),
        flag,
    }
}

#[tauri::command(async)]
fn asr_models(state: State<'_, AppState>) -> Res<Vec<asr::ModelInfo>> {
    Ok(asr::list_models(&state.data))
}

#[tauri::command(async)]
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
    let _guard = begin_job(&state, &job);
    let cancel = _guard.cancel_flag();
    let data = state.data.clone();
    let mirror = mirror_first.unwrap_or(true);
    let result = asr::download_model(&data, &id, &cancel, mirror, |received, total| {
        let _ = app.emit(
            "model-download",
            serde_json::json!({ "id": id, "received": received, "total": total }),
        );
    })
    .await;
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
    let _guard = begin_job(&state, &req.episode_id);
    let cancel = _guard.cancel_flag();
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
        // 统一选源：双形态优先 YouTube（视频同源），纯播客优先本地缓存并落入 audio-cache/（不污染 downloads/）
        let _ = tokio::fs::create_dir_all(&work).await;
        let (audio, is_podcast_audio) =
            prepare_asr_audio(&app, &state, &ep, None, &work, cancel.clone()).await?;

        let (language_out, segments) = if resolved.engine == "qwen3" {
            let bin = match asr::find_crispasr(&state.data) {
                Some(p) => p,
                None => {
                    emit_asr("download", 0.0, Some("正在准备 Qwen3-ASR 识别程序…"));
                    asr::ensure_crispasr(&state.data, &cancel, |got, total| {
                        let p = total.map(|t| got as f64 / t.max(1) as f64).unwrap_or(0.0);
                        emit_asr("download", p, Some("正在准备 Qwen3-ASR 识别程序…"));
                    })
                    .await
                    .map_err(e)?
                }
            };
            emit_asr("transcribe", 0.02, Some("正在解码音频…"));
            let wav = work.join("audio16k.wav");
            let (src, wav2, cancel_dec) = (audio.clone(), wav.clone(), cancel.clone());
            let (tx, rx) = std::sync::mpsc::channel::<f64>();
            let decode_job = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                let samples =
                    asr::decode_16k_mono_progressive(src.as_path(), cancel_dec, Some(tx))?;
                asr::write_wav(&wav2, &samples)
            });
            // 阻塞频道用 spawn_blocking 轮询，避免卡住 async runtime
            let app_prog = app.clone();
            let ep_prog = ep.id.clone();
            let pump = tokio::task::spawn_blocking(move || {
                while let Ok(p) = rx.recv() {
                    let _ = app_prog.emit(
                        "asr",
                        serde_json::json!({
                            "episodeId": ep_prog,
                            "stage": "transcribe",
                            "progress": 0.02 + p * 0.16,
                            "message": "正在解码音频…",
                        }),
                    );
                }
            });
            decode_job.await.map_err(e)?.map_err(e)?;
            let _ = pump.await;
            emit_asr("transcribe", 0.18, Some("识别中…"));
            let segs = asr::run_crispasr(
                &bin,
                &resolved.path,
                &wav,
                &language,
                cancel.clone(),
                |p| emit_asr("transcribe", 0.18 + p * 0.82, Some("识别中…")),
            )
            .await
            .map_err(e)?;
            let sample: String = segs.iter().take(5).map(|s| s.text.as_str()).collect();
            let lang = if language != "auto" {
                language.clone()
            } else if sample.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)) {
                "zh".into()
            } else {
                "auto".into()
            };
            (lang, segs)
        } else {
            emit_asr("transcribe", 0.01, Some("识别中…"));
            let result = asr::run_whisper_worker(
                &audio,
                &resolved.path,
                &language,
                cancel.clone(),
                |ev| match ev {
                    asr::WorkerEvent::Progress(p) => emit_asr("transcribe", p, Some("识别中…")),
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
        let file_bytes = std::fs::metadata(&audio).map(|m| m.len()).unwrap_or(0);
        let audio_ref = if is_podcast_audio && file_bytes > 0 {
            let audio_for_fp = audio.clone();
            tokio::task::spawn_blocking(move || align::fingerprint_audio(&audio_for_fp))
                .await
                .ok()
                .and_then(|r| r.ok())
                .map(|(secs, fp)| align::AudioRef {
                    bytes: file_bytes,
                    etag: String::new(),
                    secs,
                    fp: Some(align::encode_fp(&fp)),
                    shared_id: None,
                    has_fp: true,
                })
        } else {
            None
        };
        {
            let conn = state.db.lock().map_err(e)?;
            db::save_transcript(&conn, &t).map_err(e)?;
            let meta = serde_json::json!({ "source": source, "model": req.model });
            let _ = db::set_blob(&conn, &ep.id, "asr-meta", &meta.to_string());
            if let Some(ref aref) = audio_ref {
                let _ = db::set_blob(
                    &conn,
                    &ep.id,
                    "audio-ref",
                    &serde_json::to_string(aref).unwrap_or_default(),
                );
                let _ = db::set_blob(
                    &conn,
                    &ep.id,
                    "tmap",
                    &serde_json::to_string(&align::TimeMap::same(file_bytes)).unwrap_or_default(),
                );
            }
        }
        emit_asr("done", 1.0, None);
        Ok((t, audio_ref))
    };

    let result = run.await;
    let _ = tokio::fs::remove_dir_all(&work).await;
    drop(_guard);
    if let (Ok((ref t, ref audio_ref)), false) = (&result, share_keys.is_empty()) {
        let (on, install) = match state.db.lock() {
            Ok(conn) => (share_on(&conn) && !is_private_episode(&conn, &ep), install_id(&conn)),
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
                audio: audio_ref.clone(),
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
    result.map(|(t, _)| t)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--asr-worker") {
        std::process::exit(asr::worker_main(&args[2..]));
    }

    let dir = data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let db_path = dir.join(db::DB_FILE);
    let conn = db::open(&db_path).expect("open db");
    // 无论有无设置都初始化：留空 → 直连（禁用 reqwest 幽灵 system-proxy）
    let startup_proxy = db::get_setting(&conn, "app")
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("proxy").and_then(|x| x.as_str()).map(str::to_string));
    let _ = net::set_proxy(startup_proxy);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            db: Mutex::new(conn),
            data: dir,
            jobs: Arc::new(Mutex::new(HashMap::new())),
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
            tts_synthesize,
            tts_system_voices,
            clear_tts_cache,
            local_tts_status,
            local_tts_install,
            local_tts_delete,
            get_blob,
            set_blob,
            qiaomu_detail,
            download_episode,
            list_downloads,
            delete_download,
            clear_downloads,
            align_audio,
            save_time_map,
            list_audio_cache,
            clear_audio_cache,
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
            save_download,
            storage_info,
            open_data_folder,
            clear_temp,
            log_listen,
            listening_stats,
            preview_show,
            cached_show,
            learn_clip,
            export_anki,
            save_text,
            video_clip_env,
            video_clip_warm,
            video_clip_prepare,
            video_clip_prepare_audio,
            video_clip_render,
            fetch_cover_data_url,
            db_data_version,
            cli_status,
            cli_install,
            mcp_agents_detect,
            mcp_agents_connect,
            mcp_agent_disconnect,
            reveal_file,
            file_exists,
            clipboard_write,
        ])
        .setup(|app| {
            // 开发：Vite；发行：http://localhost（YouTube 拒绝 tauri://）
            #[cfg(debug_assertions)]
            let url = tauri::WebviewUrl::App("index.html".into());
            #[cfg(not(debug_assertions))]
            let url = {
                let port = ui::serve_bundled_ui(app.handle())?;
                tauri::WebviewUrl::External(
                    format!("http://localhost:{port}")
                        .parse()
                        .expect("localhost url"),
                )
            };
            let builder = tauri::WebviewWindowBuilder::new(app, "main", url)
                .title("Subpodcast · 声译")
                .inner_size(1280.0, 840.0)
                .min_inner_size(960.0, 640.0);
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            builder.build()?;
            tauri::async_runtime::spawn_blocking(cli_install::ensure_synced);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Subpodcast");
}
