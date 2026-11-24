/**
 * [INPUT]: 依赖 reqwest；可选代理字符串来自设置
 * [OUTPUT]: 统一 HTTP 客户端（connect 15s + read 120s）；设置代理优先；留空则直连，失败再试系统/环境代理
 * [POS]: 所有出站网络的唯一出口；非 VPN 常态直连，避免 system-proxy 咬死已关的本地代理
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
    // 默认直连：reqwest 的 system-proxy 会在 VPN 关掉后仍指向 127.0.0.1 幽灵端口
    CLIENT.get_or_init(|| RwLock::new(build(None, true).expect("http client")))
}

/// 小宇宙 feed.xyzfm.space 对裸产品 UA 做 ACL 黑名单；浏览器壳 + 产品名。
const UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Subpodcast/0.1";

/// `force_direct`：`.no_proxy()`，禁用 reqwest system-proxy / 环境代理自动探测。
fn build(proxy: Option<&str>, force_direct: bool) -> Result<Client> {
    // 不用总超时：流式 LLM 生成常超 60s。改用读超时——有数据就重置。
    let mut b = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(120))
        .pool_idle_timeout(Duration::from_secs(20))
        .tcp_keepalive(Duration::from_secs(30))
        .user_agent(UA)
        .gzip(true)
        .brotli(true);
    if force_direct {
        b = b.no_proxy();
    } else if let Some(p) = proxy.filter(|s| !s.trim().is_empty()) {
        b = b.proxy(Proxy::all(p)?);
    }
    Ok(b.build()?)
}

pub fn set_proxy(proxy: Option<String>) -> Result<()> {
    let trimmed = proxy.and_then(|s| {
        let t = s.trim().to_string();
        (!t.is_empty()).then_some(t)
    });
    // 先校验并构造客户端，成功后才原子更新全局状态，避免非法代理污染 PROXY。
    let client = if let Some(ref p) = trimmed {
        build(Some(p), false)?
    } else {
        build(None, true)?
    };
    *proxy_cell().write().unwrap_or_else(|e| e.into_inner()) = trimmed;
    *client_cell().write().unwrap_or_else(|e| e.into_inner()) = client;
    Ok(())
}

pub fn proxy() -> String {
    proxy_cell()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_default()
}

/// 子进程（yt-dlp）用的代理：设置里的优先，否则读环境变量 / macOS 系统代理。
pub fn effective_proxy() -> String {
    let own = proxy();
    if !own.is_empty() {
        return own;
    }
    env_or_system_proxy()
}

fn env_or_system_proxy() -> String {
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
    client_cell().read().unwrap_or_else(|e| e.into_inner()).clone()
}

fn http_err(url: &str, status: reqwest::StatusCode) -> anyhow::Error {
    if status.as_u16() == 403 && url.contains("xyzfm.space") {
        anyhow!("小宇宙源拒绝了请求（HTTP 403）。请检查网络/代理后重试")
    } else {
        anyhow!("源返回 HTTP {status}")
    }
}

fn is_http_status_err(err: &anyhow::Error) -> bool {
    let s = format!("{err:#}");
    s.starts_with("源返回 HTTP ") || s.contains("拒绝了请求（HTTP ")
}

fn format_err(url: &str, err: anyhow::Error) -> anyhow::Error {
    if is_http_status_err(&err) {
        err
    } else {
        friendly_net_err(url, err)
    }
}

fn is_connect_like(err: &anyhow::Error) -> bool {
    let s = format!("{err:#}").to_ascii_lowercase();
    s.contains("error sending request")
        || s.contains("connection")
        || s.contains("timed out")
        || s.contains("timeout")
        || s.contains("dns")
        || s.contains("connect")
        || s.contains("proxy")
}

fn friendly_net_err(url: &str, _err: anyhow::Error) -> anyhow::Error {
    let host = reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| url.to_string());
    if host.contains("xiaoyuzhoufm.com") || host.contains("xyzfm.space") {
        anyhow!("无法连接小宇宙（{host}）。请检查网络；需要时在设置里填写代理")
    } else {
        anyhow!("无法连接 {host}。若该源在国外，请开启 VPN 或在设置里填写代理")
    }
}

async fn send_text(c: &Client, url: &str) -> Result<String> {
    let resp = c.get(url).send().await.map_err(|e| anyhow!("{e}"))?;
    if !resp.status().is_success() {
        return Err(http_err(url, resp.status()));
    }
    Ok(resp.text().await.map_err(|e| anyhow!("{e}"))?)
}

pub async fn get_json(url: &str) -> Result<serde_json::Value> {
    let text = get_text(url).await?;
    Ok(serde_json::from_str(&text)?)
}

pub async fn get_text(url: &str) -> Result<String> {
    // 设置了显式代理：只走它
    if !proxy().is_empty() {
        return match send_text(&client(), url).await {
            Ok(t) => Ok(t),
            Err(e) => {
                if is_connect_like(&e) {
                    tokio::time::sleep(Duration::from_millis(400)).await;
                    if let Ok(t) = send_text(&client(), url).await {
                        return Ok(t);
                    }
                }
                Err(format_err(url, e))
            }
        };
    }

    // 留空：先直连（非 VPN / 国内源），失败再试系统或环境代理
    let direct = client(); // set_proxy(None) 已是 no_proxy
    match send_text(&direct, url).await {
        Ok(t) => Ok(t),
        Err(e) => {
            if !is_connect_like(&e) {
                return Err(format_err(url, e));
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
            if let Ok(t) = send_text(&direct, url).await {
                return Ok(t);
            }
            let p = env_or_system_proxy();
            if !p.is_empty() {
                if let Ok(via) = build(Some(&p), false) {
                    if let Ok(t) = send_text(&via, url).await {
                        return Ok(t);
                    }
                }
            }
            Err(format_err(url, e))
        }
    }
}

/// 用指定代理拉文本（不改全局 client）。
pub async fn get_text_via_proxy(url: &str, proxy: &str) -> Result<String> {
    let c = build(Some(proxy), false)?;
    send_text(&c, url).await.map_err(|e| format_err(url, e))
}

pub async fn get_bytes(url: &str) -> Result<Vec<u8>> {
    async fn once(c: &Client, url: &str) -> Result<Vec<u8>> {
        let resp = c.get(url).send().await.map_err(|e| anyhow!("{e}"))?;
        if !resp.status().is_success() {
            return Err(http_err(url, resp.status()));
        }
        Ok(resp.bytes().await.map_err(|e| anyhow!("{e}"))?.to_vec())
    }

    if !proxy().is_empty() {
        return once(&client(), url)
            .await
            .map_err(|e| format_err(url, e));
    }

    match once(&client(), url).await {
        Ok(b) => Ok(b),
        Err(e) if is_connect_like(&e) => {
            let p = env_or_system_proxy();
            if !p.is_empty() {
                if let Ok(via) = build(Some(&p), false) {
                    if let Ok(b) = once(&via, url).await {
                        return Ok(b);
                    }
                }
            }
            Err(format_err(url, e))
        }
        Err(e) => Err(format_err(url, e)),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn connect_like_detects_reqwest_send_error() {
        let e = anyhow::anyhow!(
            "error sending request for url (https://podcast.latepost.com/rss)"
        );
        assert!(super::is_connect_like(&e));
    }

    #[test]
    fn http_status_err_not_masked_as_vpn() {
        let e = super::http_err("https://example.com/feed.xml", reqwest::StatusCode::FORBIDDEN);
        let out = super::format_err("https://example.com/feed.xml", e).to_string();
        assert!(out.contains("403"), "got: {out}");
        assert!(!out.contains("VPN"), "got: {out}");
    }

    #[test]
    fn friendly_hides_raw_reqwest() {
        let e = anyhow::anyhow!("error sending request for url (https://feeds.fireside.fm/sv101/rss)");
        let msg = super::friendly_net_err("https://feeds.fireside.fm/sv101/rss", e).to_string();
        assert!(!msg.contains("error sending request"), "{msg}");
        assert!(msg.contains("feeds.fireside.fm") || msg.contains("代理"), "{msg}");
    }

    #[tokio::test]
    #[ignore = "需要网络"]
    async fn live_latepost_direct() {
        let _ = super::set_proxy(None);
        let body = super::get_text("https://podcast.latepost.com/rss")
            .await
            .expect("latepost");
        assert!(body.contains("<rss") || body.contains("<channel"));
    }
}
