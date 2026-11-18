/**
 * [INPUT]: 依赖 net、llm（可选）
 * [OUTPUT]: Google 翻译批次；LLM 翻译批次
 * [POS]: 字幕中文化引擎，前端按段调用
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use crate::llm::{self, ChatMessage, LlmConfig};
use crate::net;
use anyhow::{anyhow, Result};
use serde_json::Value;

/// 免费谷歌翻译（批量 texts）。失败时返回错误，由前端降级提示。
pub async fn google_batch(texts: &[String], target: &str) -> Result<Vec<String>> {
    if texts.is_empty() {
        return Ok(vec![]);
    }
    let joined = texts.join("\n");
    let url = format!(
        "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl={}&dt=t&q={}",
        urlencoding::encode(target),
        urlencoding::encode(&joined)
    );
    let body = net::get_text(&url).await?;
    let v: Value = serde_json::from_str(&body)?;
    let mut translated = String::new();
    if let Some(arr) = v[0].as_array() {
        for chunk in arr {
            if let Some(s) = chunk[0].as_str() {
                translated.push_str(s);
            }
        }
    }
    let lines: Vec<String> = translated.lines().map(|s| s.to_string()).collect();
    // 行数可能因换行漂移；按索引尽量对齐，不够则空串
    Ok((0..texts.len())
        .map(|i| lines.get(i).cloned().unwrap_or_default())
        .collect())
}

/// LLM 翻译：要求严格 JSON 数组，与输入等长。
pub async fn llm_batch(cfg: &LlmConfig, texts: &[String], target: &str) -> Result<Vec<String>> {
    let payload = serde_json::to_string(texts)?;
    let system = format!(
        "You translate podcast subtitle lines into {target}. \
         Keep meaning, tone and proper nouns. \
         Return ONLY a JSON array of strings, same length and order as the input array. No markdown."
    );
    let messages = vec![
        ChatMessage {
            role: "system".into(),
            content: system,
        },
        ChatMessage {
            role: "user".into(),
            content: payload,
        },
    ];
    let reply = llm::chat_once(cfg, &messages).await?;
    let trimmed = reply.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    let arr: Vec<String> = serde_json::from_str(trimmed).map_err(|e| anyhow!("翻译 JSON 解析失败: {e}"))?;
    if arr.len() != texts.len() {
        return Err(anyhow!("翻译行数不匹配：期望 {} 得到 {}", texts.len(), arr.len()));
    }
    Ok(arr)
}
