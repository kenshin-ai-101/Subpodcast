/**
 * [INPUT]: 依赖 net、secrets（API Key）
 * [OUTPUT]: OpenAI 兼容 / Anthropic 一次性与流式对话
 * [POS]: AI 问答与翻译的模型出口
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use crate::net;
use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    pub base_url: String,
    pub model: String,
    /// openai | anthropic
    pub protocol: String,
    pub api_key: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

pub async fn chat_once(cfg: &LlmConfig, messages: &[ChatMessage]) -> Result<String> {
    if cfg.protocol == "anthropic" {
        return anthropic_once(cfg, messages).await;
    }
    openai_once(cfg, messages).await
}

async fn openai_once(cfg: &LlmConfig, messages: &[ChatMessage]) -> Result<String> {
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": cfg.model,
        "messages": messages,
        "temperature": 0.3,
    });
    let resp = net::client()
        .post(&url)
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(anyhow!("模型 HTTP {status}: {t}"));
    }
    let v: Value = resp.json().await?;
    v["choices"][0]["message"]["content"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| anyhow!("模型没有返回正文"))
}

async fn anthropic_once(cfg: &LlmConfig, messages: &[ChatMessage]) -> Result<String> {
    let url = format!("{}/messages", cfg.base_url.trim_end_matches('/'));
    let (system, rest): (Vec<_>, Vec<_>) = messages.iter().partition(|m| m.role == "system");
    let system = system.iter().map(|m| m.content.as_str()).collect::<Vec<_>>().join("\n");
    let body = serde_json::json!({
        "model": cfg.model,
        "max_tokens": 4096,
        "system": system,
        "messages": rest.iter().map(|m| serde_json::json!({"role": m.role, "content": m.content})).collect::<Vec<_>>(),
    });
    let resp = net::client()
        .post(&url)
        .header("x-api-key", &cfg.api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Anthropic HTTP {status}: {t}"));
    }
    let v: Value = resp.json().await?;
    let mut out = String::new();
    for block in v["content"].as_array().into_iter().flatten() {
        if let Some(t) = block["text"].as_str() {
            out.push_str(t);
        }
    }
    if out.is_empty() {
        Err(anyhow!("Anthropic 没有返回正文"))
    } else {
        Ok(out)
    }
}

/// 流式 OpenAI 兼容；每块文本通过回调送出。
pub async fn chat_stream(
    cfg: &LlmConfig,
    messages: &[ChatMessage],
    mut on_delta: impl FnMut(String),
) -> Result<String> {
    if cfg.protocol == "anthropic" {
        let full = anthropic_once(cfg, messages).await?;
        on_delta(full.clone());
        return Ok(full);
    }
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": cfg.model,
        "messages": messages,
        "temperature": 0.3,
        "stream": true,
    });
    let resp = net::client()
        .post(&url)
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(anyhow!("模型 HTTP {status}: {t}"));
    }
    let mut stream = resp.bytes_stream();
    let mut full = String::new();
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim().to_string();
            buf = buf[pos + 1..].to_string();
            if !line.starts_with("data:") {
                continue;
            }
            let data = line.trim_start_matches("data:").trim();
            if data == "[DONE]" {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(data) {
                if let Some(delta) = v["choices"][0]["delta"]["content"].as_str() {
                    full.push_str(delta);
                    on_delta(delta.to_string());
                }
            }
        }
    }
    Ok(full)
}
