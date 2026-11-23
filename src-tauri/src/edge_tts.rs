//! [INPUT]: Edge Read Aloud WebSocket 协议、代理设置、语速与音色
//! [OUTPUT]: MP3 字节
//! [POS]: 免 Key 的在线朗读引擎
//! [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

use anyhow::{anyhow, bail, Result};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Error, Message};

const HOST: &str = "speech.platform.bing.com";
const CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_VERSION: &str = "143.0.3650.75";
const FORMAT: &str = "audio-24khz-48kbitrate-mono-mp3";
static GATE: tokio::sync::Mutex<Option<Instant>> = tokio::sync::Mutex::const_new(None);

fn escape(s: &str) -> String {
    s.chars()
        .filter(|&c| {
            matches!(c, '\t' | '\n' | '\r') || (c >= ' ' && c != '\u{fffe}' && c != '\u{ffff}')
        })
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\'', "&apos;")
        .replace('"', "&quot;")
}

async fn open_transport(proxy: &str) -> Result<TcpStream> {
    if proxy.is_empty() {
        return Ok(TcpStream::connect((HOST, 443)).await?);
    }
    let url = reqwest::Url::parse(proxy).map_err(|_| anyhow!("代理地址无效"))?;
    let address = (
        url.host_str().ok_or_else(|| anyhow!("代理地址无效"))?,
        url.port_or_known_default().unwrap_or(1080),
    );
    let password = urlencoding::decode(url.password().unwrap_or(""))?;
    let user = urlencoding::decode(url.username())?;
    let stream = TcpStream::connect(address).await?;
    match url.scheme() {
        "socks5" | "socks5h" => {
            use tokio_socks::tcp::Socks5Stream;
            let tunnel = if user.is_empty() {
                Socks5Stream::connect_with_socket(stream, (HOST, 443)).await?
            } else {
                Socks5Stream::connect_with_password_and_socket(
                    stream,
                    (HOST, 443),
                    &user,
                    &password,
                )
                .await?
            };
            Ok(tunnel.into_inner())
        }
        "http" => {
            let mut stream = stream;
            let auth = if user.is_empty() {
                String::new()
            } else {
                let basic =
                    base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"));
                format!("Proxy-Authorization: Basic {basic}\r\n")
            };
            let msg = format!("CONNECT {HOST}:443 HTTP/1.1\r\nHost: {HOST}:443\r\n{auth}\r\n");
            stream.write_all(msg.as_bytes()).await?;
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                if header.len() >= 8192 {
                    bail!("代理响应过长");
                }
                header.push(stream.read_u8().await?);
            }
            if String::from_utf8_lossy(&header)
                .split_ascii_whitespace()
                .nth(1)
                != Some("200")
            {
                bail!("代理拒绝了 Edge 连接");
            }
            Ok(stream)
        }
        _ => bail!("Edge 在线语音支持 HTTP 和 SOCKS5 代理"),
    }
}

async fn exchange(proxy: &str, voice: &str, text: &str, rate: f64) -> Result<Vec<u8>> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let gec = crate::edge_gec::token(now, CLIENT_TOKEN);
    let id = uuid::Uuid::new_v4().simple();
    let mut request = format!(
        "wss://{HOST}/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken={CLIENT_TOKEN}&ConnectionId={id}&Sec-MS-GEC={gec}&Sec-MS-GEC-Version=2-{EDGE_VERSION}"
    ).into_client_request()?;
    let headers = request.headers_mut();
    headers.insert(
        "origin",
        "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold".parse()?,
    );
    headers.insert("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0".parse()?);
    headers.insert(
        "cookie",
        format!(
            "muid={};",
            uuid::Uuid::new_v4().simple().to_string().to_uppercase()
        )
        .parse()?,
    );
    headers.insert("accept-language", "en-US,en;q=0.9".parse()?);
    headers.insert("pragma", "no-cache".parse()?);
    headers.insert("cache-control", "no-cache".parse()?);
    let transport = tokio::time::timeout(Duration::from_secs(12), open_transport(proxy))
        .await
        .ok()
        .and_then(Result::ok)
        .ok_or_else(|| anyhow!("无法连接 Edge 在线语音，请检查网络或代理"))?;
    let (mut ws, _) = tokio_tungstenite::client_async_tls(request, transport)
        .await
        .map_err(|err| match err {
            Error::Http(response) => {
                anyhow!("Edge 连线失败（HTTP {}）", response.status().as_u16())
            }
            _ => anyhow!("Edge 在线语音握手失败"),
        })?;

    let time =
        chrono::Utc::now().format("%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)");
    let config = serde_json::json!({"context":{"synthesis":{"audio":{
        "metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},
        "outputFormat":FORMAT
    }}}});
    ws.send(Message::Text(format!("Path:speech.config\r\nX-Timestamp:{time}\r\nContent-Type:application/json; charset=utf-8\r\n\r\n{config}\r\n").into())).await?;
    let percent = ((rate - 1.0) * 100.0).round() as i32;
    let ssml = format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='{}'><prosody rate='{percent:+}%' pitch='+0Hz' volume='+0%'>{}</prosody></voice></speak>",
        escape(voice), escape(text)
    );
    ws.send(Message::Text(format!("Path:ssml\r\nX-RequestId:{id}\r\nX-Timestamp:{time}Z\r\nContent-Type:application/ssml+xml\r\n\r\n{ssml}").into())).await?;

    let mut audio = Vec::new();
    while let Some(frame) = ws.next().await {
        match frame? {
            Message::Binary(frame) if frame.len() >= 2 => {
                let end = 2 + usize::from(u16::from_be_bytes([frame[0], frame[1]]));
                if let Some(header) = frame.get(2..end) {
                    if header
                        .split(|b| *b == b'\r')
                        .any(|line| line.strip_prefix(b"\n").unwrap_or(line) == b"Path:audio")
                    {
                        audio.extend_from_slice(&frame[end..]);
                    }
                }
            }
            Message::Text(message) if message.lines().any(|line| line == "Path:turn.end") => {
                let _ = ws.close(None).await;
                if audio.is_empty() {
                    bail!("Edge 在线语音没有返回音频");
                }
                return Ok(audio);
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    bail!("Edge 在线语音连接提前关闭")
}

pub async fn synthesize(voice: &str, text: &str, rate: f64) -> Result<Vec<u8>> {
    let mut cooldown = GATE.lock().await;
    if cooldown.is_some_and(|until| until > Instant::now()) {
        bail!("Edge 在线语音暂时限流，请稍后重试");
    }
    let voice = if voice.is_empty() {
        "zh-CN-YunxiNeural"
    } else {
        voice
    };
    let proxy = crate::net::proxy();
    let attempt = |proxy: String| async move {
        tokio::time::timeout(Duration::from_secs(45), exchange(&proxy, voice, text, rate))
            .await
            .map_err(|_| anyhow!("等待 Edge 在线语音超时"))?
    };
    let mut result = attempt(proxy.clone()).await;
    if proxy.is_empty()
        && result
            .as_ref()
            .is_err_and(|err| err.to_string().contains("无法连接"))
    {
        let fallback = crate::net::effective_proxy();
        if !fallback.is_empty() {
            result = attempt(fallback).await;
        }
    }
    if result
        .as_ref()
        .is_err_and(|err| err.to_string().contains("HTTP 429"))
    {
        *cooldown = Some(Instant::now() + Duration::from_secs(20));
    }
    result.map_err(|err| {
        if err.downcast_ref::<Error>().is_some() {
            anyhow!("Edge 在线语音连接中断")
        } else {
            err
        }
    })
}
