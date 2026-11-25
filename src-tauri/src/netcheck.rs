/**
 * [INPUT]: crate::net HTTP 客户端；crate::ytdlp 定位/镜像地址
 * [OUTPUT]: 并行网络探测结果 Check{name,ok,detail,ms}（代理 / YouTube / Google / Apple Podcasts / 视频源 / yt-dlp）
 * [POS]: 设置 › 通用 › 网络诊断；与 WebView 代理状态一起由 network_check 命令返回
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use crate::{net, ytdlp};
use serde::Serialize;
use std::path::Path;
use std::time::{Duration, Instant};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// proxy | youtube | google | apple | video | ytdlpSource | ytdlp
    pub name: &'static str,
    pub ok: bool,
    pub ms: Option<u64>,
    /// 代理摘要、yt-dlp 版本，或失败原因（可展示）。
    pub detail: String,
}

/// 展示用代理串：抹掉 user:pass，避免诊断报告泄露凭据。
pub fn redact_proxy(p: &str) -> String {
    match p.split_once("://") {
        Some((scheme, rest)) => match rest.rsplit_once('@') {
            Some((_, host)) => format!("{scheme}://***@{host}"),
            None => p.to_string(),
        },
        None => match p.rsplit_once('@') {
            Some((_, host)) => format!("***@{host}"),
            None => p.to_string(),
        },
    }
}

fn describe_reqwest(e: reqwest::Error) -> String {
    let mut cause: &dyn std::error::Error = &e;
    while let Some(next) = cause.source() {
        cause = next;
    }
    let host = e.url().and_then(|u| u.host_str()).unwrap_or("").to_string();
    let why = cause.to_string();
    let low = why.to_ascii_lowercase();
    if low.contains("connection refused") || low.contains("actively refused") {
        format!("连不上 {host}：连接被拒绝。请确认代理软件在运行，或在设置里填写正确的代理地址")
    } else if e.is_timeout() {
        format!("连接 {host} 超时，请检查网络或代理")
    } else if e.is_connect() {
        format!("连不上 {host}：{why}")
    } else if why != e.to_string() {
        format!("网络请求失败（{host}）：{why}")
    } else {
        format!("网络请求失败（{host}）")
    }
}

async fn reach(name: &'static str, url: &str) -> Check {
    let start = Instant::now();
    let res = tokio::time::timeout(Duration::from_secs(10), net::client().get(url).send()).await;
    let ms = Some(start.elapsed().as_millis() as u64);
    match res {
        // 任意 HTTP 应答都算通（204 / 重定向 / 404 都说明路由可达）。
        Ok(Ok(_)) => Check {
            name,
            ok: true,
            ms,
            detail: String::new(),
        },
        Ok(Err(e)) => Check {
            name,
            ok: false,
            ms,
            detail: describe_reqwest(e),
        },
        Err(_) => Check {
            name,
            ok: false,
            ms,
            detail: "10 秒内没有响应".into(),
        },
    }
}

async fn ytdlp_check(data: &Path) -> Check {
    match ytdlp::find_ytdlp(data) {
        None => Check {
            name: "ytdlp",
            ok: false,
            ms: None,
            detail: "not installed".into(),
        },
        Some(bin) => match ytdlp::ytdlp_version(&bin).await {
            Some(v) => Check {
                name: "ytdlp",
                ok: true,
                ms: None,
                detail: v,
            },
            None => Check {
                name: "ytdlp",
                ok: false,
                ms: None,
                detail: "doesn't run".into(),
            },
        },
    }
}

/// 并行跑完全部探测；单条最长约 10s。
pub async fn run(data: &Path) -> Vec<Check> {
    let own = net::proxy();
    let used = net::effective_proxy();
    let proxy = Check {
        name: "proxy",
        ok: true,
        ms: None,
        detail: if !own.trim().is_empty() {
            format!("Subpodcast: {}", redact_proxy(own.trim()))
        } else if !used.trim().is_empty() {
            format!("system: {}", redact_proxy(used.trim()))
        } else {
            "none".into()
        },
    };

    let (youtube, google, apple, video, source, ytdlp) = tokio::join!(
        reach(
            "youtube",
            "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json",
        ),
        reach("google", "https://www.google.com/generate_204"),
        reach(
            "apple",
            "https://itunes.apple.com/search?term=podcast&media=podcast&limit=1",
        ),
        reach("video", "https://redirector.googlevideo.com/generate_204"),
        reach("ytdlpSource", ytdlp::YTDLP_MIRROR),
        ytdlp_check(data),
    );

    vec![proxy, youtube, google, apple, video, source, ytdlp]
}

#[cfg(test)]
mod tests {
    use super::redact_proxy;

    #[test]
    fn proxy_credentials_are_hidden() {
        assert_eq!(redact_proxy("http://127.0.0.1:7890"), "http://127.0.0.1:7890");
        assert_eq!(
            redact_proxy("http://user:pass@proxy.example:8080"),
            "http://***@proxy.example:8080"
        );
        assert_eq!(
            redact_proxy("socks5://a:b@c@host:1080"),
            "socks5://***@host:1080"
        );
        assert_eq!(redact_proxy("user:pw@host:3128"), "***@host:3128");
    }
}
