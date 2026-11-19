/**
 * [INPUT]: 依赖 model、rusqlite
 * [OUTPUT]: shows/episodes/transcripts/blobs/settings/tr_cache/listens；sync_episodes / dedupe_show_episodes；list_shows.episode_count
 * [POS]: 本机持久化唯一入口；刷新用 sync 删孤儿；详情列表按期号键去重合并进度；侧栏数量=入库单集总数
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use crate::model::*;
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         PRAGMA busy_timeout=5000;
         CREATE TABLE IF NOT EXISTS shows(
            id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, author TEXT, cover TEXT,
            feed_url TEXT NOT NULL, link TEXT, description TEXT, updated_at INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS episodes(
            id TEXT PRIMARY KEY, show_id TEXT NOT NULL, guid TEXT NOT NULL, title TEXT NOT NULL,
            published INTEGER, duration REAL, audio_url TEXT, video_id TEXT, link TEXT, cover TEXT, notes TEXT,
            transcript_url TEXT, transcript_type TEXT, progress REAL NOT NULL DEFAULT 0);
         CREATE INDEX IF NOT EXISTS episodes_show ON episodes(show_id, published DESC);
         CREATE TABLE IF NOT EXISTS transcripts(
            episode_id TEXT PRIMARY KEY, source TEXT NOT NULL, language TEXT NOT NULL, segments TEXT NOT NULL, created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS blobs(
            episode_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(episode_id, kind));
         CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS tr_cache(key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS listens(
            day TEXT NOT NULL, hour INTEGER NOT NULL, episode_id TEXT NOT NULL, show_id TEXT NOT NULL,
            seconds REAL NOT NULL, translated INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(day, hour, episode_id));",
    )?;
    // 旧库补 deep 列；原精读站单集回填为 1
    let has_deep: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('episodes') WHERE name='deep'",
        [],
        |r| r.get::<_, i64>(0),
    )? > 0;
    if !has_deep {
        conn.execute_batch(
            "ALTER TABLE episodes ADD COLUMN deep INTEGER NOT NULL DEFAULT 0;
             UPDATE episodes SET deep=1 WHERE transcript_type='qiaomu';",
        )?;
    }
    // 最近收听时间：首页「继续收听」按此排序
    let has_heard: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('episodes') WHERE name='heard_at'",
        [],
        |r| r.get::<_, i64>(0),
    )? > 0;
    if !has_heard {
        conn.execute_batch("ALTER TABLE episodes ADD COLUMN heard_at INTEGER NOT NULL DEFAULT 0;")?;
    }
    Ok(conn)
}

pub fn upsert_show(conn: &Connection, s: &Show) -> Result<()> {
    conn.execute(
        "INSERT INTO shows(id,kind,title,author,cover,feed_url,link,description,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, author=excluded.author,
         cover=COALESCE(excluded.cover, shows.cover), link=excluded.link,
         description=excluded.description, updated_at=excluded.updated_at",
        params![s.id, s.kind, s.title, s.author, s.cover, s.feed_url, s.link, s.description, s.updated_at],
    )?;
    Ok(())
}

pub fn upsert_episodes(conn: &mut Connection, eps: &[Episode]) -> Result<()> {
    let tx = conn.transaction()?;
    {
        let mut st = tx.prepare(
            "INSERT INTO episodes(id,show_id,guid,title,published,duration,audio_url,video_id,link,cover,notes,transcript_url,transcript_type,deep)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title, published=excluded.published,
             duration=COALESCE(excluded.duration, episodes.duration),
             audio_url=COALESCE(excluded.audio_url, episodes.audio_url),
             video_id=COALESCE(NULLIF(episodes.video_id, ''), excluded.video_id),
             link=excluded.link, cover=COALESCE(excluded.cover, episodes.cover),
             notes=COALESCE(excluded.notes, episodes.notes),
             transcript_url=excluded.transcript_url, transcript_type=excluded.transcript_type,
             deep=excluded.deep",
        )?;
        for e in eps {
            st.execute(params![
                e.id, e.show_id, e.guid, e.title, e.published, e.duration, e.audio_url, e.video_id,
                e.link, e.cover, e.notes, e.transcript_url, e.transcript_type, e.deep as i64
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// 写入本批单集后删掉同节目下被换 guid 的旧行（先按标题把进度/字幕吸到新行）。
pub fn sync_episodes(conn: &mut Connection, show_id: &str, eps: &[Episode]) -> Result<()> {
    upsert_episodes(conn, eps)?;
    let keep: std::collections::HashSet<&str> = eps.iter().map(|e| e.id.as_str()).collect();
    let by_key: std::collections::HashMap<String, &Episode> = {
        let mut m = std::collections::HashMap::new();
        for e in eps {
            m.entry(crate::feeds::episode_dedupe_key(&e.title))
                .or_insert(e);
        }
        m
    };
    let orphans: Vec<(String, String, f64, bool)> = {
        let mut st = conn.prepare(
            "SELECT e.id, e.title, e.progress,
                    EXISTS(SELECT 1 FROM transcripts t WHERE t.episode_id=e.id)
             FROM episodes e WHERE e.show_id=?1",
        )?;
        let mapped: Vec<_> = st
            .query_map([show_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, f64>(2)?,
                    r.get::<_, i64>(3)? != 0,
                ))
            })?
            .collect();
        mapped
            .into_iter()
            .filter_map(|r| r.ok())
            .filter(|(id, _, _, _)| !keep.contains(id.as_str()))
            .collect()
    };
    for (id, title, progress, has_tr) in orphans {
        let key = crate::feeds::episode_dedupe_key(&title);
        if let Some(keeper) = by_key.get(&key) {
            absorb_episode(conn, &keeper.id, &id)?;
        } else if progress > 0.01 || has_tr {
            // 已听/已有字幕但不在本批（窗口外）：保留，避免误删
            continue;
        } else {
            delete_episode_cascade(conn, &id)?;
        }
    }
    dedupe_show_episodes(conn, show_id)?;
    Ok(())
}

fn delete_episode_cascade(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM transcripts WHERE episode_id=?1", [id])?;
    conn.execute("DELETE FROM blobs WHERE episode_id=?1", [id])?;
    conn.execute("DELETE FROM episodes WHERE id=?1", [id])?;
    Ok(())
}

/// 把 loser 的进度/字幕/blobs 并入 keeper，再删 loser。
fn absorb_episode(conn: &Connection, keeper_id: &str, loser_id: &str) -> Result<()> {
    if keeper_id == loser_id {
        return Ok(());
    }
    let (kp, kh, k_vid, k_audio, k_cover): (f64, i64, Option<String>, Option<String>, Option<String>) =
        conn.query_row(
            "SELECT progress, heard_at, video_id, audio_url, cover FROM episodes WHERE id=?1",
            [keeper_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )?;
    let (lp, lh, l_vid, l_audio, l_cover): (f64, i64, Option<String>, Option<String>, Option<String>) =
        conn.query_row(
            "SELECT progress, heard_at, video_id, audio_url, cover FROM episodes WHERE id=?1",
            [loser_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )?;
    let vid = k_vid.filter(|v| !v.is_empty()).or_else(|| l_vid.filter(|v| !v.is_empty()));
    let audio = k_audio
        .filter(|v| !v.is_empty())
        .or_else(|| l_audio.filter(|v| !v.is_empty()));
    let cover = k_cover
        .filter(|v| !v.is_empty())
        .or_else(|| l_cover.filter(|v| !v.is_empty()));
    conn.execute(
        "UPDATE episodes SET progress=?1, heard_at=?2, video_id=?3, audio_url=?4, cover=?5 WHERE id=?6",
        params![kp.max(lp), kh.max(lh), vid, audio, cover, keeper_id],
    )?;
    let keeper_has_tr: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM transcripts WHERE episode_id=?1)",
        [keeper_id],
        |r| r.get::<_, i64>(0),
    )? != 0;
    if !keeper_has_tr {
        conn.execute(
            "UPDATE transcripts SET episode_id=?1 WHERE episode_id=?2",
            params![keeper_id, loser_id],
        )?;
    }
    let kinds: Vec<(String, String)> = {
        let mut st = conn.prepare("SELECT kind, data FROM blobs WHERE episode_id=?1")?;
        let rows: Vec<_> = st
            .query_map([loser_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect();
        rows.into_iter().filter_map(|r| r.ok()).collect()
    };
    for (kind, data) in kinds {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM blobs WHERE episode_id=?1 AND kind=?2)",
            params![keeper_id, &kind],
            |r| r.get::<_, i64>(0),
        )? != 0;
        if !exists {
            conn.execute(
                "INSERT INTO blobs(episode_id,kind,data) VALUES(?1,?2,?3)",
                params![keeper_id, kind, data],
            )?;
        }
    }
    delete_episode_cascade(conn, loser_id)?;
    Ok(())
}

/// 同节目同标题（期号键）多行时只留一条：进度高 / 有字幕 / 有视频 优先。
pub fn dedupe_show_episodes(conn: &Connection, show_id: &str) -> Result<u32> {
    #[derive(Clone)]
    struct Row {
        id: String,
        title: String,
        progress: f64,
        has_tr: bool,
        has_vid: bool,
        has_audio: bool,
        published: i64,
    }
    let rows: Vec<Row> = {
        let mut st = conn.prepare(
            "SELECT e.id, e.title, e.progress,
                    EXISTS(SELECT 1 FROM transcripts t WHERE t.episode_id=e.id),
                    COALESCE(e.video_id,''), COALESCE(e.audio_url,''), COALESCE(e.published,0)
             FROM episodes e WHERE e.show_id=?1",
        )?;
        let mapped: Vec<_> = st
            .query_map([show_id], |r| {
                let vid: String = r.get(4)?;
                let audio: String = r.get(5)?;
                Ok(Row {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    progress: r.get(2)?,
                    has_tr: r.get::<_, i64>(3)? != 0,
                    has_vid: !vid.is_empty(),
                    has_audio: !audio.is_empty(),
                    published: r.get(6)?,
                })
            })?
            .collect();
        mapped.into_iter().filter_map(|r| r.ok()).collect()
    };
    use std::collections::HashMap;
    let mut groups: HashMap<String, Vec<Row>> = HashMap::new();
    for r in rows {
        groups
            .entry(crate::feeds::episode_dedupe_key(&r.title))
            .or_default()
            .push(r);
    }
    let mut removed = 0u32;
    for (_, mut g) in groups {
        if g.len() < 2 {
            continue;
        }
        g.sort_by(|a, b| {
            b.progress
                .partial_cmp(&a.progress)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.has_tr.cmp(&a.has_tr))
                .then_with(|| b.has_vid.cmp(&a.has_vid))
                .then_with(|| b.has_audio.cmp(&a.has_audio))
                .then_with(|| b.published.cmp(&a.published))
        });
        let keeper = g[0].id.clone();
        for loser in g.into_iter().skip(1) {
            absorb_episode(conn, &keeper, &loser.id)?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn show_from(r: &rusqlite::Row) -> rusqlite::Result<Show> {
    Ok(Show {
        id: r.get(0)?,
        kind: r.get(1)?,
        title: r.get(2)?,
        author: r.get(3)?,
        cover: r.get(4)?,
        feed_url: r.get(5)?,
        link: r.get(6)?,
        description: r.get(7)?,
        updated_at: r.get(8)?,
        episode_count: r.get(9).unwrap_or(0),
    })
}

pub fn list_shows(conn: &Connection) -> Result<Vec<Show>> {
    let mut st = conn.prepare(
        "SELECT s.id,s.kind,s.title,s.author,s.cover,s.feed_url,s.link,s.description,s.updated_at,
         (SELECT COUNT(*) FROM episodes e WHERE e.show_id=s.id)
         FROM shows s WHERE s.kind != 'single' ORDER BY s.title COLLATE NOCASE",
    )?;
    let rows = st.query_map([], show_from)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_show(conn: &Connection, id: &str) -> Result<Option<Show>> {
    Ok(conn
        .query_row(
            "SELECT id,kind,title,author,cover,feed_url,link,description,updated_at,
             (SELECT COUNT(*) FROM episodes e WHERE e.show_id=shows.id)
             FROM shows WHERE id=?1",
            [id],
            show_from,
        )
        .optional()?)
}

pub fn delete_show(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM episodes WHERE show_id=?1 AND id NOT IN (SELECT episode_id FROM transcripts)",
        [id],
    )?;
    conn.execute("DELETE FROM shows WHERE id=?1", [id])?;
    Ok(())
}

fn episode_from(r: &rusqlite::Row) -> rusqlite::Result<Episode> {
    Ok(Episode {
        id: r.get(0)?,
        show_id: r.get(1)?,
        guid: r.get(2)?,
        title: r.get(3)?,
        published: r.get(4)?,
        duration: r.get(5)?,
        audio_url: r.get(6)?,
        video_id: r.get(7)?,
        link: r.get(8)?,
        cover: r.get(9)?,
        notes: r.get(10)?,
        transcript_url: r.get(11)?,
        transcript_type: r.get(12)?,
        deep: r.get::<_, i64>(13)? != 0,
        progress: r.get(14)?,
        has_transcript: r.get(15)?,
        show_title: r.get(16)?,
    })
}

const EP_COLS: &str = "e.id,e.show_id,e.guid,e.title,e.published,e.duration,e.audio_url,e.video_id,e.link,e.cover,e.notes,e.transcript_url,e.transcript_type,e.deep,e.progress,
    EXISTS(SELECT 1 FROM transcripts t WHERE t.episode_id=e.id), s.title";

pub fn list_episodes(conn: &Connection, show_id: Option<&str>, limit: i64) -> Result<Vec<Episode>> {
    if let Some(sid) = show_id {
        // 详情页打开即清掉跨源重复行（Anchor/小宇宙/乔木 guid 不同）
        let _ = dedupe_show_episodes(conn, sid);
        let mut st = conn.prepare(&format!(
            "SELECT {EP_COLS} FROM episodes e LEFT JOIN shows s ON s.id=e.show_id WHERE e.show_id=?1 ORDER BY e.published DESC LIMIT ?2"
        ))?;
        let rows = st.query_map(params![sid, limit], episode_from)?.collect::<rusqlite::Result<_>>()?;
        return Ok(rows);
    }
    let mut st = conn.prepare(&format!(
        "SELECT {EP_COLS} FROM episodes e LEFT JOIN shows s ON s.id=e.show_id ORDER BY e.published DESC LIMIT ?1"
    ))?;
    let rows = st.query_map([limit], episode_from)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// 首页「最近」：优先按最近收听时间；有进度 / 字幕 / 单集才入列。
pub fn recent_episodes(conn: &Connection, limit: i64) -> Result<Vec<Episode>> {
    let sql = format!(
        "SELECT {EP_COLS} FROM episodes e LEFT JOIN shows s ON s.id=e.show_id
         WHERE e.progress > 0 OR EXISTS(SELECT 1 FROM transcripts t WHERE t.episode_id=e.id) OR s.kind='single'
         ORDER BY e.heard_at DESC, e.rowid DESC LIMIT ?1"
    );
    let mut st = conn.prepare(&sql)?;
    let rows = st.query_map(params![limit], episode_from)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_episode(conn: &Connection, id: &str) -> Result<Option<Episode>> {
    Ok(conn
        .query_row(
            &format!("SELECT {EP_COLS} FROM episodes e LEFT JOIN shows s ON s.id=e.show_id WHERE e.id=?1"),
            [id],
            episode_from,
        )
        .optional()?)
}

pub fn set_progress(conn: &Connection, id: &str, progress: f64) -> Result<()> {
    conn.execute(
        "UPDATE episodes SET progress=?1, heard_at=?2 WHERE id=?3",
        params![progress.max(0.01), now_ms(), id],
    )?;
    Ok(())
}

pub fn set_audio_url(conn: &Connection, id: &str, audio_url: &str) -> Result<()> {
    conn.execute("UPDATE episodes SET audio_url=?1 WHERE id=?2", params![audio_url, id])?;
    Ok(())
}

pub fn set_video_id(conn: &Connection, id: &str, video_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE episodes SET video_id=?1,
         cover=COALESCE(NULLIF(cover, ''), ?2) WHERE id=?3",
        params![
            video_id,
            format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"),
            id
        ],
    )?;
    Ok(())
}

pub fn save_transcript(conn: &Connection, t: &Transcript) -> Result<()> {
    let segs = serde_json::to_string(&t.segments)?;
    conn.execute(
        "INSERT INTO transcripts(episode_id,source,language,segments,created_at) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(episode_id) DO UPDATE SET source=excluded.source, language=excluded.language, segments=excluded.segments, created_at=excluded.created_at",
        params![t.episode_id, t.source, t.language, segs, now_ms()],
    )?;
    Ok(())
}

pub fn load_transcript(conn: &Connection, episode_id: &str) -> Result<Option<Transcript>> {
    Ok(conn
        .query_row(
            "SELECT episode_id,source,language,segments FROM transcripts WHERE episode_id=?1",
            [episode_id],
            |r| {
                let segs: String = r.get(3)?;
                Ok(Transcript {
                    episode_id: r.get(0)?,
                    source: r.get(1)?,
                    language: r.get(2)?,
                    segments: serde_json::from_str(&segs).unwrap_or_default(),
                })
            },
        )
        .optional()?)
}

pub fn get_blob(conn: &Connection, episode_id: &str, kind: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT data FROM blobs WHERE episode_id=?1 AND kind=?2",
            params![episode_id, kind],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn set_blob(conn: &Connection, episode_id: &str, kind: &str, data: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO blobs(episode_id,kind,data) VALUES(?1,?2,?3)
         ON CONFLICT(episode_id,kind) DO UPDATE SET data=excluded.data",
        params![episode_id, kind, data],
    )?;
    Ok(())
}

pub fn tr_get(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM tr_cache WHERE key=?1", [key], |r| r.get(0))
        .optional()?)
}

pub fn tr_put(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO tr_cache(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0))
        .optional()?)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// 按本地日/小时累计收听时长（单次最多 120 秒）；translated 取或。
pub fn log_listen(
    conn: &Connection,
    episode_id: &str,
    show_id: &str,
    seconds: f64,
    translated: bool,
) -> Result<()> {
    let now = chrono::Local::now();
    let day = now.format("%Y-%m-%d").to_string();
    let hour: i64 = now.format("%H").to_string().parse().unwrap_or(0);
    let secs = seconds.clamp(0.0, 120.0);
    conn.execute(
        "INSERT INTO listens(day,hour,episode_id,show_id,seconds,translated) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(day,hour,episode_id) DO UPDATE SET
         seconds = listens.seconds + excluded.seconds,
         translated = MAX(listens.translated, excluded.translated)",
        params![day, hour, episode_id, show_id, secs, translated as i64],
    )?;
    Ok(())
}

/// 自某日起的收听明细（camelCase JSON，含节目/单集展示字段）。
pub fn listens_since(conn: &Connection, since: &str) -> Result<Vec<serde_json::Value>> {
    let mut st = conn.prepare(
        "SELECT l.day, l.hour, l.episode_id, l.show_id, l.seconds, l.translated,
                COALESCE(s.title,''), COALESCE(s.kind,''), COALESCE(s.cover,''),
                COALESCE(e.title,''), COALESCE(e.video_id,''),
                COALESCE(e.duration,0), COALESCE(e.progress,0), COALESCE(e.published,0)
         FROM listens l
         LEFT JOIN shows s ON s.id = l.show_id
         LEFT JOIN episodes e ON e.id = l.episode_id
         WHERE l.day >= ?1
         ORDER BY l.day, l.hour",
    )?;
    let rows = st.query_map([since], |r| {
        let video_id: String = r.get(10)?;
        Ok(serde_json::json!({
            "day": r.get::<_, String>(0)?,
            "hour": r.get::<_, i64>(1)?,
            "episodeId": r.get::<_, String>(2)?,
            "showId": r.get::<_, String>(3)?,
            "seconds": r.get::<_, f64>(4)?,
            "translated": r.get::<_, i64>(5)? != 0,
            "showTitle": r.get::<_, String>(6)?,
            "kind": r.get::<_, String>(7)?,
            "cover": r.get::<_, String>(8)?,
            "episodeTitle": r.get::<_, String>(9)?,
            "video": !video_id.is_empty(),
            "duration": r.get::<_, f64>(11)?,
            "progress": r.get::<_, f64>(12)?,
            "published": r.get::<_, i64>(13)?,
        }))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feeds::episode_dedupe_key;

    #[test]
    fn dedupe_merges_same_episode_number() {
        let path = std::env::temp_dir().join(format!("subpodcast-dedupe-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let conn = open(&path).unwrap();
        conn.execute(
            "INSERT INTO shows(id,kind,title,feed_url,updated_at) VALUES('s','podcast','T','http://x',1)",
            [],
        )
        .unwrap();
        for (id, guid) in [("a", "g1"), ("b", "g2"), ("c", "g3")] {
            conn.execute(
                "INSERT INTO episodes(id,show_id,guid,title,progress,deep,heard_at) VALUES(?1,'s',?2,'#009 hello',?3,0,0)",
                params![id, guid, if id == "b" { 12.0 } else { 0.0 }],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO transcripts(episode_id,source,language,segments,created_at) VALUES('a','x','en','[]',1)",
            [],
        )
        .unwrap();
        assert_eq!(episode_dedupe_key("#009 hello"), "#9");
        let n = dedupe_show_episodes(&conn, "s").unwrap();
        assert_eq!(n, 2);
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM episodes WHERE show_id='s'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 1);
        let (id, progress): (String, f64) = conn
            .query_row("SELECT id, progress FROM episodes WHERE show_id='s'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(id, "b"); // highest progress wins
        assert!((progress - 12.0).abs() < 0.01);
        let has_tr: i64 = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM transcripts WHERE episode_id='b')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_tr, 1); // transcript absorbed from a
        let _ = std::fs::remove_file(&path);
    }

}
