/**
 * [INPUT]: 依赖 net、secrets（API Key）
 * [OUTPUT]: OpenAI 兼容 / Anthropic 一次性与流式对话；ChatOpts（max_tokens / json_mode / quick；400/422 自动回退与 <think> 过滤）
 * [POS]: AI 问答、导读、高光抽取与切片文案的模型出口
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

fn openai_chat_url(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

fn anthropic_messages_url(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    let root = if trimmed.is_empty() {
        "https://api.anthropic.com"
    } else {
        trimmed
    };
    if root.ends_with("/messages") {
        root.to_string()
    } else if root.ends_with("/v1") {
        format!("{root}/messages")
    } else {
        format!("{root}/v1/messages")
    }
}

/// 兼容字符串与分段数组（`[{"type":"text","text":"..."}]`）格式的正文提取。
fn extract_text_value(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return (!s.is_empty()).then(|| s.to_string());
    }
    let arr = v.as_array()?;
    let joined: String = arr
        .iter()
        .filter(|part| {
            part["type"]
                .as_str()
                .is_none_or(|t| t == "text" || t == "output_text")
        })
        .filter_map(|part| part["text"].as_str())
        .collect();
    (!joined.is_empty()).then_some(joined)
}

/// 从 OpenAI 兼容 delta / message 取可见正文（跳过 reasoning）。
fn text_piece(v: &Value) -> Option<String> {
    extract_text_value(&v["choices"][0]["delta"]["content"])
        .or_else(|| extract_text_value(&v["choices"][0]["message"]["content"]))
}

fn has_reasoning(container: &Value) -> bool {
    container["reasoning_content"]
        .as_str()
        .is_some_and(|s| !s.is_empty())
        || container["reasoning"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
}

fn finalize_reply(full: String, saw_reasoning: bool, hit_limit: bool) -> Result<String> {
    let trimmed = full.trim_start();
    if !trimmed.trim().is_empty() {
        return Ok(trimmed.to_string());
    }
    if saw_reasoning || hit_limit {
        return Err(anyhow!(
            "模型把篇幅都用在了思考上，没有写出正文。请重试，或换一个不带深度思考的模型"
        ));
    }
    Err(anyhow!("模型没有返回正文"))
}

/// 过滤内联 `<think>...</think>` 思考块（支持跨分片）。
#[derive(Default)]
struct ThinkStripper {
    in_think: bool,
    carry: String,
    saw_think: bool,
}

impl ThinkStripper {
    fn push(&mut self, chunk: &str) -> String {
        let mut buf = std::mem::take(&mut self.carry);
        buf.push_str(chunk);
        let mut visible = String::new();
        loop {
            let marker = if self.in_think { "</think>" } else { "<think>" };
            if let Some(pos) = buf.find(marker) {
                if !self.in_think {
                    visible.push_str(&buf[..pos]);
                }
                self.in_think = !self.in_think;
                if self.in_think {
                    self.saw_think = true;
                }
                buf = buf[pos + marker.len()..].to_string();
                continue;
            }
            let keep = (1..marker.len())
                .rev()
                .find(|&n| {
                    buf.len() >= n
                        && buf.is_char_boundary(buf.len() - n)
                        && marker.starts_with(&buf[buf.len() - n..])
                })
                .unwrap_or(0);
            let split = buf.len() - keep;
            if !self.in_think {
                visible.push_str(&buf[..split]);
            }
            self.carry = buf[split..].to_string();
            return visible;
        }
    }

    fn flush(&mut self) -> String {
        if self.in_think {
            self.carry.clear();
            String::new()
        } else {
            std::mem::take(&mut self.carry)
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ChatOpts {
    pub max_tokens: Option<u32>,
    pub json_mode: bool,
    /// 关闭深度思考，把预算留给正文（各厂商扩展字段尽力而为）。
    pub quick: bool,
}

pub async fn chat_once(cfg: &LlmConfig, messages: &[ChatMessage]) -> Result<String> {
    chat_once_opts(cfg, messages, &ChatOpts::default()).await
}

pub async fn chat_once_opts(
    cfg: &LlmConfig,
    messages: &[ChatMessage],
    opts: &ChatOpts,
) -> Result<String> {
    if cfg.protocol == "anthropic" {
        return anthropic_once(cfg, messages, opts).await;
    }
    openai_once(cfg, messages, opts).await
}

/// 按厂商和模型选择单一的降思考/关思考参数，避免混发不被识别的扩展字段。
fn quick_think_field(base_url: &str, model: &str) -> Option<(&'static str, Value)> {
    let base = base_url.to_ascii_lowercase();
    let m = model.to_ascii_lowercase();
    if base.contains("deepseek.com") || (m.contains("deepseek") && !base.contains("openrouter")) {
        Some(("thinking", serde_json::json!({ "type": "disabled" })))
    } else if base.contains("dashscope") || m.starts_with("qwen3") || m.starts_with("qwq") {
        Some(("enable_thinking", Value::Bool(false)))
    } else if base.contains("bigmodel.cn")
        || m.starts_with("glm-4.5")
        || m.starts_with("glm-4.6")
        || m.starts_with("glm-5")
    {
        Some(("thinking", serde_json::json!({ "type": "disabled" })))
    } else if base.contains("volces.com") || m.starts_with("doubao-seed") {
        Some(("thinking", serde_json::json!({ "type": "disabled" })))
    } else if base.contains("api.openai.com") && (m.starts_with('o') || m.starts_with("gpt-5")) {
        Some(("reasoning_effort", Value::String("low".into())))
    } else {
        None
    }
}

/// 向 OpenAI 兼容端点发请求；遇到 400/422 参数不兼容时自动降级重试（max_completion_tokens / json_mode / quick）。
async fn send_openai_with_fallback(
    cfg: &LlmConfig,
    messages: &[ChatMessage],
    opts: &ChatOpts,
    stream: bool,
) -> Result<reqwest::Response> {
    let url = openai_chat_url(&cfg.base_url);
    let mut use_completion_tokens = false;
    let mut use_json_mode = opts.json_mode;
    let mut think_field = if opts.quick {
        quick_think_field(&cfg.base_url, &cfg.model)
    } else {
        None
    };

    for attempt in 1..=4 {
        let mut body = serde_json::json!({
            "model": cfg.model,
            "messages": messages,
        });
        if stream {
            body["stream"] = Value::Bool(true);
        }
        if let Some(n) = opts.max_tokens {
            let key = if use_completion_tokens {
                "max_completion_tokens"
            } else {
                "max_tokens"
            };
            body[key] = Value::from(n);
        }
        if use_json_mode {
            body["response_format"] = serde_json::json!({ "type": "json_object" });
        }
        if let Some((k, v)) = &think_field {
            body[*k] = v.clone();
        }

        let mut req = net::client().post(&url).json(&body);
        if !cfg.api_key.is_empty() {
            req = req.bearer_auth(&cfg.api_key);
        }
        let resp = req.send().await.map_err(net_err)?;
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }

        let err_body = resp.text().await.unwrap_or_default();
        let lower = err_body.to_ascii_lowercase();
        if matches!(status.as_u16(), 400 | 422) && attempt < 4 {
            if !use_completion_tokens
                && opts.max_tokens.is_some()
                && lower.contains("max_completion_tokens")
            {
                use_completion_tokens = true;
                continue;
            }
            if use_json_mode
                && (lower.contains("response_format")
                    || lower.contains("json_object")
                    || lower.contains("json mode"))
            {
                use_json_mode = false;
                continue;
            }
            if let Some((k, _)) = think_field {
                if lower.contains(k)
                    || lower.contains("unrecognized")
                    || lower.contains("unknown")
                    || lower.contains("extra")
                {
                    think_field = None;
                    continue;
                }
            }
        }
        return Err(api_err(status, &err_body));
    }
    Err(anyhow!("模型请求重试次数耗尽"))
}

async fn openai_once(cfg: &LlmConfig, messages: &[ChatMessage], opts: &ChatOpts) -> Result<String> {
    let resp = send_openai_with_fallback(cfg, messages, opts, false).await?;
    let t = resp.text().await.map_err(net_err)?;
    let v: Value = serde_json::from_str(&t).map_err(|e| anyhow!("模型返回无法解析：{e}"))?;
    if let Some(err) = v["error"]["message"].as_str() {
        return Err(anyhow!("模型服务出错：{err}"));
    }
    let choice = &v["choices"][0];
    let msg = &choice["message"];
    let saw_reasoning = has_reasoning(msg);
    let hit_limit = choice["finish_reason"].as_str() == Some("length");
    let raw = text_piece(&v).unwrap_or_default();
    let mut stripper = ThinkStripper::default();
    let mut cleaned = stripper.push(&raw);
    cleaned.push_str(&stripper.flush());
    finalize_reply(cleaned, saw_reasoning || stripper.saw_think, hit_limit)
}

async fn anthropic_once(
    cfg: &LlmConfig,
    messages: &[ChatMessage],
    opts: &ChatOpts,
) -> Result<String> {
    if cfg.api_key.is_empty() {
        return Err(anyhow!("请先在设置里保存 API Key"));
    }
    let url = anthropic_messages_url(&cfg.base_url);
    let (system, rest): (Vec<_>, Vec<_>) = messages.iter().partition(|m| m.role == "system");
    let system = system
        .iter()
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let max_tokens = opts.max_tokens.unwrap_or(4096);
    let body = serde_json::json!({
        "model": cfg.model,
        "max_tokens": max_tokens,
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
    let mut saw_reasoning = false;
    for block in v["content"].as_array().into_iter().flatten() {
        if block["type"].as_str() == Some("thinking") {
            saw_reasoning = true;
        }
        if let Some(txt) = block["text"].as_str() {
            out.push_str(txt);
        }
    }
    let hit_limit = v["stop_reason"].as_str() == Some("max_tokens");
    finalize_reply(out, saw_reasoning, hit_limit)
}

/// 流式 OpenAI 兼容；每块文本通过回调送出。
pub async fn chat_stream_opts(
    cfg: &LlmConfig,
    messages: &[ChatMessage],
    opts: &ChatOpts,
    cancel: &std::sync::atomic::AtomicBool,
    mut on_delta: impl FnMut(String),
) -> Result<String> {
    use std::sync::atomic::Ordering;
    if cfg.protocol == "anthropic" {
        let full = anthropic_once(cfg, messages, opts).await?;
        if cancel.load(Ordering::Relaxed) {
            return Err(anyhow!("已取消"));
        }
        on_delta(full.clone());
        return Ok(full);
    }
    let resp = send_openai_with_fallback(cfg, messages, opts, true).await?;
    let mut stream = resp.bytes_stream();
    let mut full = String::new();
    let mut raw_buf: Vec<u8> = Vec::new();
    let mut stripper = ThinkStripper::default();
    let mut state = StreamState::default();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            return Err(anyhow!("已取消"));
        }
        let chunk = chunk.map_err(net_err)?;
        raw_buf.extend_from_slice(&chunk);
        drain_sse_lines(&mut raw_buf, &mut full, &mut stripper, &mut state, &mut on_delta)?;
    }
    if !raw_buf.is_empty() {
        raw_buf.push(b'\n');
        drain_sse_lines(&mut raw_buf, &mut full, &mut stripper, &mut state, &mut on_delta)?;
    }
    let tail = stripper.flush();
    if !tail.is_empty() {
        full.push_str(&tail);
        on_delta(tail);
    }
    finalize_reply(full, state.saw_reasoning || stripper.saw_think, state.hit_limit)
}

#[derive(Default)]
struct StreamState {
    saw_reasoning: bool,
    hit_limit: bool,
}

/// 按完整字节行切分 SSE，避免 UTF-8 多字节字符跨 chunk 被截断为 U+FFFD。
fn drain_sse_lines(
    raw_buf: &mut Vec<u8>,
    full: &mut String,
    stripper: &mut ThinkStripper,
    state: &mut StreamState,
    on_delta: &mut impl FnMut(String),
) -> Result<()> {
    let mut consumed = 0usize;
    while let Some(rel) = raw_buf[consumed..].iter().position(|&b| b == b'\n') {
        let line_bytes = &raw_buf[consumed..consumed + rel];
        consumed += rel + 1;
        let line = String::from_utf8_lossy(line_bytes);
        let line = line.trim();
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
            let choice = &v["choices"][0];
            if has_reasoning(&choice["delta"]) || has_reasoning(&choice["message"]) {
                state.saw_reasoning = true;
            }
            if choice["finish_reason"].as_str() == Some("length") {
                state.hit_limit = true;
            }
            if let Some(delta) = text_piece(&v) {
                let cleaned = stripper.push(&delta);
                if !cleaned.is_empty() {
                    full.push_str(&cleaned);
                    on_delta(cleaned);
                }
            }
        }
    }
    if consumed > 0 {
        raw_buf.drain(..consumed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_utf8_multibyte_split_across_chunks_is_preserved() {
        let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"声译双语字幕测试\"}}]}\n";
        let bytes = sse.as_bytes();
        // 在中文字符字节中间切断
        let mid = bytes.iter().position(|&b| b >= 0x80).unwrap() + 1;
        let mut raw = Vec::new();
        let mut full = String::new();
        let mut pieces = Vec::new();
        let mut stripper = ThinkStripper::default();
        let mut state = StreamState::default();
        raw.extend_from_slice(&bytes[..mid]);
        drain_sse_lines(&mut raw, &mut full, &mut stripper, &mut state, &mut |d| pieces.push(d))
            .unwrap();
        assert!(full.is_empty());
        raw.extend_from_slice(&bytes[mid..]);
        drain_sse_lines(&mut raw, &mut full, &mut stripper, &mut state, &mut |d| pieces.push(d))
            .unwrap();
        assert_eq!(full, "声译双语字幕测试");
        assert_eq!(pieces, vec!["声译双语字幕测试"]);
    }

    #[test]
    fn endpoint_urls_normalize_cleanly() {
        assert_eq!(
            openai_chat_url("https://api.deepseek.com/v1/"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            openai_chat_url("https://example.com/v1/chat/completions"),
            "https://example.com/v1/chat/completions"
        );
        assert_eq!(
            anthropic_messages_url("https://api.anthropic.com"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            anthropic_messages_url("https://api.anthropic.com/v1/"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            anthropic_messages_url("https://relay.example.com/v1/messages"),
            "https://relay.example.com/v1/messages"
        );
    }

    #[test]
    fn think_stripper_removes_inline_reasoning_across_chunks() {
        let mut s = ThinkStripper::default();
        let mut out = String::new();
        for piece in ["<thi", "nk>draft {not json}</th", "ink>{\"title\":\"新标题\"}"] {
            out.push_str(&s.push(piece));
        }
        out.push_str(&s.flush());
        assert!(s.saw_think);
        assert_eq!(out, "{\"title\":\"新标题\"}");

        let mut plain = ThinkStripper::default();
        let mut keep = String::new();
        for piece in ["a < b", " x <", " ok"] {
            keep.push_str(&plain.push(piece));
        }
        keep.push_str(&plain.flush());
        assert_eq!(keep, "a < b x < ok");
    }

    #[test]
    fn quick_think_field_matches_provider_and_model() {
        assert_eq!(
            quick_think_field("https://api.deepseek.com/v1", "deepseek-reasoner").unwrap().0,
            "thinking"
        );
        assert_eq!(
            quick_think_field("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus")
                .unwrap()
                .0,
            "enable_thinking"
        );
        assert_eq!(
            quick_think_field("https://api.openai.com/v1", "gpt-5-mini").unwrap().1,
            serde_json::json!("low")
        );
        assert!(quick_think_field("https://openrouter.ai/api/v1", "deepseek/deepseek-r1").is_none());
        assert!(quick_think_field("https://api.openai.com/v1", "gpt-4o").is_none());
    }

    #[test]
    fn array_content_and_reasoning_only_errors_are_handled() {
        let parts = serde_json::json!([
            { "type": "text", "text": "hello " },
            { "type": "image_url" },
            { "type": "output_text", "text": "world" }
        ]);
        assert_eq!(extract_text_value(&parts).as_deref(), Some("hello world"));
        let err = finalize_reply(String::new(), true, false).unwrap_err();
        assert!(err.to_string().contains("思考"));
    }
}
