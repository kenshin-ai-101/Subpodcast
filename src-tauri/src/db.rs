/**
 * [INPUT]: 依赖 model、rusqlite
 * [OUTPUT]: shows/episodes/transcripts/blobs/settings 的读写
 * [POS]: 本机持久化唯一入口；WAL 模式
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
         CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    )?;
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
            "INSERT INTO episodes(id,show_id,guid,title,published,duration,audio_url,video_id,link,cover,notes,transcript_url,transcript_type)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title, published=excluded.published,
             duration=COALESCE(excluded.duration, episodes.duration),
             audio_url=COALESCE(excluded.audio_url, episodes.audio_url),
             link=excluded.link, cover=COALESCE(excluded.cover, episodes.cover),
             notes=COALESCE(excluded.notes, episodes.notes),
             transcript_url=excluded.transcript_url, transcript_type=excluded.transcript_type",
        )?;
        for e in eps {
            st.execute(params![
                e.id, e.show_id, e.guid, e.title, e.published, e.duration, e.audio_url, e.video_id,
                e.link, e.cover, e.notes, e.transcript_url, e.transcript_type
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
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
        unplayed: r.get(9).unwrap_or(0),
    })
}

pub fn list_shows(conn: &Connection) -> Result<Vec<Show>> {
    let mut st = conn.prepare(
        "SELECT s.id,s.kind,s.title,s.author,s.cover,s.feed_url,s.link,s.description,s.updated_at,
         (SELECT COUNT(*) FROM episodes e WHERE e.show_id=s.id AND e.progress=0)
         FROM shows s WHERE s.kind != 'single' ORDER BY s.title COLLATE NOCASE",
    )?;
    let rows = st.query_map([], show_from)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_show(conn: &Connection, id: &str) -> Result<Option<Show>> {
    Ok(conn
        .query_row(
            "SELECT id,kind,title,author,cover,feed_url,link,description,updated_at,0 FROM shows WHERE id=?1",
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
        progress: r.get(13)?,
        has_transcript: r.get(14)?,
        show_title: r.get(15)?,
    })
}

const EP_COLS: &str = "e.id,e.show_id,e.guid,e.title,e.published,e.duration,e.audio_url,e.video_id,e.link,e.cover,e.notes,e.transcript_url,e.transcript_type,e.progress,
    EXISTS(SELECT 1 FROM transcripts t WHERE t.episode_id=e.id), s.title";

pub fn list_episodes(conn: &Connection, show_id: Option<&str>, limit: i64) -> Result<Vec<Episode>> {
    if let Some(sid) = show_id {
        let mut st = conn.prepare(&format!(
            "SELECT {EP_COLS} FROM episodes e JOIN shows s ON s.id=e.show_id WHERE e.show_id=?1 ORDER BY e.published DESC LIMIT ?2"
        ))?;
        let rows = st.query_map(params![sid, limit], episode_from)?.collect::<rusqlite::Result<_>>()?;
        return Ok(rows);
    }
    let mut st = conn.prepare(&format!(
        "SELECT {EP_COLS} FROM episodes e JOIN shows s ON s.id=e.show_id ORDER BY e.published DESC LIMIT ?1"
    ))?;
    let rows = st.query_map([limit], episode_from)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get_episode(conn: &Connection, id: &str) -> Result<Option<Episode>> {
    Ok(conn
        .query_row(
            &format!("SELECT {EP_COLS} FROM episodes e JOIN shows s ON s.id=e.show_id WHERE e.id=?1"),
            [id],
            episode_from,
        )
        .optional()?)
}

pub fn set_progress(conn: &Connection, id: &str, progress: f64) -> Result<()> {
    conn.execute("UPDATE episodes SET progress=?1 WHERE id=?2", params![progress, id])?;
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
