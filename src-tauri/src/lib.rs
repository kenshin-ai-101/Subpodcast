/**
 * [INPUT]: 聚合 db/feeds/captions/translate/llm/secrets/net
 * [OUTPUT]: Tauri invoke 命令面与应用启动
 * [POS]: Rust 侧总控；新命令需同步 build.rs COMMANDS 与 capabilities
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
mod captions;
mod db;
mod feeds;
mod import;
mod llm;
mod model;
mod net;
mod qiaomu;
mod secrets;
mod translate;
mod ytdlp;

use model::{Episode, Show, Transcript};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

struct AppState {
    db: Mutex<rusqlite::Connection>,
    /// 应用数据目录（yt-dlp、本机 ASR 二期）
    data: PathBuf,
}

type Res<T> = Result<T, String>;
fn e(err: impl ToString) -> String {
    err.to_string()
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
    db::upsert_episodes(&mut conn, &resolved.episodes).map_err(e)?;
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
    db::upsert_episodes(&mut conn, &eps).map_err(e)?;
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

#[tauri::command]
async fn fetch_official_transcript(state: State<'_, AppState>, episode_id: String) -> Res<Option<Transcript>> {
    let ep = {
        let conn = state.db.lock().map_err(e)?;
        db::get_episode(&conn, &episode_id).map_err(e)?.ok_or_else(|| "单集不存在".to_string())?
    };

    let t = if let Some(vid) = &ep.video_id {
        let tracks = captions::youtube_tracks(vid).await.map_err(e)?;
        let Some(track) = captions::choose_track(&tracks, Some("en")) else {
            return Ok(None);
        };
        let segs = captions::fetch_track(track).await.map_err(e)?;
        if segs.is_empty() {
            return Ok(None);
        }
        Some(Transcript {
            episode_id: ep.id.clone(),
            source: if track.auto { "youtube-auto".into() } else { "youtube".into() },
            language: track.language.clone(),
            segments: segs,
        })
    } else if let Some(url) = &ep.transcript_url {
        let kind = ep.transcript_type.clone().unwrap_or_default();
        let segs = captions::fetch_rss_transcript(url, &kind).await.map_err(e)?;
        if segs.is_empty() {
            None
        } else {
            Some(Transcript {
                episode_id: ep.id.clone(),
                source: "rss".into(),
                language: "auto".into(),
                segments: segs,
            })
        }
    } else {
        None
    };

    if let Some(ref transcript) = t {
        let conn = state.db.lock().map_err(e)?;
        db::save_transcript(&conn, transcript).map_err(e)?;
    }
    Ok(t)
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

/// MVP：云端 Whisper 兼容接口（OpenAI /audio/transcriptions）。本机 ASR 留待二期。
#[tauri::command]
async fn cloud_transcribe(state: State<'_, AppState>, req: CloudAsrReq) -> Res<Transcript> {
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
        episode_id: req.episode_id,
        source: "cloud".into(),
        language: v["language"].as_str().unwrap_or("auto").into(),
        segments,
    };
    let conn = state.db.lock().map_err(e)?;
    db::save_transcript(&conn, &t).map_err(e)?;
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
        "downloads": dir_bytes(&d.join("downloads")),
        "models": dir_bytes(&d.join("models")),
        "library": library,
        "temp": dir_bytes(&d.join("work")),
    })
}

#[tauri::command]
fn open_data_folder(app: AppHandle, state: State<'_, AppState>, kind: String) -> Res<()> {
    use tauri_plugin_opener::OpenerExt;
    let dir = match kind.as_str() {
        "downloads" => state.data.join("downloads"),
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        })
        .invoke_handler(tauri::generate_handler![
            add_subscription,
            refresh_show,
            refresh_all,
            list_shows,
            list_episodes,
            get_episode,
            remove_show,
            set_progress,
            search_podcasts,
            youtube_subscriptions,
            open_privacy_settings,
            load_transcript,
            fetch_official_transcript,
            get_blob,
            set_blob,
            get_settings,
            set_settings,
            set_api_key,
            has_api_key,
            llm_chat,
            translate_batch,
            cloud_transcribe,
            list_models,
            export_opml,
            storage_info,
            open_data_folder,
            clear_temp,
        ])
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title("Subpodcast · 声译");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Subpodcast");
}
