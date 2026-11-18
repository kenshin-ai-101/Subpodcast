/**
 * [INPUT]: 无外部 crate 业务依赖，仅 serde
 * [OUTPUT]: Show / Episode / Segment / Transcript 领域模型与短哈希工具
 * [POS]: 数据契约中枢，被 db、feeds、captions、前端 JSON 共同消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Show {
    pub id: String,
    /// youtube | podcast | xiaoyuzhou | qiaomu | single
    pub kind: String,
    pub title: String,
    pub author: Option<String>,
    pub cover: Option<String>,
    pub feed_url: String,
    pub link: Option<String>,
    pub description: Option<String>,
    pub updated_at: i64,
    #[serde(default)]
    pub unplayed: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub id: String,
    pub show_id: String,
    pub guid: String,
    pub title: String,
    pub published: Option<i64>,
    pub duration: Option<f64>,
    pub audio_url: Option<String>,
    pub video_id: Option<String>,
    pub link: Option<String>,
    pub cover: Option<String>,
    pub notes: Option<String>,
    pub transcript_url: Option<String>,
    pub transcript_type: Option<String>,
    #[serde(default)]
    pub progress: f64,
    #[serde(default)]
    pub has_transcript: bool,
    #[serde(default)]
    pub show_title: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub episode_id: String,
    /// youtube | youtube-auto | rss | cloud
    pub source: String,
    pub language: String,
    pub segments: Vec<Segment>,
}

pub fn short_hash(text: &str, len: usize) -> String {
    use sha1::{Digest, Sha1};
    let digest = Sha1::digest(text.as_bytes());
    hex::encode(digest)[..len.min(40)].to_string()
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
