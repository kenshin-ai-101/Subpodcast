/**
 * [INPUT]: 依赖 reqwest；可选代理字符串来自设置
 * [OUTPUT]: 统一 HTTP 客户端、文本/字节拉取
 * [POS]: 所有出站网络的唯一出口，绕开 WebView CORS
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use anyhow::{anyhow, Result};
use once_cell::sync::OnceCell;
use reqwest::{Client, Proxy};
use std::sync::RwLock;
use std::time::Duration;

static PROXY: OnceCell<RwLock<Option<String>>> = OnceCell::new();
static CLIENT: OnceCell<RwLock<Client>> = OnceCell::new();

fn proxy_cell() -> &'static RwLock<Option<String>> {
    PROXY.get_or_init(|| RwLock::new(None))
}

fn client_cell() -> &'static RwLock<Client> {
    CLIENT.get_or_init(|| RwLock::new(build(None).expect("http client")))
}

/// 小宇宙 feed.xyzfm.space 对裸产品 UA 做 ACL 黑名单（X-Tengine-Error: denied by UA ACL）。
/// 用浏览器壳 + 产品名，和常见播客客户端一致。
const UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Subpodcast/0.1";

fn build(proxy: Option<&str>) -> Result<Client> {
    let mut b = Client::builder()
        .timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(20))
        .user_agent(UA)
        .gzip(true)
        .brotli(true);
    if let Some(p) = proxy.filter(|s| !s.trim().is_empty()) {
        b = b.proxy(Proxy::all(p)?);
    }
    Ok(b.build()?)
}

pub fn set_proxy(proxy: Option<String>) -> Result<()> {
    let trimmed = proxy.and_then(|s| {
        let t = s.trim().to_string();
        (!t.is_empty()).then_some(t)
    });
    *proxy_cell().write().unwrap() = trimmed.clone();
    *client_cell().write().unwrap() = build(trimmed.as_deref())?;
    Ok(())
}

pub fn proxy() -> String {
    proxy_cell().read().unwrap().clone().unwrap_or_default()
}

/// 子进程（yt-dlp）用的代理：设置里的优先，否则读环境变量 / macOS 系统代理。
pub fn effective_proxy() -> String {
    let own = proxy();
    if !own.is_empty() {
        return own;
    }
    for k in [
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ] {
        if let Ok(v) = std::env::var(k) {
            if !v.trim().is_empty() {
                return v.trim().to_string();
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(p) = macos_system_proxy() {
            return p;
        }
    }
    String::new()
}

#[cfg(target_os = "macos")]
fn macos_system_proxy() -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/scutil")
        .arg("--proxy")
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let get = |k: &str| {
        text.lines().find_map(|l| {
            let (a, b) = l.split_once(" : ")?;
            (a.trim() == k).then(|| b.trim().to_string())
        })
    };
    if get("HTTPSEnable").as_deref() == Some("1") {
        if let (Some(h), Some(p)) = (get("HTTPSProxy"), get("HTTPSPort")) {
            return Some(format!("http://{h}:{p}"));
        }
    }
    if get("HTTPEnable").as_deref() == Some("1") {
        if let (Some(h), Some(p)) = (get("HTTPProxy"), get("HTTPPort")) {
            return Some(format!("http://{h}:{p}"));
        }
    }
    if get("SOCKSEnable").as_deref() == Some("1") {
        if let (Some(h), Some(p)) = (get("SOCKSProxy"), get("SOCKSPort")) {
            return Some(format!("socks5://{h}:{p}"));
        }
    }
    None
}

pub fn client() -> Client {
    client_cell().read().unwrap().clone()
}

fn http_err(url: &str, status: reqwest::StatusCode) -> anyhow::Error {
    if status.as_u16() == 403 && url.contains("xyzfm.space") {
        anyhow!("小宇宙源拒绝了请求（HTTP 403）。请检查网络/代理后重试：{url}")
    } else {
        anyhow!("HTTP {status} for {url}")
    }
}

pub async fn get_text(url: &str) -> Result<String> {
    let resp = client().get(url).send().await?;
    if !resp.status().is_success() {
        return Err(http_err(url, resp.status()));
    }
    Ok(resp.text().await?)
}

pub async fn get_bytes(url: &str) -> Result<Vec<u8>> {
    let resp = client().get(url).send().await?;
    if !resp.status().is_success() {
        return Err(http_err(url, resp.status()));
    }
    Ok(resp.bytes().await?.to_vec())
}
