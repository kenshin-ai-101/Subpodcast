/**
 * [INPUT]: 依赖 ytdlp、net、sha1；浏览器 Cookie 经 yt-dlp 导出
 * [OUTPUT]: youtube_subscriptions / open_privacy_settings / ensure_browser_access / opml
 * [POS]: 订阅导入后端；前端 ImportPanel 消费频道列表；设置 › 通用导出 OPML
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use crate::net;
use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    pub title: String,
    pub thumbnail: String,
}

fn cookie_header(file: &str, domain: &str) -> (String, Option<String>) {
    let mut pairs = Vec::new();
    let mut sapisid = None;
    for line in file.lines() {
        let line = line.strip_prefix("#HttpOnly_").unwrap_or(line);
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 7 {
            continue;
        }
        let host = f[0].trim_start_matches('.');
        if host != domain && !domain.ends_with(&format!(".{host}")) && !host.ends_with(domain) {
            continue;
        }
        if f[5] == "SAPISID" || (f[5] == "__Secure-3PAPISID" && sapisid.is_none()) {
            sapisid = Some(f[6].to_string());
        }
        pairs.push(format!("{}={}", f[5], f[6]));
    }
    (pairs.join("; "), sapisid)
}

fn sapisid_hash(sapisid: &str) -> String {
    use sha1::{Digest, Sha1};
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let origin = "https://www.youtube.com";
    format!(
        "SAPISIDHASH {ts}_{}",
        hex::encode(Sha1::digest(format!("{ts} {sapisid} {origin}").as_bytes()))
    )
}

fn embedded_json(page: &str, marker: &str) -> Option<Value> {
    let start = page.find(marker)? + marker.len();
    let rest = page[start..].trim_start().trim_start_matches('=').trim_start();
    let mut de = serde_json::Deserializer::from_str(rest).into_iter::<Value>();
    de.next()?.ok()
}

pub fn channels_in(data: &Value) -> (Vec<Channel>, Option<String>) {
    let mut out = Vec::new();
    let mut next = None;
    fn walk(v: &Value, out: &mut Vec<Channel>, next: &mut Option<String>) {
        match v {
            Value::Object(m) => {
                if let Some(c) = m.get("channelRenderer") {
                    let id = c["channelId"].as_str().unwrap_or("").to_string();
                    let title = c["title"]["simpleText"]
                        .as_str()
                        .map(str::to_string)
                        .or_else(|| c["title"]["runs"][0]["text"].as_str().map(str::to_string))
                        .unwrap_or_default();
                    let thumb = c["thumbnail"]["thumbnails"]
                        .as_array()
                        .and_then(|a| a.last())
                        .and_then(|t| t["url"].as_str())
                        .unwrap_or("");
                    let thumbnail = if thumb.starts_with("//") {
                        format!("https:{thumb}")
                    } else {
                        thumb.to_string()
                    };
                    if id.starts_with("UC") && !out.iter().any(|x: &Channel| x.id == id) {
                        out.push(Channel {
                            id,
                            title,
                            thumbnail,
                        });
                    }
                    return;
                }
                if let Some(tok) = m
                    .get("continuationCommand")
                    .and_then(|c| c["token"].as_str())
                {
                    *next = Some(tok.to_string());
                }
                for x in m.values() {
                    walk(x, out, next);
                }
            }
            Value::Array(a) => {
                for x in a {
                    walk(x, out, next)
                }
            }
            _ => {}
        }
    }
    walk(data, &mut out, &mut next);
    (out, next)
}

/// 界面匹配「需要你允许」以展示系统设置引导。
pub const NEEDS_ACCESS: &str = "需要你允许 声译 读取";

fn browser_name(browser: &str) -> &'static str {
    match browser {
        "chrome" => "Chrome",
        "safari" => "Safari",
        "edge" => "Edge",
        "firefox" => "Firefox",
        "brave" => "Brave",
        "chromium" => "Chromium",
        "opera" => "Opera",
        "vivaldi" => "Vivaldi",
        _ => "浏览器",
    }
}

#[cfg(target_os = "macos")]
fn browser_dir(browser: &str) -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    let sub = match browser {
        "chrome" => "Library/Application Support/Google/Chrome",
        "edge" => "Library/Application Support/Microsoft Edge",
        "brave" => "Library/Application Support/BraveSoftware/Brave-Browser",
        "chromium" => "Library/Application Support/Chromium",
        "vivaldi" => "Library/Application Support/Vivaldi",
        "opera" => "Library/Application Support/com.operasoftware.Opera",
        "firefox" => "Library/Application Support/Firefox/Profiles",
        "safari" => "Library/Containers/com.apple.Safari/Data/Library/Cookies",
        _ => return None,
    };
    Some(home.join(sub))
}

pub fn ensure_browser_access(browser: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::io::ErrorKind;
        let name = browser_name(browser);
        let Some(dir) = browser_dir(browser) else {
            return Ok(());
        };
        let denied = || {
            anyhow!(
                "{NEEDS_ACCESS} {name} 的数据：在 系统设置 › 隐私与安全性 › 文件和文件夹 里，打开 声译 下的「{name}」，然后重试"
            )
        };
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) if e.kind() == ErrorKind::NotFound => {
                return Err(anyhow!(
                    "没有找到 {name} 的数据，这台电脑可能没有用过 {name}。换一个浏览器试试"
                ))
            }
            Err(e) if e.kind() == ErrorKind::PermissionDenied => return Err(denied()),
            Err(_) => return Ok(()),
        };
        let mut cands: Vec<std::path::PathBuf> = vec![dir.join("Cookies.binarycookies")];
        for e in entries.flatten() {
            let p = e.path();
            cands.extend([
                p.join("Cookies"),
                p.join("Network/Cookies"),
                p.join("cookies.sqlite"),
            ]);
        }
        for c in cands.iter().filter(|c| c.exists()) {
            match std::fs::File::open(c) {
                Ok(_) => return Ok(()),
                Err(e) if e.kind() == ErrorKind::PermissionDenied => return Err(denied()),
                Err(_) => continue,
            }
        }
    }
    let _ = browser;
    Ok(())
}

pub fn open_privacy_settings() -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")
            .spawn()?;
    }
    Ok(())
}

pub async fn youtube_subscriptions(ytdlp: &Path, browser: &str) -> Result<Vec<Channel>> {
    {
        let b = browser.to_string();
        tokio::task::spawn_blocking(move || ensure_browser_access(&b)).await??;
    }
    let dir = std::env::temp_dir().join(format!("subpodcast-cookies-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir)?;
    let jar = dir.join("cookies.txt");
    let result = async {
        let mut cmd = tokio::process::Command::new(ytdlp);
        cmd.args(["--cookies-from-browser", browser, "--cookies"])
            .arg(&jar)
            .args([
                "--skip-download",
                "--flat-playlist",
                "--no-warnings",
                "--playlist-items",
                "0",
                "https://www.youtube.com/feed/channels",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let proxy = net::effective_proxy();
        if !proxy.is_empty() {
            cmd.args(["--proxy", &proxy]);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let out = tokio::time::timeout(std::time::Duration::from_secs(90), cmd.output())
            .await
            .map_err(|_| anyhow!("读取浏览器登录信息超时"))??;
        let file = std::fs::read_to_string(&jar).unwrap_or_default();
        if !file.contains("youtube.com") {
            let err = String::from_utf8_lossy(&out.stderr);
            let why = err
                .lines()
                .rev()
                .find(|l| l.contains("ERROR"))
                .unwrap_or("")
                .to_string();
            if why.to_lowercase().contains("could not find")
                || why.to_lowercase().contains("not found")
            {
                return Err(if cfg!(target_os = "macos") {
                    anyhow!(
                        "{NEEDS_ACCESS} {} 的数据：在 系统设置 › 隐私与安全性 › 文件和文件夹 里，打开 声译 下的「{}」，然后重试",
                        browser_name(browser),
                        browser_name(browser)
                    )
                } else {
                    anyhow!("没有找到这个浏览器的数据，换一个浏览器试试")
                });
            }
            if why.contains("Operation not permitted") || why.to_lowercase().contains("permission")
            {
                return Err(anyhow!(
                    "没有权限读取这个浏览器的数据（Safari 需要在 系统设置 › 隐私与安全性 › 完全磁盘访问权限 里允许 声译）"
                ));
            }
            return Err(anyhow!(
                "这个浏览器里没有登录 YouTube{}",
                if why.is_empty() {
                    String::new()
                } else {
                    format!("：{}", why.chars().take(160).collect::<String>())
                }
            ));
        }
        let (cookie, sapisid) = cookie_header(&file, "www.youtube.com");
        let page = net::client()
            .get("https://www.youtube.com/feed/channels")
            .header("Cookie", &cookie)
            .header("Accept-Language", "en-US,en;q=0.9")
            .send()
            .await?
            .text()
            .await?;
        let data = embedded_json(&page, "ytInitialData")
            .ok_or_else(|| anyhow!("没有读到 YouTube 的订阅页"))?;
        let (mut all, mut next) = channels_in(&data);
        if all.is_empty() && next.is_none() {
            return Err(anyhow!(
                "这个浏览器里没有登录 YouTube，或者还没有订阅任何频道"
            ));
        }
        let version = embedded_json(&page, "ytcfg.set(")
            .and_then(|c| c["INNERTUBE_CLIENT_VERSION"].as_str().map(str::to_string))
            .unwrap_or_else(|| "2.20251101.00.00".into());
        for _ in 0..40 {
            let Some(token) = next.take() else { break };
            let mut req = net::client()
                .post("https://www.youtube.com/youtubei/v1/browse?prettyPrint=false")
                .header("Cookie", &cookie)
                .header("X-Origin", "https://www.youtube.com")
                .header("Origin", "https://www.youtube.com")
                .json(&json!({
                    "context": { "client": { "clientName": "WEB", "clientVersion": version, "hl": "en" } },
                    "continuation": token
                }));
            if let Some(s) = &sapisid {
                req = req.header("Authorization", sapisid_hash(s));
            }
            let v: Value = req.send().await?.json().await?;
            let (more, n) = channels_in(&v);
            for c in more {
                if !all.iter().any(|x| x.id == c.id) {
                    all.push(c);
                }
            }
            next = n;
        }
        Ok(all)
    }
    .await;
    let _ = std::fs::remove_dir_all(&dir);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_channels_and_the_next_page() {
        let data = json!({ "contents": { "twoColumnBrowseResultsRenderer": { "tabs": [{ "tabRenderer": { "content": { "sectionListRenderer": { "contents": [
            { "itemSectionRenderer": { "contents": [{ "shelfRenderer": { "content": { "expandedShelfContentsRenderer": { "items": [
                { "channelRenderer": { "channelId": "UCabc", "title": { "simpleText": "Lex Fridman" }, "thumbnail": { "thumbnails": [{ "url": "//yt3.ggpht.com/a=s88" }, { "url": "//yt3.ggpht.com/a=s176" }] } } },
                { "channelRenderer": { "channelId": "UCdef", "title": { "runs": [{ "text": "词元之外" }] }, "thumbnail": { "thumbnails": [] } } }
            ] } } } }] } },
            { "continuationItemRenderer": { "continuationEndpoint": { "continuationCommand": { "token": "TOKEN1", "request": "CONTINUATION_REQUEST_TYPE_BROWSE" } } } }
        ] } } } }] } } });
        let (ch, next) = channels_in(&data);
        assert_eq!(ch.len(), 2);
        assert_eq!(
            ch[0],
            Channel {
                id: "UCabc".into(),
                title: "Lex Fridman".into(),
                thumbnail: "https://yt3.ggpht.com/a=s176".into()
            }
        );
        assert_eq!(ch[1].title, "词元之外");
        assert_eq!(next.as_deref(), Some("TOKEN1"));
    }

    #[test]
    fn reads_the_page_data_and_cookies() {
        let page = r#"<script>var ytInitialData = {"a":{"channelRenderer":{"channelId":"UCx","title":{"simpleText":"X"}}}};</script><script>ytcfg.set({"INNERTUBE_CLIENT_VERSION":"2.2026"});</script>"#;
        assert_eq!(
            channels_in(&embedded_json(page, "ytInitialData").unwrap()).0[0].id,
            "UCx"
        );
        assert_eq!(
            embedded_json(page, "ytcfg.set(").unwrap()["INNERTUBE_CLIENT_VERSION"],
            "2.2026"
        );
        let jar = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tsecret\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc\n.google.com\tTRUE\t/\tTRUE\t0\tNID\tzzz\n";
        let (h, s) = cookie_header(jar, "www.youtube.com");
        assert_eq!(h, "SAPISID=secret; SID=abc");
        assert_eq!(s.as_deref(), Some("secret"));
        assert!(sapisid_hash("secret").starts_with("SAPISIDHASH "));
    }

    #[test]
    fn opml_escapes() {
        let o = opml(&[("A & B <1>".into(), "https://x.com/feed?a=1&b=2".into())]);
        assert!(o.contains("text=\"A &amp; B &lt;1&gt;\"") && o.contains("xmlUrl=\"https://x.com/feed?a=1&amp;b=2\""));
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 订阅列表写成 OPML，供其他播客客户端导入。
pub fn opml(shows: &[(String, String)]) -> String {
    let mut out = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<opml version=\"2.0\">\n  <head><title>Subpodcast</title></head>\n  <body>\n",
    );
    for (title, url) in shows {
        out.push_str(&format!(
            "    <outline type=\"rss\" text=\"{0}\" title=\"{0}\" xmlUrl=\"{1}\"/>\n",
            xml_escape(title),
            xml_escape(url)
        ));
    }
    out.push_str("  </body>\n</opml>\n");
    out
}
