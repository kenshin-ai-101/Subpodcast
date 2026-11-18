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

fn net_err(e: reqwest::Error) -> anyhow::Error {
    if e.is_timeout() {
        anyhow!("模型响应超时，请检查网络或换一个更快的模型")
    } else if e.is_connect() {
        anyhow!("连不上模型服务，请检查网络或代理")
    } else {
        let s = e.to_string();
        if s.contains("error decoding response body") {
            anyhow!("模型连接中断，请重试")
        } else {
            anyhow!("连不上模型服务：{s}")
        }
    }
}

fn api_err(status: reqwest::StatusCode, body: &str) -> anyhow::Error {
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v["error"]["message"]
                .as_str()
                .or_else(|| v["error"].as_str())
                .or_else(|| v["message"].as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.chars().take(200).collect());
    match status.as_u16() {
        401 | 403 => anyhow!("API Key 无效或没有权限：{msg}"),
        404 => anyhow!("模型或地址不存在：{msg}"),
        429 => anyhow!("请求太频繁或额度不足：{msg}"),
        _ => anyhow!("模型服务出错（{status}）：{msg}"),
    }
}

/// 从 OpenAI 兼容 delta / message 取可见正文（跳过 reasoning）。
fn text_piece(v: &Value) -> Option<String> {
    let d = &v["choices"][0]["delta"];
    if let Some(t) = d["content"].as_str().filter(|s| !s.is_empty()) {
        return Some(t.to_string());
    }
    let m = &v["choices"][0]["message"];
    m["content"].as_str().filter(|s| !s.is_empty()).map(str::to_string)
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
        .await
        .map_err(net_err)?;
    if !resp.status().is_success() {
        let status = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(api_err(status, &t));
    }
    let t = resp.text().await.map_err(net_err)?;
    let v: Value = serde_json::from_str(&t).map_err(|e| anyhow!("模型返回无法解析：{e}"))?;
    text_piece(&v)
        .or_else(|| v["choices"][0]["message"]["content"].as_str().map(str::to_string))
        .filter(|s| !s.is_empty())
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
        .await
        .map_err(net_err)?;
    if !resp.status().is_success() {
        let status = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(api_err(status, &t));
    }
    let t = resp.text().await.map_err(net_err)?;
    let v: Value = serde_json::from_str(&t).map_err(|e| anyhow!("Anthropic 返回无法解析：{e}"))?;
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
        .await
        .map_err(net_err)?;
    if !resp.status().is_success() {
        let status = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(api_err(status, &t));
    }
    let mut stream = resp.bytes_stream();
    let mut full = String::new();
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(net_err)?;
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
                if let Some(e) = v["error"]["message"].as_str() {
                    return Err(anyhow!("模型服务出错：{e}"));
                }
                if let Some(delta) = text_piece(&v) {
                    full.push_str(&delta);
                    on_delta(delta);
                }
            }
        }
    }
    Ok(full)
}
