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

/// 免费谷歌翻译（批量 texts）。改用 POST 表单防 GET URL 超长（414），并用行内换行清洗防错位。
pub async fn google_batch(texts: &[String], target: &str) -> Result<Vec<String>> {
    if texts.is_empty() {
        return Ok(vec![]);
    }
    let sanitized: Vec<String> = texts
        .iter()
        .map(|t| t.replace(['\r', '\n'], " ").trim().to_string())
        .collect();
    let joined = sanitized.join("\n");
    let url = format!(
        "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl={}&dt=t",
        urlencoding::encode(target),
    );
    let resp = net::client()
        .post(&url)
        .form(&[("q", joined.as_str())])
        .send()
        .await
        .map_err(|e| anyhow!("谷歌翻译连接失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!("谷歌翻译返回 HTTP {}", resp.status()));
    }
    let body = resp.text().await?;
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
    Ok((0..texts.len())
        .map(|i| lines.get(i).cloned().unwrap_or_default())
        .collect())
}

fn parse_string_array(reply: &str, expected: usize) -> Result<Vec<String>> {
    let trimmed = reply
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let arr: Vec<String> =
        serde_json::from_str(trimmed).map_err(|e| anyhow!("翻译 JSON 解析失败: {e}"))?;
    if arr.len() != expected {
        return Err(anyhow!("翻译行数不匹配：期望 {expected} 得到 {}", arr.len()));
    }
    Ok(arr)
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
    parse_string_array(&reply, texts.len())
}

/// 支持 quality="best"（二阶段精翻：先直译再结合上下文润色口语与术语一致性）；润色失败时优雅回退初译。
pub async fn llm_batch_quality(
    cfg: &LlmConfig,
    texts: &[String],
    target: &str,
    quality: &str,
) -> Result<Vec<String>> {
    let draft = llm_batch(cfg, texts, target).await?;
    if quality != "best" || texts.len() < 2 {
        return Ok(draft);
    }
    let pairs: Vec<serde_json::Value> = texts
        .iter()
        .zip(draft.iter())
        .map(|(src, zh)| serde_json::json!({ "src": src, "draft": zh }))
        .collect();
    let polish_sys = format!(
        "You are a senior podcast subtitle editor polishing {target} subtitles. \
         Given an array of {{src, draft}} pairs from a continuous spoken segment, \
         improve fluency, spoken naturalness, and terminology consistency across lines \
         without omitting or hallucinating facts. \
         Return ONLY a JSON array of polished strings with the EXACT same length ({}) and order. No markdown.",
        texts.len()
    );
    let messages = vec![
        ChatMessage {
            role: "system".into(),
            content: polish_sys,
        },
        ChatMessage {
            role: "user".into(),
            content: serde_json::to_string(&pairs)?,
        },
    ];
    match llm::chat_once(cfg, &messages).await {
        Ok(reply) => Ok(parse_string_array(&reply, texts.len()).unwrap_or(draft)),
        Err(_) => Ok(draft),
    }
}
