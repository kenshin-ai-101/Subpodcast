/**
 * [INPUT]: db / feeds / captions / qiaomu / shared / asr / translate / llm / secrets / net / offline / videoclip
 * [OUTPUT]: McpCtx / run_stdio_mcp / run_doctor / list_shows_json / list_episodes_json — 声译 MCP Server 与核心无头命令
 * [POS]: 供 `subpodcast-cli`（`subpodcast mcp`）调用；协议 MCP 2024-11-05 over stdio JSON-RPC 2.0，支持 progressToken 进度通知
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use crate::{
    asr, captions, db, feeds, llm,
    model::{Episode, Segment, Show, Transcript},
    net, offline, qiaomu, secrets, shared, translate, videoclip,
};
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

mod poster;
mod vocabulary;

pub struct McpCtx {
    pub data: PathBuf,
    pub db: Mutex<rusqlite::Connection>,
}

impl McpCtx {
    pub fn open(data_override: Option<PathBuf>, proxy_override: Option<String>) -> Result<Self> {
        let data = data_override
            .or_else(|| std::env::var_os("SUBPODCAST_DATA_DIR").map(PathBuf::from))
            .unwrap_or_else(|| {
                dirs::data_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join("Subpodcast")
            });
        std::fs::create_dir_all(&data)?;
        let conn = db::open(&data.join(db::DB_FILE))?;
        // 读取设置中的代理（环境变量 / 命令行显式参数优先）
        let saved_proxy = db::get_setting(&conn, "app")
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v["proxy"].as_str().map(str::to_string));
        let env_proxy = std::env::var("SUBPODCAST_PROXY").ok();
        if let Some(p) = proxy_override.or(env_proxy).or(saved_proxy) {
            let trimmed = p.trim().to_string();
            let _ = net::set_proxy((!trimmed.is_empty()).then_some(trimmed));
        }
        Ok(Self {
            data,
            db: Mutex::new(conn),
        })
    }

    fn app_settings(&self) -> Value {
        self.db
            .lock()
            .ok()
            .and_then(|c| db::get_setting(&c, "app").ok().flatten())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| json!({}))
    }
}

/// 线程安全的 JSON-RPC stdout 写入器，保证响应与 `notifications/progress` 不交错。
#[derive(Clone)]
struct RpcOut {
    out: Arc<Mutex<io::Stdout>>,
}

impl RpcOut {
    fn new() -> Self {
        Self {
            out: Arc::new(Mutex::new(io::stdout())),
        }
    }

    fn send(&self, msg: &Value) -> io::Result<()> {
        let mut guard = self.out.lock().unwrap_or_else(|e| e.into_inner());
        writeln!(guard, "{msg}")?;
        guard.flush()
    }

    fn progress(&self, token: Option<&Value>, progress: f64, total: f64, message: &str) {
        let Some(tok) = token else { return };
        let notif = json!({
            "jsonrpc": "2.0",
            "method": "notifications/progress",
            "params": {
                "progressToken": tok,
                "progress": progress,
                "total": total,
                "message": message
            }
        });
        let _ = self.send(&notif);
    }
}

// ============================================================================
// 时间戳与字幕格式化
// ============================================================================

pub fn parse_timestamp(raw: &str) -> Result<f64> {
    let s = raw.trim();
    if s.is_empty() {
        bail!("时间参数不能为空");
    }
    if let Ok(sec) = s.parse::<f64>() {
        if sec.is_finite() && sec >= 0.0 {
            return Ok(sec);
        }
    }
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() == 2 || parts.len() == 3 {
        let mut total = 0.0f64;
        for part in parts {
            let v: f64 = part.trim().parse().map_err(|_| anyhow!("无法解析时间：{raw}"))?;
            if !v.is_finite() || v < 0.0 {
                bail!("时间不能为负：{raw}");
            }
            total = total * 60.0 + v;
        }
        return Ok(total);
    }
    bail!("无法解析时间格式（支持秒数或 mm:ss / hh:mm:ss）：{raw}")
}

fn fmt_clock(sec: f64) -> String {
    let s = sec.max(0.0).floor() as u64;
    let h = s / 3600;
    let m = (s % 3600) / 60;
    let r = s % 60;
    if h > 0 {
        format!("{h:02}:{m:02}:{r:02}")
    } else {
        format!("{m:02}:{r:02}")
    }
}

fn fmt_srt_time(sec: f64, dot: bool) -> String {
    let ms = (sec.max(0.0) * 1000.0).round() as u64;
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    let s = (ms % 60_000) / 1000;
    let rem = ms % 1000;
    let sep = if dot { '.' } else { ',' };
    format!("{h:02}:{m:02}:{s:02}{sep}{rem:03}")
}

fn fmt_lrc_time(sec: f64) -> String {
    let cs = (sec.max(0.0) * 100.0).round() as u64;
    let m = cs / 6000;
    let s = (cs % 6000) / 100;
    let rem = cs % 100;
    format!("{m:02}:{s:02}.{rem:02}")
}

pub fn render_transcript_text(
    ep: &Episode,
    segs: &[Segment],
    zh: Option<&[Option<String>]>,
    format: &str,
    content: &str,
) -> String {
    let pick_lines = |i: usize, s: &Segment| -> Vec<String> {
        let orig = s.text.trim();
        let tr = zh
            .and_then(|arr| arr.get(i))
            .and_then(|x| x.as_deref())
            .map(str::trim)
            .filter(|x| !x.is_empty());
        match content {
            "original" => vec![orig.to_string()],
            "translation" => vec![tr.unwrap_or(orig).to_string()],
            _ => match tr {
                Some(t) if t != orig => vec![t.to_string(), orig.to_string()],
                _ => vec![orig.to_string()],
            },
        }
    };

    match format.to_ascii_lowercase().as_str() {
        "srt" => segs
            .iter()
            .enumerate()
            .map(|(i, s)| {
                format!(
                    "{}\n{} --> {}\n{}",
                    i + 1,
                    fmt_srt_time(s.start, false),
                    fmt_srt_time(s.end.max(s.start + 0.5), false),
                    pick_lines(i, s).join("\n")
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
        "vtt" => {
            let mut out = String::from("WEBVTT\n\n");
            for (i, s) in segs.iter().enumerate() {
                out.push_str(&format!(
                    "{} --> {}\n{}\n\n",
                    fmt_srt_time(s.start, true),
                    fmt_srt_time(s.end.max(s.start + 0.5), true),
                    pick_lines(i, s).join("\n")
                ));
            }
            out
        }
        "lrc" => segs
            .iter()
            .enumerate()
            .map(|(i, s)| format!("[{}]{}", fmt_lrc_time(s.start), pick_lines(i, s).join(" / ")))
            .collect::<Vec<_>>()
            .join("\n"),
        "md" | "markdown" => {
            let mut out = format!("# {}\n", ep.title);
            if let Some(ref show) = ep.show_title {
                out.push_str(&format!("\n> {}\n", show));
            }
            if let Some(ref link) = ep.link {
                out.push_str(&format!("\n{link}\n"));
            }
            out.push('\n');
            for (i, s) in segs.iter().enumerate() {
                out.push_str(&format!(
                    "- **{}** {}\n",
                    fmt_clock(s.start),
                    pick_lines(i, s).join("  \n  ")
                ));
            }
            out
        }
        _ => segs
            .iter()
            .enumerate()
            .map(|(i, s)| format!("[{}] {}", fmt_clock(s.start), pick_lines(i, s).join("\n")))
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

fn looks_chinese(lang: &str, sample: &str) -> bool {
    if lang.to_ascii_lowercase().starts_with("zh") {
        return true;
    }
    let cjk = sample.chars().filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c)).count();
    let latin = sample.chars().filter(|c| c.is_ascii_alphabetic()).count();
    cjk > 0 && cjk * 2 >= latin
}

fn load_zh_blob(ctx: &McpCtx, episode_id: &str) -> Option<Vec<Option<String>>> {
    let raw = ctx
        .db
        .lock()
        .ok()
        .and_then(|c| db::get_blob(&c, episode_id, "zh").ok().flatten())?;
    serde_json::from_str(&raw).ok()
}

// ============================================================================
// 节目查找、无订阅预览与智能单集引用解析
// ============================================================================

fn resolve_local_show(conn: &rusqlite::Connection, query: &str) -> Result<Show> {
    let q = query.trim();
    if q.is_empty() {
        bail!("请提供节目名称或 ID");
    }
    let shows = db::list_shows(conn)?;
    let ql = q.to_ascii_lowercase();
    if let Some(exact_id) = shows.iter().find(|s| s.id == q || s.id.starts_with(q)) {
        return Ok(exact_id.clone());
    }
    let exact: Vec<&Show> = shows
        .iter()
        .filter(|s| s.title.to_ascii_lowercase() == ql)
        .collect();
    if exact.len() == 1 {
        return Ok(exact[0].clone());
    }
    let fuzzy: Vec<&Show> = shows
        .iter()
        .filter(|s| {
            s.title.to_ascii_lowercase().contains(&ql) || s.feed_url.to_ascii_lowercase().contains(&ql)
        })
        .collect();
    match fuzzy.len() {
        0 => bail!("已订阅列表中找不到节目：{q}"),
        1 => Ok(fuzzy[0].clone()),
        _ => {
            let list = fuzzy
                .iter()
                .take(8)
                .map(|s| format!("- {} (id: {}, kind: {})", s.title, s.id, s.kind))
                .collect::<Vec<_>>()
                .join("\n");
            bail!("匹配到多个已订阅节目，请让用户明确选择后传入具体 ID 或链接：\n{list}")
        }
    }
}

/// 不订阅预览节目：拉取目录并写入 episodes 表（不写入 shows 订阅栏）。
async fn preview_without_subscribe(ctx: &McpCtx, input: &str) -> Result<(Show, Vec<Episode>)> {
    let resolved = feeds::resolve(input).await?;
    let show = resolved.show;
    {
        let mut conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
        if resolved.catalog_partial {
            db::upsert_episodes(&mut conn, &resolved.episodes)?;
        } else {
            db::sync_episodes(&mut conn, &show.id, &resolved.episodes)?;
        }
    }
    let episodes = {
        let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
        db::list_episodes(&conn, Some(&show.id), feeds::LIST_EPISODES_CAP)?
    };
    Ok((show, episodes))
}

async fn find_show_candidates(ctx: &McpCtx, name: &str, limit: usize) -> Result<Vec<Value>> {
    let q = name.trim();
    if q.is_empty() {
        bail!("请提供节目名称");
    }
    let ql = q.to_ascii_lowercase();
    let mut out: Vec<Value> = Vec::new();
    let mut seen_feeds = std::collections::HashSet::<String>::new();

    // 1. 先检查已订阅节目
    {
        let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
        for s in db::list_shows(&conn)? {
            if s.title.to_ascii_lowercase().contains(&ql) {
                seen_feeds.insert(s.feed_url.clone());
                let newest = db::list_episodes(&conn, Some(&s.id), 1)?.into_iter().next();
                out.push(json!({
                    "subscribed": true,
                    "id": s.id,
                    "title": s.title,
                    "author": s.author,
                    "kind": s.kind,
                    "feedUrl": s.feed_url,
                    "episodeCount": s.episode_count,
                    "latestEpisode": newest.map(|e| json!({ "id": e.id, "title": e.title, "published": e.published })),
                }));
            }
        }
    }

    // 2. 搜索播客目录（中文查询走 CN，英文走 US）
    let country = if looks_chinese("", q) { "CN" } else { "US" };
    if let Ok(found) = feeds::search_podcasts(q, country).await {
        for s in found {
            if seen_feeds.contains(&s.feed_url) {
                continue;
            }
            seen_feeds.insert(s.feed_url.clone());
            out.push(json!({
                "subscribed": false,
                "id": s.id,
                "title": s.title,
                "author": s.author,
                "kind": s.kind,
                "feedUrl": s.feed_url,
            }));
            if out.len() >= limit {
                break;
            }
        }
    }
    out.truncate(limit);
    Ok(out)
}

fn looks_like_url(s: &str) -> bool {
    let t = s.trim();
    t.starts_with("http://")
        || t.starts_with("https://")
        || t.contains("youtube.com/")
        || t.contains("youtu.be/")
        || t.contains("xiaoyuzhoufm.com/")
        || t.contains("podcasts.apple.com/")
}

fn extract_youtube_video_id(url: &str) -> Option<String> {
    let re = regex::Regex::new(r"(?:v=|youtu\.be/|youtube\.com/shorts/|youtube\.com/live/)([A-Za-z0-9_-]{11})").ok()?;
    re.captures(url).map(|c| c[1].to_string())
}

/// 拆分 `<show>:latest` / `<show>:@2` 语法，返回 `(节目名, 0-based 序号)`。
fn split_show_selector(raw: &str) -> (&str, Option<usize>) {
    if let Some((left, right)) = raw.rsplit_once(':') {
        let r = right.trim();
        if r.eq_ignore_ascii_case("latest") {
            return (left.trim(), Some(0));
        }
        if let Some(num) = r.strip_prefix('@') {
            if let Ok(n) = num.parse::<usize>() {
                if n >= 1 {
                    return (left.trim(), Some(n - 1));
                }
            }
        }
    }
    (raw.trim(), None)
}

fn local_media(ep: &Episode) -> Option<PathBuf> {
    if ep.show_id != "local-media" { return None; }
    let path = ep.audio_url.as_ref()?;
    (ep.id == format!("local-{}", crate::model::short_hash(path, 32))).then(|| PathBuf::from(path))
}

/// 解析多态单集引用：ID / 标题 / 链接（无订阅直达） / `<节目名>:latest` / `<节目名>:@2`。
async fn resolve_episode_ref(ctx: &McpCtx, reference: &str) -> Result<Episode> {
    let raw = reference.trim();
    if raw.is_empty() {
        bail!("请提供单集引用（ID、标题、链接或「节目名:latest」）");
    }

    let file = std::path::Path::new(raw);
    if file.is_file() {
        let path = file.canonicalize()?;
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if !matches!(ext.as_str(), "wav"|"mp3"|"m4a"|"aac"|"flac"|"ogg"|"opus"|"mp4"|"mov"|"mkv"|"webm") {
            bail!("不支持该媒体文件格式");
        }
        let raw_path = path.to_string_lossy().into_owned();
        let id = format!("local-{}", crate::model::short_hash(&raw_path, 32));
        let ep = Episode { id:id.clone(), guid:id, show_id:"local-media".into(),
            title:path.file_stem().unwrap_or_default().to_string_lossy().into_owned(),
            audio_url:Some(raw_path), ..Default::default() };
        let mut conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
        db::upsert_episodes(&mut conn, std::slice::from_ref(&ep))?;
        return Ok(db::get_episode(&conn, &ep.id)?.unwrap_or(ep));
    }

    // 1. 精确 ID 命中
    {
        let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
        if let Some(ep) = db::get_episode(&conn, raw)? {
            return Ok(ep);
        }
    }

    // 2. URL 直达（无需订阅）
    if looks_like_url(raw) {
        let target_vid = extract_youtube_video_id(raw);
        let (_show, eps) = preview_without_subscribe(ctx, raw).await?;
        if let Some(ref vid) = target_vid {
            if let Some(hit) = eps.iter().find(|e| e.video_id.as_deref() == Some(vid.as_str())) {
                return Ok(hit.clone());
            }
        }
        return eps
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("该链接下没有找到可处理的单集"));
    }

    // 3. 检查 `<节目名>:latest` / `<节目名>:@N` 或已入库单集前缀/标题
    let (base, nth) = split_show_selector(raw);
    if nth.is_none() {
        let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
        let all = db::list_episodes(&conn, None, -1)?;
        let ql = raw.to_ascii_lowercase();
        if let Some(ep) = all.iter().find(|e| e.id.starts_with(raw)) {
            return Ok(ep.clone());
        }
        let by_title: Vec<&Episode> = all
            .iter()
            .filter(|e| e.title.to_ascii_lowercase().contains(&ql))
            .collect();
        if by_title.len() == 1 {
            return Ok(by_title[0].clone());
        }
        if by_title.len() > 1 {
            let list = by_title
                .iter()
                .take(6)
                .map(|e| format!("- {} (id: {})", e.title, e.id))
                .collect::<Vec<_>>()
                .join("\n");
            bail!("标题匹配到多个单集，请让用户选择后传入具体 ID：\n{list}");
        }
    }

    let pick_idx = nth.unwrap_or(0);
    // 4. 先查已订阅节目
    {
        let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
        if let Ok(show) = resolve_local_show(&conn, base) {
            let eps = db::list_episodes(&conn, Some(&show.id), (pick_idx + 1) as i64)?;
            if let Some(ep) = eps.into_iter().nth(pick_idx) {
                return Ok(ep);
            }
            bail!("节目「{}」下没有第 {} 期单集", show.title, pick_idx + 1);
        }
    }

    // 5. 未订阅：去目录搜索候选；只有唯一精确同名才自动预览，否则列出候选让 Agent 问用户
    let cands = find_show_candidates(ctx, base, 6).await?;
    if cands.is_empty() {
        bail!("找不到匹配「{base}」的节目或单集，请提供节目链接或用 find_show 搜索");
    }
    let bl = base.to_ascii_lowercase();
    let exact: Vec<&Value> = cands
        .iter()
        .filter(|c| c["title"].as_str().is_some_and(|t| t.to_ascii_lowercase() == bl))
        .collect();
    let chosen = if exact.len() == 1 {
        exact[0]
    } else if cands.len() == 1 {
        &cands[0]
    } else {
        let lines = cands
            .iter()
            .map(|c| {
                format!(
                    "- {} | 作者: {} | 来源: {} | feedUrl: {}",
                    c["title"].as_str().unwrap_or(""),
                    c["author"].as_str().unwrap_or("-"),
                    c["kind"].as_str().unwrap_or(""),
                    c["feedUrl"].as_str().unwrap_or("")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        bail!(
            "ambiguous: 找到多个与「{base}」相似的节目，请先展示以下候选让用户选择，再将选中的 feedUrl 传给 preview_show 或本工具：\n{lines}"
        );
    };
    let feed_url = chosen["feedUrl"]
        .as_str()
        .ok_or_else(|| anyhow!("候选节目缺少 feedUrl"))?;
    let (_show, eps) = preview_without_subscribe(ctx, feed_url).await?;
    eps.into_iter()
        .nth(pick_idx)
        .ok_or_else(|| anyhow!("该节目下没有第 {} 期单集", pick_idx + 1))
}

// ============================================================================
// 配置解析（与桌面端 Settings 对齐，永不泄漏密钥）
// ============================================================================

fn resolve_llm_config(ctx: &McpCtx, purpose: &str) -> Result<(String, llm::LlmConfig)> {
    let settings = ctx.app_settings();
    let provider_key = if purpose == "translate" {
        settings["translateProvider"]
            .as_str()
            .or_else(|| settings["chatProvider"].as_str())
            .unwrap_or("deepseek")
    } else {
        settings["chatProvider"].as_str().unwrap_or("deepseek")
    };
    let providers = &settings["providers"];
    let p = &providers[provider_key];
    let base_url = p["baseUrl"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("未配置 AI 模型服务（请在声译设置 › AI 中配置默认模型）"))?
        .to_string();
    let model = if purpose == "chat" {
        settings["chatModel"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| p["model"].as_str())
            .unwrap_or("")
            .to_string()
    } else {
        p["model"].as_str().unwrap_or("").to_string()
    };
    if model.is_empty() {
        bail!("未配置模型名称（请在声译设置 › AI 中选择模型）");
    }
    let protocol = p["protocol"].as_str().unwrap_or("openai").to_string();
    let needs_key = p["needsKey"].as_bool().unwrap_or(true);
    let api_key = if needs_key { secrets::get_key(provider_key)?.unwrap_or_default() } else { String::new() };
    if needs_key && api_key.trim().is_empty() {
        bail!("AI 服务「{provider_key}」尚未配置 API Key，请先在声译设置中填写");
    }
    let label = format!(
        "{} · {}",
        p["name"].as_str().unwrap_or(provider_key),
        model
    );
    Ok((
        label,
        llm::LlmConfig {
            base_url,
            model,
            protocol,
            api_key,
        },
    ))
}

// ============================================================================
// 核心业务操作（字幕获取/转写、翻译、导读、问答、视频/音频切片）
// ============================================================================

async fn fetch_or_transcribe(
    ctx: &McpCtx,
    ep: &Episode,
    model_override: Option<&str>,
    language: &str,
    no_shared: bool,
    force: bool,
    rpc: &RpcOut,
    progress_token: Option<&Value>,
) -> Result<Transcript> {
    if !force {
        if let Some(cached) = ctx.db.lock().map_err(|e| anyhow!("{e}"))?.load_transcript_opt(&ep.id)? {
            if !cached.segments.is_empty() {
                return Ok(cached);
            }
        }
    }

    rpc.progress(progress_token, 0.1, 1.0, "正在查找官方字幕…");

    // 1. 官方字幕（YouTube / RSS / Podscribe / 乔木）
    if let Some(ref vid) = ep.video_id {
        if let Ok(info) = captions::video_info(vid).await {
            let hint = captions::script_hint(&info.title).or_else(|| captions::script_hint(&ep.title));
            if let Some(track) = captions::choose(&info.tracks, info.original_language.as_deref(), hint) {
                if let Ok(raw) = captions::fetch_track_raw(track).await {
                    let segs = captions::resegment(captions::clean(raw));
                    if !segs.is_empty() {
                        let tr = Transcript {
                            episode_id: ep.id.clone(),
                            source: if track.auto { "youtube-auto".into() } else { "youtube".into() },
                            language: track.language.clone(),
                            segments: segs,
                        };
                        {
                            let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
                            db::save_transcript(&conn, &tr)?;
                        }
                        if let Some(zh_track) = captions::official_chinese(&info.tracks, &track.language) {
                            if let Ok(raw_zh) = captions::fetch_track_raw(zh_track).await {
                                let aligned = captions::align(&tr.segments, &captions::clean(raw_zh));
                                if aligned.iter().filter(|x| x.is_some()).count() * 10 >= aligned.len() * 6 {
                                    let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
                                    let _ = db::set_blob(&conn, &ep.id, "zh", &serde_json::to_string(&aligned)?);
                                    let _ = db::set_blob(&conn, &ep.id, "zh-engine", "youtube");
                                }
                            }
                        }
                        rpc.progress(progress_token, 1.0, 1.0, "已获取官方字幕");
                        return Ok(tr);
                    }
                }
            }
        }
    } else if let Some(ref url) = ep.transcript_url {
        let kind = ep.transcript_type.as_deref().unwrap_or("");
        let segs_res = if kind == "podscribe" {
            qiaomu::podscribe_transcript(url).await.map(captions::resegment)
        } else {
            captions::fetch_rss_transcript(url, kind).await
        };
        if let Ok(segs) = segs_res {
            if !segs.is_empty() {
                let tr = Transcript {
                    episode_id: ep.id.clone(),
                    source: if kind == "podscribe" { "podscribe".into() } else { "rss".into() },
                    language: "auto".into(),
                    segments: segs,
                };
                let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
                db::save_transcript(&conn, &tr)?;
                rpc.progress(progress_token, 1.0, 1.0, "已获取官方字幕");
                return Ok(tr);
            }
        }
    } else if ep.transcript_type.as_deref() == Some("qiaomu") {
        if let Some(ref link) = ep.link {
            if let Ok(detail) = qiaomu::detail(link).await {
                if let Some(text) = detail.transcript {
                    let segs = qiaomu::transcript_segments(&text, ep.duration.unwrap_or(3600.0));
                    if !segs.is_empty() {
                        let tr = Transcript {
                            episode_id: ep.id.clone(),
                            source: "qiaomu".into(),
                            language: "auto".into(),
                            segments: segs,
                        };
                        let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
                        db::save_transcript(&conn, &tr)?;
                        rpc.progress(progress_token, 1.0, 1.0, "已获取精读站原文");
                        return Ok(tr);
                    }
                }
            }
        }
    }

    // 2. 社区共享字幕库
    if !no_shared && local_media(ep).is_none() {
        rpc.progress(progress_token, 0.25, 1.0, "正在查询共享字幕库…");
        if let Some(mut hit) = shared::lookup(&shared::keys(ep)).await {
            let translation = hit.translation.take();
            let tr = shared::into_transcript(&ep.id, hit);
            if !tr.segments.is_empty() {
                let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
                db::save_transcript(&conn, &tr)?;
                if let Some(zh) =
                    translation.filter(|z| z.items.len() == tr.segments.len() && z.lang.starts_with("zh"))
                {
                    let _ = db::set_blob(&conn, &ep.id, "zh", &serde_json::to_string(&zh.items)?);
                    let _ = db::set_blob(&conn, &ep.id, "zh-engine", "shared");
                }
                rpc.progress(progress_token, 1.0, 1.0, "已命中共享字幕");
                return Ok(tr);
            }
        }
    }

    // 3. 本机 ASR 转写（优先已下载模型）
    let settings = ctx.app_settings();
    let want_model = model_override
        .or_else(|| settings["asrModel"].as_str())
        .unwrap_or("qwen3-asr");
    let resolved = asr::resolve(&ctx.data, want_model).or_else(|| {
        asr::list_models(&ctx.data)
            .into_iter()
            .find(|m| m.installed)
            .and_then(|m| asr::resolve(&ctx.data, &m.id))
    });
    let resolved = resolved.ok_or_else(|| {
        anyhow!("未找到官方/共享字幕，且本机尚未安装 ASR 识别模型（请先在声译设置 › 字幕下载 Qwen3-ASR 或 Whisper 模型）")
    })?;

    let cancel = Arc::new(AtomicBool::new(false));
    rpc.progress(progress_token, 0.35, 1.0, "正在准备音频…");
    let work = ctx.data.join("work").join(format!("mcp-asr-{}", uuid::Uuid::new_v4().simple()));
    tokio::fs::create_dir_all(&work).await?;
    let local_audio = local_media(ep).or_else(|| offline::find(&ctx.data, &ep.id)
        .or_else(|| offline::find_cached(&ctx.data, &ep.id))
        .map(|s| PathBuf::from(s.path)))
        .or_else(|| asr::find_cached_audio(&ctx.data, &ep.id));

    let audio_path = match local_audio {
        Some(p) => p,
        None => {
            asr::fetch_episode_audio(
                &ctx.data,
                &work,
                ep.audio_url.as_deref(),
                ep.video_id.as_deref(),
                cancel.clone(),
                |p| rpc.progress(progress_token, 0.35 + p * 0.25, 1.0, "正在下载音频…"),
            )
            .await?
        }
    };

    rpc.progress(progress_token, 0.62, 1.0, "正在本机语音识别…");
    let tr = if resolved.engine == "qwen3" {
        let bin = asr::ensure_crispasr(&ctx.data, &cancel, |_, _| {}).await?;
        let wav = work.join("input.wav");
        let audio_clone = audio_path.clone();
        let wav_clone = wav.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let pcm = asr::decode_16k_mono(&audio_clone)?;
            asr::write_wav(&wav_clone, &pcm)
        })
        .await??;
        let segs = asr::run_crispasr(&bin, &resolved.path, &wav, language, cancel, |p| {
            rpc.progress(progress_token, 0.62 + p * 0.35, 1.0, "正在本机 Qwen3-ASR 识别…");
        })
        .await?;
        Transcript {
            episode_id: ep.id.clone(),
            source: "qwen3".into(),
            language: language.into(),
            segments: segs,
        }
    } else {
        let res = asr::run_whisper_worker(&audio_path, &resolved.path, language, cancel, |ev| {
            if let asr::WorkerEvent::Progress(p) = ev {
                rpc.progress(progress_token, 0.62 + p * 0.35, 1.0, "正在本机 Whisper 识别…");
            }
        })
        .await?;
        Transcript {
            episode_id: ep.id.clone(),
            source: "whisper".into(),
            language: res.language,
            segments: res.segments,
        }
    };
    let _ = tokio::fs::remove_dir_all(&work).await;
    if tr.segments.is_empty() {
        bail!("未识别出有效字幕内容");
    }
    {
        let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
        db::save_transcript(&conn, &tr)?;
    }
    rpc.progress(progress_token, 1.0, 1.0, "字幕识别完成");
    Ok(tr)
}

async fn translate_episode_core(
    ctx: &McpCtx,
    ep: &Episode,
    mode: &str,
    target: &str,
    rpc: &RpcOut,
    progress_token: Option<&Value>,
) -> Result<Value> {
    let tr = ctx
        .db
        .lock()
        .map_err(|e| anyhow!("{e}"))?
        .load_transcript_opt(&ep.id)?
        .ok_or_else(|| anyhow!("该单集还没有字幕，请先调用 transcribe_episode"))?;
    let sample: String = tr.segments.iter().take(5).map(|s| s.text.as_str()).collect();
    if looks_chinese(&tr.language, &sample) && target.starts_with("zh") {
        return Ok(json!({
            "episodeId": ep.id,
            "skipped": true,
            "reason": "字幕本身已是中文",
            "segments": tr.segments.len()
        }));
    }

    let mut items: Vec<Option<String>> = load_zh_blob(ctx, &ep.id)
        .unwrap_or_else(|| vec![None; tr.segments.len()]);
    items.resize(tr.segments.len(), None);

    let llm_cfg = if mode == "google" {
        None
    } else {
        resolve_llm_config(ctx, "translate").ok().map(|(_, c)| c)
    };
    if mode == "llm" && llm_cfg.is_none() {
        bail!("指定了 llm 翻译模式，但尚未配置可用的 AI 模型与 API Key");
    }
    let engine_tag = if llm_cfg.is_some() { "llm" } else { "google" };
    let quality = ctx.app_settings()["translateQuality"]
        .as_str()
        .unwrap_or("fast")
        .to_string();

    let missing: Vec<usize> = items
        .iter()
        .enumerate()
        .filter(|(i, v)| v.as_deref().map(str::trim).unwrap_or("").is_empty() && !tr.segments[*i].text.trim().is_empty())
        .map(|(i, _)| i)
        .collect();

    let total = missing.len().max(1);
    let chunk_size = if llm_cfg.is_some() { 20 } else { 30 };
    let mut done = 0usize;

    for chunk in missing.chunks(chunk_size) {
        let texts: Vec<String> = chunk.iter().map(|&i| tr.segments[i].text.clone()).collect();
        let translated = if let Some(ref cfg) = llm_cfg {
            match translate::llm_batch_quality(cfg, &texts, target, &quality).await {
                Ok(out) => out,
                Err(_) if mode == "auto" => translate::google_batch(&texts, target).await?,
                Err(e) => return Err(e),
            }
        } else {
            translate::google_batch(&texts, target).await?
        };
        for (&idx, zh_line) in chunk.iter().zip(translated.into_iter()) {
            let trimmed = zh_line.trim().to_string();
            if !trimmed.is_empty() {
                items[idx] = Some(trimmed);
            }
        }
        done += chunk.len();
        rpc.progress(
            progress_token,
            (done as f64 / total as f64).min(0.99),
            1.0,
            &format!("已翻译 {done}/{total} 句…"),
        );
        let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
        db::set_blob(&conn, &ep.id, "zh", &serde_json::to_string(&items)?)?;
        db::set_blob(&conn, &ep.id, "zh-engine", engine_tag)?;
    }

    rpc.progress(progress_token, 1.0, 1.0, "翻译完成");
    let translated_count = items.iter().filter(|x| x.as_deref().is_some_and(|s| !s.is_empty())).count();
    Ok(json!({
        "episodeId": ep.id,
        "engine": engine_tag,
        "translated": translated_count,
        "total": tr.segments.len()
    }))
}

fn pack_transcript_for_llm(ep: &Episode, segs: &[Segment], zh: Option<&[Option<String>]>, max_chars: usize) -> String {
    let mut out = format!("节目：{}\n本期：{}\n\n字幕文稿：\n", ep.show_title.as_deref().unwrap_or(""), ep.title);
    let step = if segs.len() > 800 { 2 } else { 1 };
    for (i, s) in segs.iter().enumerate().step_by(step) {
        let tr = zh
            .and_then(|arr| arr.get(i))
            .and_then(|x| x.as_deref())
            .map(str::trim)
            .filter(|x| !x.is_empty());
        let line = match tr {
            Some(t) if t != s.text.trim() => format!("[{}] {} | {}\n", fmt_clock(s.start), t, s.text.trim()),
            _ => format!("[{}] {}\n", fmt_clock(s.start), s.text.trim()),
        };
        if out.len() + line.len() > max_chars {
            out.push_str("\n…（后文已截断）\n");
            break;
        }
        out.push_str(&line);
    }
    out
}

async fn extract_highlights(ctx: &McpCtx, ep: &Episode, intent: &str) -> Result<Value> {
    let transcript = ctx.db.lock().map_err(|e| anyhow!("{e}"))?.load_transcript_opt(&ep.id)?
        .ok_or_else(|| anyhow!("请先转写单集"))?;
    let (model, cfg) = resolve_llm_config(ctx, "chat")?;
    let mut clips = Vec::new();
    for (window, segments) in transcript.segments.chunks(100).enumerate() {
        let offset = window * 100;
        let lines = segments.iter().enumerate().map(|(i,s)| format!("{} {}", offset+i, s.text))
            .collect::<Vec<_>>().join("\n");
        let answer = llm::chat_once(&cfg, &[
            llm::ChatMessage { role:"system".into(), content:"挑选至多两个连贯的高光片段。返回 JSON 数组，每项含整数 startIdx 和 endIdx（字幕编号，含端点），字符串 title、reason、shareCopy。没有合适片段返回 []。".into() },
            llm::ChatMessage { role:"user".into(), content:format!("方向：{intent}\n{lines}") }
        ]).await?;
        let from = answer.find('[').ok_or_else(|| anyhow!("模型没有返回片段列表"))?;
        let items: Vec<Value> = serde_json::Deserializer::from_str(&answer[from..]).into_iter::<Vec<Value>>().next().transpose()?.unwrap_or_default();
        for item in items.into_iter().take(2) {
            let (Some(a), Some(b)) = (item["startIdx"].as_u64(),item["endIdx"].as_u64()) else { continue };
            if a>b || a < offset as u64 || b >= (offset+segments.len()) as u64 { continue; }
            clips.push(json!({"id":uuid::Uuid::new_v4().to_string(),"startIdx":a,"endIdx":b,
                "start":transcript.segments[a as usize].start,"end":transcript.segments[b as usize].end,
                "title":item["title"].as_str().unwrap_or("高光"),"reason":item["reason"].as_str().unwrap_or(""),
                "shareCopy":item["shareCopy"].as_str().unwrap_or(""),"score":0,"tags":[]}));
        }
    }
    if clips.is_empty() { bail!("没有找到符合方向的片段"); }
    let bundle = json!({"clips":clips,"createdAt":chrono::Utc::now().timestamp_millis(),"intent":intent,"model":model});
    let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
    db::set_blob(&conn, &ep.id,"highlights",&bundle.to_string())?;
    Ok(bundle)
}

async fn generate_guide_core(ctx: &McpCtx, ep: &Episode, regenerate: bool) -> Result<Value> {
    if !regenerate {
        let existing = ctx
            .db
            .lock()
            .map_err(|e| anyhow!("{e}"))?
            .get_blob_opt(&ep.id, "summary")?;
        if let Some(md) = existing.filter(|s| !s.trim().is_empty()) {
            return Ok(json!({ "episodeId": ep.id, "source": "cache", "guide": md }));
        }
        if let Some(shared_md) = shared::lookup_guide(&shared::keys(ep)).await {
            let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
            let _ = db::set_blob(&conn, &ep.id, "summary", &shared_md);
            let _ = db::set_blob(&conn, &ep.id, "summary-from", "shared");
            return Ok(json!({ "episodeId": ep.id, "source": "shared", "guide": shared_md }));
        }
    }

    let tr = ctx
        .db
        .lock()
        .map_err(|e| anyhow!("{e}"))?
        .load_transcript_opt(&ep.id)?
        .ok_or_else(|| anyhow!("该单集还没有字幕，请先调用 transcribe_episode"))?;
    let zh = load_zh_blob(ctx, &ep.id);
    let (model_label, cfg) = resolve_llm_config(ctx, "chat")?;
    let packed = pack_transcript_for_llm(ep, &tr.segments, zh.as_deref(), 48_000);
    let system = "你是资深播客编辑。请用清晰克制的简体中文为听众撰写本期深度导读（Markdown 格式），包含：\n\
        1. 一句话核心洞察\n\
        2. 3–6 个关键议题与核心论点（附带对应时间戳 [mm:ss]）\n\
        3. 2–4 条值得收藏的原话金句（带时间戳）\n\
        忠于原话，不编造文稿中未出现的事实。";
    let md = llm::chat_once(
        &cfg,
        &[
            llm::ChatMessage { role: "system".into(), content: system.into() },
            llm::ChatMessage { role: "user".into(), content: packed },
        ],
    )
    .await?;
    {
        let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
        db::set_blob(&conn, &ep.id, "summary", &md)?;
        db::set_blob(&conn, &ep.id, "summary-from", &model_label)?;
    }
    Ok(json!({ "episodeId": ep.id, "source": model_label, "guide": md }))
}

async fn ask_episode_core(ctx: &McpCtx, ep: &Episode, question: &str, reset: bool) -> Result<Value> {
    let q = question.trim();
    if q.is_empty() {
        bail!("请提供问题内容");
    }
    let tr = ctx
        .db
        .lock()
        .map_err(|e| anyhow!("{e}"))?
        .load_transcript_opt(&ep.id)?
        .ok_or_else(|| anyhow!("该单集还没有字幕，请先调用 transcribe_episode"))?;
    let zh = load_zh_blob(ctx, &ep.id);
    let (model_label, cfg) = resolve_llm_config(ctx, "chat")?;

    let mut history: Vec<llm::ChatMessage> = if reset {
        vec![]
    } else {
        ctx.db
            .lock()
            .map_err(|e| anyhow!("{e}"))?
            .get_blob_opt(&ep.id, "chat")?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    };

    let packed = pack_transcript_for_llm(ep, &tr.segments, zh.as_deref(), 42_000);
    let mut messages = vec![llm::ChatMessage {
        role: "system".into(),
        content: format!(
            "你是播客阅读助手。请严格基于下方单集字幕回答用户问题，引用关键观点时标注时间戳 [mm:ss]，文稿未提及的内容请如实说明。\n\n{packed}"
        ),
    }];
    let recent_start = history.len().saturating_sub(8);
    messages.extend(history[recent_start..].iter().cloned());
    messages.push(llm::ChatMessage {
        role: "user".into(),
        content: q.to_string(),
    });

    let answer = llm::chat_once(&cfg, &messages).await?;
    history.push(llm::ChatMessage {
        role: "user".into(),
        content: q.to_string(),
    });
    history.push(llm::ChatMessage {
        role: "assistant".into(),
        content: answer.clone(),
    });
    {
        let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
        db::set_blob(&conn, &ep.id, "chat", &serde_json::to_string(&history)?)?;
    }
    Ok(json!({
        "episodeId": ep.id,
        "model": model_label,
        "answer": answer,
        "turns": history.len() / 2
    }))
}

pub fn validate_output_path(raw: &str) -> Result<PathBuf> {
    let p = PathBuf::from(raw.trim());
    if p.as_os_str().is_empty() {
        bail!("输出路径不能为空");
    }
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        bail!("输出路径不允许包含 ..");
    }
    #[cfg(unix)]
    {
        let s = p.to_string_lossy();
        for forbidden in ["/System", "/usr", "/bin", "/sbin", "/etc", "/Library"] {
            if s == forbidden || s.starts_with(&format!("{forbidden}/")) {
                bail!("不允许写入系统目录：{s}");
            }
        }
    }
    Ok(p)
}

async fn clip_video_core(
    ctx: &McpCtx,
    ep: &Episode,
    start: f64,
    end: f64,
    preset: &str,
    output_path: Option<&str>,
    rpc: &RpcOut,
    progress_token: Option<&Value>,
) -> Result<Value> {
    if !(end > start && end - start >= 0.5 && end - start <= 900.0) {
        bail!("片段时长须在 0.5 到 900 秒之间");
    }
    let out_override = match output_path.map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => Some(validate_output_path(p)?.to_string_lossy().into_owned()),
        None => None,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let prepared = if let Some(path) = local_media(ep) {
        videoclip::prepare_local_media(&ctx.data, &ep.id, &path, start, end, &cancel).await?
    } else if let Some(ref vid) = ep.video_id {
        videoclip::prepare_segment(&ctx.data, vid, start, end, &cancel, |_st, p, m| {
            rpc.progress(progress_token, p * 0.55, 1.0, m);
        })
        .await?
    } else if let Some(ref audio_url) = ep.audio_url {
        let cover = ep.cover.clone().or_else(|| {
            ctx.db
                .lock()
                .ok()
                .and_then(|c| db::get_show(&c, &ep.show_id).ok().flatten())
                .and_then(|s| s.cover)
        });
        videoclip::prepare_audio_ranges(
            &ctx.data,
            &ep.id,
            audio_url,
            cover.as_deref(),
            &[(start, end)],
            cancel.clone(),
            |_st, p, m| rpc.progress(progress_token, p * 0.55, 1.0, m),
        )
        .await?
    } else {
        bail!("该单集没有可用的视频或音频源");
    };

    let (layout, frame) = match preset.to_ascii_lowercase().as_str() {
        "landscape" | "16:9" => ("landscape", None),
        "square" | "1:1" => (
            "frame",
            Some(videoclip::Frame {
                w: 1080,
                h: 1080,
                fit: "fill".into(),
                vx: 0,
                vy: 0,
                vw: 1080,
                vh: 1080,
                crop_box: false,
            }),
        ),
        "fill" | "portrait_fill" => ("portrait_fill", None),
        _ => ("portrait_card", None),
    };
    let export_dir = ctx.app_settings()["clipExportDir"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let req = videoclip::RenderRequest {
        frame,
        lead: prepared.lead,
        speed: 1.0,
        output_dir: export_dir,
        raw_path: prepared.path,
        output_path: out_override,
        default_name: format!("{} ({})", ep.title.chars().take(48).collect::<String>(), fmt_clock(start).replace(':', "-")),
        layout: layout.into(),
        card_bg: "blur".into(),
        crop_x: 0.5,
        duration: prepared.duration,
        static_overlay_png: None,
        cues: vec![],
        cover_png: None,
        cover_mode: "none".into(),
        embed_thumbnail: false,
        save_cover_sidecar: false,
        landscape_cover_png: None,
    };
    let rendered = videoclip::render(&ctx.data, req, &cancel, |_st, p, m| {
        rpc.progress(progress_token, 0.55 + p * 0.45, 1.0, m);
    })
    .await?;
    let transcript = {
        let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
        db::load_transcript(&conn, &ep.id)?
    };
    if let Some(tr) = transcript {
        let translations = load_zh_blob(ctx, &ep.id);
        let mut segments = Vec::new();
        let mut zh = Vec::new();
        for (i, line) in tr.segments.into_iter().enumerate() {
            if line.end <= start || line.start >= end { continue; }
            segments.push(Segment { start: (line.start-start).max(0.0), end: line.end.min(end)-start, text: line.text });
            zh.push(translations.as_ref().and_then(|items| items.get(i)).cloned().flatten());
        }
        if !segments.is_empty() {
            let video = std::path::Path::new(&rendered.video_path);
            let work = tempfile::tempdir_in(video.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(std::path::Path::new(".")))?;
            let captions = work.path().join("captions.srt");
            let subtitled = work.path().join("subtitled.mp4");
            std::fs::write(&captions, render_transcript_text(ep,&segments,Some(&zh),"srt","bilingual"))?;
            let bin = videoclip::env_status(&ctx.data).path.ok_or_else(|| anyhow!("缺少 FFmpeg"))?;
            let result = tokio::process::Command::new(bin).arg("-i").arg(video).arg("-i").arg(&captions)
                .args(["-map","0:v","-map","0:a?","-map","1:s","-c","copy","-c:s","mov_text","-disposition:s:0","default","-movflags","+faststart"])
                .arg(&subtitled).output().await?;
            if !result.status.success() { bail!("视频已导出，但字幕轨道写入失败"); }
            std::fs::rename(subtitled,video)?;
        }
    }
    Ok(serde_json::to_value(rendered)?)
}

pub fn run_doctor(ctx: &McpCtx) -> Result<Value> {
    let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
    let shows = db::list_shows(&conn)?.len();
    let episodes = db::count_all_episodes(&conn)?;
    let settings = db::get_setting(&conn, "app")?
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!({}));
    let chat_provider = settings["chatProvider"].as_str().unwrap_or("deepseek");
    let chat_has_key = secrets::has_key(chat_provider);
    let ffmpeg = videoclip::env_status(&ctx.data);
    let installed_asr: Vec<String> = asr::list_models(&ctx.data)
        .into_iter()
        .filter(|m| m.installed)
        .map(|m| m.id)
        .collect();
    Ok(json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "dataDir": ctx.data,
        "dbPath": ctx.data.join(db::DB_FILE),
        "shows": shows,
        "episodes": episodes,
        "ffmpeg": ffmpeg,
        "installedAsrModels": installed_asr,
        "chatProvider": chat_provider,
        "chatKeyConfigured": chat_has_key,
    }))
}

pub fn list_shows_json(ctx: &McpCtx) -> Result<Value> {
    let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
    Ok(serde_json::to_value(db::list_shows(&conn)?)?)
}

pub fn list_episodes_json(ctx: &McpCtx, show: Option<&str>, limit: i64) -> Result<Value> {
    let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
    let eps = if let Some(q) = show.map(str::trim).filter(|s| !s.is_empty()) {
        let sh = resolve_local_show(&conn, q)?;
        db::list_episodes(&conn, Some(&sh.id), limit)?
    } else {
        db::recent_episodes(&conn, limit)?
    };
    Ok(serde_json::to_value(eps)?)
}

// ============================================================================
// Rusqlite 辅助 trait（精简锁作用域）
// ============================================================================

trait DbExt {
    fn load_transcript_opt(&self, episode_id: &str) -> Result<Option<Transcript>>;
    fn get_blob_opt(&self, episode_id: &str, kind: &str) -> Result<Option<String>>;
}

impl DbExt for rusqlite::Connection {
    fn load_transcript_opt(&self, episode_id: &str) -> Result<Option<Transcript>> {
        db::load_transcript(self, episode_id)
    }
    fn get_blob_opt(&self, episode_id: &str, kind: &str) -> Result<Option<String>> {
        db::get_blob(self, episode_id, kind)
    }
}

// ============================================================================
// MCP Tool 定义与分派
// ============================================================================

const REF_DESC: &str = "Episode id/title, local audio/video file, a podcast/YouTube/Xiaoyuzhou/RSS link (used without subscribing), or `<show>:latest` / `<show>:@2`. If the error says `ambiguous`, list the returned show candidates and ask the user to choose, then retry with the chosen feedUrl.";

pub fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "search_episodes",
            "description": "Search a show’s episode titles, notes and saved transcripts.",
            "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "show": {"type": "string"}}, "required": ["query", "show"]}
        }),
        json!({
            "name": "search_podcasts",
            "description": "Search the podcast directory by country.",
            "inputSchema": {"type": "object", "properties": {"term": {"type": "string"}, "country": {"type": "string", "default": "cn"}}, "required": ["term"]}
        }),
        json!({
            "name": "extract_highlights",
            "description": "Find shareable quotes and timestamped clips in the transcript.",
            "inputSchema": {"type": "object", "properties": {"reference": {"type": "string"}, "intent": {"type": "string"}}, "required": ["reference"]}
        }),
        json!({
            "name": "render_poster",
            "description": "Save a quote poster as a PNG (paper, warm, night, bamboo or sand).",
            "inputSchema": {"type": "object", "properties": {"reference": {"type": "string"}, "orig": {"type": "string"}, "zh": {"type": "string"}, "theme": {"type": "string", "default": "paper"}, "outputPath": {"type": "string"}}, "required": ["outputPath"]}
        }),
        json!({
            "name": "vocab_lookup",
            "description": "Look up a word in the offline English dictionary.",
            "inputSchema": {"type": "object", "properties": {"word": {"type": "string"}}, "required": ["word"]}
        }),
        json!({
            "name": "vocab_add",
            "description": "Save a word and optional context to the vocabulary book.",
            "inputSchema": {"type": "object", "properties": {"word": {"type": "string"}, "meaning": {"type": "string"}, "sentence": {"type": "string"}}, "required": ["word"]}
        }),
        json!({
            "name": "vocab_list",
            "description": "List saved vocabulary or only words due for review.",
            "inputSchema": {"type": "object", "properties": {"dueOnly": {"type": "boolean", "default": false}}, "required": []}
        }),
        json!({
            "name": "vocab_review_due",
            "description": "List due words or rate one word again, hard, good or easy.",
            "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "rating": {"type": "string"}}, "required": []}
        }),
        json!({
            "name": "list_shows",
            "description": "List subscribed podcast and YouTube shows in the Subpodcast (声译) library.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "list_episodes",
            "description": "List recent episodes, or episodes from a specific subscribed show.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "show": { "type": "string", "description": "Optional show id, prefix, or title" },
                    "limit": { "type": "integer", "default": 20 }
                }
            }
        }),
        json!({
            "name": "find_show",
            "description": "Find shows by name across subscribed library and podcast directory. If multiple matches could fit, ask the user to choose using the returned details and pass the chosen feedUrl to preview_show or as `reference`.",
            "inputSchema": {
                "type": "object",
                "required": ["name"],
                "properties": {
                    "name": { "type": "string" },
                    "limit": { "type": "integer", "default": 6 }
                }
            }
        }),
        json!({
            "name": "preview_show",
            "description": "List episodes from a podcast RSS, Xiaoyuzhou, Apple Podcasts, or YouTube channel URL WITHOUT subscribing. Returned episode ids work as `reference` in all other tools.",
            "inputSchema": {
                "type": "object",
                "required": ["input"],
                "properties": {
                    "input": { "type": "string", "description": "Podcast RSS, Xiaoyuzhou, Apple Podcasts, or YouTube channel URL" },
                    "limit": { "type": "integer", "default": 20 }
                }
            }
        }),
        json!({
            "name": "add_subscription",
            "description": "Subscribe to a podcast RSS, Xiaoyuzhou, Apple Podcasts, or YouTube channel URL.",
            "inputSchema": {
                "type": "object",
                "required": ["input"],
                "properties": { "input": { "type": "string" } }
            }
        }),
        json!({
            "name": "get_episode",
            "description": "Get episode metadata, transcript stats, Chinese translation progress, and guide availability.",
            "inputSchema": {
                "type": "object",
                "required": ["reference"],
                "properties": { "reference": { "type": "string", "description": REF_DESC } }
            }
        }),
        json!({
            "name": "get_transcript",
            "description": "Export episode subtitles as txt, srt, vtt, md, or lrc in bilingual, translation, or original mode.",
            "inputSchema": {
                "type": "object",
                "required": ["reference"],
                "properties": {
                    "reference": { "type": "string", "description": REF_DESC },
                    "format": { "type": "string", "enum": ["txt", "srt", "vtt", "md", "lrc"], "default": "txt" },
                    "content": { "type": "string", "enum": ["bilingual", "translation", "original"], "default": "bilingual" }
                }
            }
        }),
        json!({
            "name": "transcribe_episode",
            "description": "Fetch official/shared subtitles or transcribe an episode locally using installed Qwen3-ASR/Whisper models.",
            "inputSchema": {
                "type": "object",
                "required": ["reference"],
                "properties": {
                    "reference": { "type": "string", "description": REF_DESC },
                    "model": { "type": "string", "description": "Optional local ASR model id (e.g. qwen3-asr, large-v3-turbo, small, base)" },
                    "language": { "type": "string", "default": "auto" },
                    "noShared": { "type": "boolean", "default": false },
                    "force": { "type": "boolean", "default": false }
                }
            }
        }),
        json!({
            "name": "translate_episode",
            "description": "Translate episode subtitles into Chinese using configured LLM or Google Translate.",
            "inputSchema": {
                "type": "object",
                "required": ["reference"],
                "properties": {
                    "reference": { "type": "string", "description": REF_DESC },
                    "mode": { "type": "string", "enum": ["auto", "llm", "google"], "default": "auto" },
                    "target": { "type": "string", "default": "zh-CN" }
                }
            }
        }),
        json!({
            "name": "generate_guide",
            "description": "Retrieve or generate a structured Chinese Markdown study guide for an episode.",
            "inputSchema": {
                "type": "object",
                "required": ["reference"],
                "properties": {
                    "reference": { "type": "string", "description": REF_DESC },
                    "regenerate": { "type": "boolean", "default": false }
                }
            }
        }),
        json!({
            "name": "ask_episode",
            "description": "Ask a question grounded in an episode's bilingual transcript.",
            "inputSchema": {
                "type": "object",
                "required": ["reference", "question"],
                "properties": {
                    "reference": { "type": "string", "description": REF_DESC },
                    "question": { "type": "string" },
                    "reset": { "type": "boolean", "default": false }
                }
            }
        }),
        json!({
            "name": "clip_video",
            "description": "Export a video clip MP4 for a time range from either a YouTube video episode or an audio-only podcast episode (uses podcast cover + real audio).",
            "inputSchema": {
                "type": "object",
                "required": ["reference", "start", "end"],
                "properties": {
                    "reference": { "type": "string", "description": REF_DESC },
                    "start": { "type": "string", "description": "Start timestamp (seconds or mm:ss / hh:mm:ss)" },
                    "end": { "type": "string", "description": "End timestamp (seconds or mm:ss / hh:mm:ss)" },
                    "preset": { "type": "string", "enum": ["vertical", "landscape", "square", "fill"], "default": "vertical" },
                    "outputPath": { "type": "string", "description": "Optional custom .mp4 path; defaults to Downloads or clipExportDir" }
                }
            }
        }),
        json!({
            "name": "doctor",
            "description": "Inspect Subpodcast environment health: data directory, library counts, FFmpeg, installed local ASR models, and AI configuration status (never exposes API keys).",
            "inputSchema": { "type": "object", "properties": {} }
        }),
    ]
}

async fn dispatch_tool(
    ctx: &McpCtx,
    name: &str,
    args: &Value,
    rpc: &RpcOut,
    progress_token: Option<&Value>,
) -> Result<Value> {
    match name {
        "vocab_list" | "vocab_lookup" | "vocab_add" | "vocab_review_due" => vocabulary::run(ctx, name, args),
        "render_poster" => poster::render(ctx, args).await,
        "search_podcasts" => {
            let term = args["term"].as_str().unwrap_or("").trim();
            if term.is_empty() { bail!("请提供搜索词"); }
            Ok(json!(feeds::search_podcasts(term, args["country"].as_str().unwrap_or("cn")).await?))
        }
        "search_episodes" => {
            let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
            let show = resolve_local_show(&conn, args["show"].as_str().unwrap_or(""))?;
            let query = args["query"].as_str().unwrap_or("").trim().to_lowercase();
            if query.is_empty() { bail!("请提供搜索词"); }
            let mut hits = Vec::new();
            for ep in db::list_episodes(&conn, Some(&show.id), -1)? {
                if ep.title.to_lowercase().contains(&query) {
                    hits.push(json!({"episode":ep,"field":"title","time":null,"snippet":""}));
                    continue;
                }
                if let Some(notes) = ep.notes.as_deref() {
                    if let Some(found) = notes.lines().find(|line| line.to_lowercase().contains(&query)) {
                        hits.push(json!({"episode":ep,"field":"notes","time":null,"snippet":found.chars().take(300).collect::<String>()}));
                        continue;
                    }
                }
                if ep.has_transcript {
                    if let Some(tr) = db::load_transcript(&conn,&ep.id)? {
                        if let Some(line) = tr.segments.iter().find(|seg| seg.text.to_lowercase().contains(&query)) {
                            hits.push(json!({"episode":ep,"field":"transcript","time":line.start,"snippet":line.text}));
                        }
                    }
                }
            }
            Ok(json!(hits))
        }
        "extract_highlights" => {
            let ep = resolve_episode_ref(ctx, args["reference"].as_str().unwrap_or("")).await?;
            extract_highlights(ctx, &ep, args["intent"].as_str().unwrap_or("")).await
        }
        "list_shows" => list_shows_json(ctx),
        "list_episodes" => {
            let show = args["show"].as_str();
            let limit = args["limit"].as_i64().unwrap_or(20).clamp(1, 200);
            list_episodes_json(ctx, show, limit)
        }
        "find_show" => {
            let q = args["name"].as_str().unwrap_or("");
            let limit = args["limit"].as_u64().unwrap_or(6).clamp(1, 20) as usize;
            Ok(json!({ "candidates": find_show_candidates(ctx, q, limit).await? }))
        }
        "preview_show" => {
            let input = args["input"].as_str().unwrap_or("");
            let limit = args["limit"].as_u64().unwrap_or(20).clamp(1, 100) as usize;
            let (show, eps) = preview_without_subscribe(ctx, input).await?;
            let list: Vec<Value> = eps
                .into_iter()
                .take(limit)
                .map(|e| {
                    json!({
                        "id": e.id,
                        "title": e.title,
                        "published": e.published,
                        "duration": e.duration,
                        "hasVideo": e.video_id.is_some(),
                        "hasAudio": e.audio_url.is_some(),
                        "link": e.link,
                    })
                })
                .collect();
            Ok(json!({
                "show": { "id": show.id, "title": show.title, "author": show.author, "kind": show.kind, "feedUrl": show.feed_url },
                "episodes": list
            }))
        }
        "add_subscription" => {
            let input = args["input"].as_str().unwrap_or("");
            let resolved = feeds::resolve(input).await?;
            {
                let mut conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
                db::upsert_show(&conn, &resolved.show)?;
                if resolved.catalog_partial {
                    db::upsert_episodes(&mut conn, &resolved.episodes)?;
                } else {
                    db::sync_episodes(&mut conn, &resolved.show.id, &resolved.episodes)?;
                }
            }
            Ok(serde_json::to_value(resolved.show)?)
        }
        "get_episode" => {
            let ep = resolve_episode_ref(ctx, args["reference"].as_str().unwrap_or("")).await?;
            let (segments, has_guide) = {
                let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
                let segs = db::load_transcript(&conn, &ep.id)?.map(|t| t.segments.len()).unwrap_or(0);
                let guide = db::get_blob(&conn, &ep.id, "summary")?.is_some_and(|s| !s.trim().is_empty());
                (segs, guide)
            };
            let zh_count = load_zh_blob(ctx, &ep.id)
                .map(|v| v.iter().filter(|x| x.as_deref().is_some_and(|s| !s.trim().is_empty())).count())
                .unwrap_or(0);
            Ok(json!({
                "episode": ep,
                "segments": segments,
                "translatedSegments": zh_count,
                "hasGuide": has_guide,
                "canClipVideo": ep.video_id.is_some() || ep.audio_url.is_some(),
            }))
        }
        "get_transcript" => {
            let ep = resolve_episode_ref(ctx, args["reference"].as_str().unwrap_or("")).await?;
            let tr = ctx
                .db
                .lock()
                .map_err(|e| anyhow!("{e}"))?
                .load_transcript_opt(&ep.id)?
                .ok_or_else(|| anyhow!("暂无字幕，请先调用 transcribe_episode"))?;
            let zh = load_zh_blob(ctx, &ep.id);
            let fmt = args["format"].as_str().unwrap_or("txt");
            let content = args["content"].as_str().unwrap_or("bilingual");
            let text = render_transcript_text(&ep, &tr.segments, zh.as_deref(), fmt, content);
            Ok(json!({
                "episodeId": ep.id,
                "title": ep.title,
                "source": tr.source,
                "language": tr.language,
                "segments": tr.segments.len(),
                "text": text,
            }))
        }
        "transcribe_episode" => {
            let ep = resolve_episode_ref(ctx, args["reference"].as_str().unwrap_or("")).await?;
            let tr = fetch_or_transcribe(
                ctx,
                &ep,
                args["model"].as_str(),
                args["language"].as_str().unwrap_or("auto"),
                args["noShared"].as_bool().unwrap_or(false),
                args["force"].as_bool().unwrap_or(false),
                rpc,
                progress_token,
            )
            .await?;
            Ok(json!({
                "episodeId": tr.episode_id,
                "source": tr.source,
                "language": tr.language,
                "segments": tr.segments.len(),
            }))
        }
        "translate_episode" => {
            let ep = resolve_episode_ref(ctx, args["reference"].as_str().unwrap_or("")).await?;
            translate_episode_core(
                ctx,
                &ep,
                args["mode"].as_str().unwrap_or("auto"),
                args["target"].as_str().unwrap_or("zh-CN"),
                rpc,
                progress_token,
            )
            .await
        }
        "generate_guide" => {
            let ep = resolve_episode_ref(ctx, args["reference"].as_str().unwrap_or("")).await?;
            generate_guide_core(ctx, &ep, args["regenerate"].as_bool().unwrap_or(false)).await
        }
        "ask_episode" => {
            let ep = resolve_episode_ref(ctx, args["reference"].as_str().unwrap_or("")).await?;
            ask_episode_core(
                ctx,
                &ep,
                args["question"].as_str().unwrap_or(""),
                args["reset"].as_bool().unwrap_or(false),
            )
            .await
        }
        "clip_video" => {
            let ep = resolve_episode_ref(ctx, args["reference"].as_str().unwrap_or("")).await?;
            let start = parse_timestamp(args["start"].as_str().unwrap_or(""))?;
            let end = parse_timestamp(args["end"].as_str().unwrap_or(""))?;
            clip_video_core(
                ctx,
                &ep,
                start,
                end,
                args["preset"].as_str().unwrap_or("vertical"),
                args["outputPath"].as_str(),
                rpc,
                progress_token,
            )
            .await
        }
        "doctor" => run_doctor(ctx),
        other => bail!("未知 MCP 工具：{other}"),
    }
}

// ============================================================================
// JSON-RPC 2.0 分发与 stdio 主循环
// ============================================================================

async fn handle_rpc(ctx: &McpCtx, req: &Value, rpc: &RpcOut) -> Option<Value> {
    let method = req["method"].as_str().unwrap_or("");
    let id = req.get("id").cloned()?;
    if method == "notifications/initialized" || method.starts_with("notifications/") {
        return None;
    }

    let resp = match method {
        "initialize" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {}, "resources": {} },
                "serverInfo": {
                    "name": "subpodcast",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        }),
        "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        "tools/list" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "tools": tool_definitions() }
        }),
        "tools/call" => {
            let name = req["params"]["name"].as_str().unwrap_or("");
            let args = &req["params"]["arguments"];
            let progress_token = req["params"]["_meta"].get("progressToken");
            match dispatch_tool(ctx, name, args, rpc, progress_token).await {
                Ok(val) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&val).unwrap_or_default() }],
                        "isError": false
                    }
                }),
                Err(err) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": format!("{err:#}") }],
                        "isError": true
                    }
                }),
            }
        }
        "resources/list" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "resources": [
                    { "uri": "subpodcast://shows", "name": "Subscriptions", "mimeType": "application/json" },
                    { "uri": "subpodcast://vocab", "name": "Vocabulary Book", "mimeType": "application/json" },
                    { "uri": "subpodcast://stats", "name": "Listening Stats", "mimeType": "application/json" },
                    { "uri": "subpodcast://config", "name": "Health & Config Summary", "mimeType": "application/json" }
                ]
            }
        }),
        "resources/read" => {
            let uri = req["params"]["uri"].as_str().unwrap_or("");
            let payload: Result<Value> = match uri {
                "subpodcast://shows" => list_shows_json(ctx),
                "subpodcast://vocab" => vocabulary::run(ctx, "vocab_list", &Value::Null),
                "subpodcast://stats" => {
                    let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"));
                    conn.and_then(|c| db::listens_since(&c, "1970-01-01").map(Value::Array))
                }
                "subpodcast://config" => run_doctor(ctx),
                _ => Err(anyhow!("未知资源：{uri}")),
            };
            match payload {
                Ok(val) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "contents": [{
                            "uri": uri,
                            "mimeType": "application/json",
                            "text": serde_json::to_string_pretty(&val).unwrap_or_default()
                        }]
                    }
                }),
                Err(err) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32602, "message": format!("{err:#}") }
                }),
            }
        }
        other => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("Method not found: {other}") }
        }),
    };
    Some(resp)
}

/// 启动 MCP over stdio 主循环（逐行读取 JSON-RPC 2.0 请求，写回响应）。
pub async fn run_stdio_mcp(ctx: &McpCtx) -> Result<()> {
    let rpc = RpcOut::new();
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(err) => {
                let resp = json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": { "code": -32700, "message": format!("Parse error: {err}") }
                });
                rpc.send(&resp)?;
                continue;
            }
        };
        if let Some(resp) = handle_rpc(ctx, &req, &rpc).await {
            rpc.send(&resp)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_ctx() -> (McpCtx, PathBuf) {
        let dir = std::env::temp_dir().join(format!("subpodcast-mcp-{}", uuid::Uuid::new_v4().simple()));
        let ctx = McpCtx::open(Some(dir.clone()), None).unwrap();
        (ctx, dir)
    }

    #[test]
    fn timestamp_and_selector_parsing() {
        assert_eq!(parse_timestamp("42").unwrap(), 42.0);
        assert_eq!(parse_timestamp("01:30").unwrap(), 90.0);
        assert_eq!(parse_timestamp("1:02:03.5").unwrap(), 3723.5);
        assert!(parse_timestamp("-5").is_err());
        assert!(parse_timestamp("abc").is_err());

        assert_eq!(split_show_selector("Lex Fridman:latest"), ("Lex Fridman", Some(0)));
        assert_eq!(split_show_selector("硅谷101:@2"), ("硅谷101", Some(1)));
        assert_eq!(split_show_selector("硅谷101"), ("硅谷101", None));
    }

    #[test]
    fn output_path_guard_rejects_traversal_and_system_dirs() {
        assert!(validate_output_path("../escape.mp4").is_err());
        #[cfg(unix)]
        assert!(validate_output_path("/etc/evil.mp4").is_err());
        assert!(validate_output_path("/tmp/subpodcast-clip.mp4").is_ok());
    }

    #[test]
    fn transcript_rendering_formats() {
        let ep = Episode {
            id: "ep1".into(),
            show_id: "s1".into(),
            guid: "g1".into(),
            title: "Test Ep".into(),
            published: None,
            duration: Some(10.0),
            audio_url: None,
            video_id: None,
            link: Some("https://example.com".into()),
            cover: None,
            notes: None,
            transcript_url: None,
            transcript_type: None,
            deep: false,
            progress: 0.0,
            has_transcript: true,
            show_title: Some("Show".into()),
        };
        let segs = vec![Segment { start: 1.5, end: 4.0, text: "Hello world".into() }];
        let zh = vec![Some("你好世界".into())];
        let srt = render_transcript_text(&ep, &segs, Some(&zh), "srt", "bilingual");
        assert!(srt.contains("00:00:01,500 --> 00:00:04,000"));
        assert!(srt.contains("你好世界\nHello world"));
        let vtt = render_transcript_text(&ep, &segs, Some(&zh), "vtt", "translation");
        assert!(vtt.starts_with("WEBVTT") && vtt.contains("你好世界") && !vtt.contains("Hello world"));
        let lrc = render_transcript_text(&ep, &segs, None, "lrc", "original");
        assert!(lrc.contains("[00:01.50]Hello world"));
    }

    #[tokio::test]
    async fn mcp_handshake_tools_and_resources() {
        let (ctx, dir) = temp_ctx();
        assert!(dir.join(db::DB_FILE).exists());
        let rpc = RpcOut::new();

        let init = handle_rpc(&ctx, &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }), &rpc)
            .await
            .unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(init["result"]["serverInfo"]["name"], "subpodcast");

        let tools = handle_rpc(&ctx, &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }), &rpc)
            .await
            .unwrap();
        let arr = tools["result"]["tools"].as_array().unwrap();
        assert!(arr.iter().any(|t| t["name"] == "clip_video"));
        assert!(arr.iter().any(|t| t["name"] == "transcribe_episode"));
        assert!(arr.iter().any(|t| t["name"] == "find_show"));

        let doc = handle_rpc(
            &ctx,
            &json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "doctor", "arguments": {} } }),
            &rpc,
        )
        .await
        .unwrap();
        assert_eq!(doc["result"]["isError"], false);
        assert!(doc["result"]["content"][0]["text"].as_str().unwrap().contains("\"ok\": true"));

        let res = handle_rpc(
            &ctx,
            &json!({ "jsonrpc": "2.0", "id": 4, "method": "resources/read", "params": { "uri": "subpodcast://shows" } }),
            &rpc,
        )
        .await
        .unwrap();
        assert_eq!(res["result"]["contents"][0]["mimeType"], "application/json");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
