//! [INPUT]: 引擎与音色配置、secrets、net、系统及本地朗读程序
//! [OUTPUT]: 朗读音频的本机路径和时长、系统音色、缓存管理
//! [POS]: 统一合成入口；云端凭据只在 Rust 侧解析
//! [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

use anyhow::{anyhow, bail, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const CACHE_LIMIT: u64 = 500 * 1024 * 1024;
static CACHE: std::sync::Mutex<u64> = std::sync::Mutex::new(0);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsRequest {
    engine: String,
    protocol: String,
    base_url: Option<String>,
    model: Option<String>,
    voice: String,
    resource: Option<String>,
    text: String,
    rate: Option<f64>,
    needs_key: Option<bool>,
}

#[derive(Serialize)]
pub struct TtsResult {
    path: String,
    seconds: f64,
}

#[derive(Serialize)]
pub struct SystemVoice {
    id: String,
    name: String,
    lang: String,
}

pub fn cache_dir(data: &Path) -> PathBuf {
    data.join("tts-cache")
}

pub fn clear_cache(data: &Path) -> Result<()> {
    let mut version = CACHE.lock().map_err(|_| anyhow!("无法访问朗读缓存"))?;
    let dir = cache_dir(data);
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    *version = version.wrapping_add(1);
    Ok(())
}

fn prune(dir: &Path, newest: &Path) {
    let Ok(entries) = dir.read_dir() else { return };
    let mut files: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            meta.is_file().then(|| {
                (
                    meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    meta.len(),
                    entry.path(),
                )
            })
        })
        .collect();
    let mut total: u64 = files.iter().map(|(_, size, _)| size).sum();
    files.sort_unstable();
    for (_, size, file) in files {
        if total <= CACHE_LIMIT {
            break;
        }
        if file != newest && std::fs::remove_file(file).is_ok() {
            total -= size;
        }
    }
}

fn duration(path: &Path) -> Result<f64> {
    use symphonia::core::{
        formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions, probe::Hint,
    };
    let source = MediaSourceStream::new(Box::new(std::fs::File::open(path)?), Default::default());
    let mut format = symphonia::default::get_probe()
        .format(
            &Hint::new(),
            source,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )?
        .format;
    let track = format
        .default_track()
        .ok_or_else(|| anyhow!("未找到音轨"))?;
    let track_id = track.id;
    let p = &track.codec_params;
    if let (Some(frames), Some(rate)) = (p.n_frames, p.sample_rate) {
        if frames > 0 && rate > 0 {
            return Ok(frames as f64 / f64::from(rate));
        }
    }
    let time_base = p
        .time_base
        .or_else(|| {
            p.sample_rate
                .filter(|&rate| rate > 0)
                .map(|rate| symphonia::core::units::TimeBase::new(1, rate))
        })
        .ok_or_else(|| anyhow!("无法读取音频时长"))?;
    let mut end = 0;
    while let Ok(packet) = format.next_packet() {
        if packet.track_id() == track_id {
            end = end.max(packet.ts.saturating_add(packet.dur));
        }
    }
    if end == 0 {
        bail!("音频为空");
    }
    let t = time_base.calc_time(end);
    Ok(t.seconds as f64 + t.frac)
}

fn cached(dir: &Path, key: &str) -> Option<TtsResult> {
    for ext in ["wav", "mp3", "ogg", "flac", "m4a", "aac"] {
        let path = dir.join(format!("{key}.{ext}"));
        if let Ok(seconds) = duration(&path) {
            if let Ok(file) = std::fs::File::options().write(true).open(&path) {
                let _ = file.set_modified(SystemTime::now());
            }
            return Some(TtsResult {
                path: path.to_string_lossy().into_owned(),
                seconds,
            });
        }
    }
    None
}

pub fn resolve_key(engine: &str) -> Option<String> {
    let shared: &[&str] = match engine {
        "doubao" => &["asr.doubao", "doubao"],
        "deepseek" => &["deepseek", "asr.deepseek"],
        "siliconflow" => &["siliconflow", "asr.siliconflow"],
        "qwen" => &["qwen-cn"],
        "minimax" => &["minimax-cn"],
        "openai" => &["openai", "asr.openai"],
        "mimo" | "elevenlabs" => &[engine],
        _ => &[],
    };
    let own = format!("tts.{engine}");
    std::iter::once(own.as_str())
        .chain(shared.iter().copied())
        .find_map(|account| {
            crate::secrets::get_key(account)
                .ok()
                .flatten()
                .filter(|key| !key.trim().is_empty())
        })
}

pub async fn synthesize(data: &Path, req: TtsRequest) -> Result<TtsResult> {
    let text = req.text.trim();
    if text.is_empty() || text.chars().count() > 1000 {
        bail!("每次朗读 1–1000 个字");
    }
    let rate = req.rate.unwrap_or(1.0).clamp(0.8, 1.5);
    let voice = req.voice.trim();
    let key = hex::encode(Sha256::digest(serde_json::to_vec(&(
        1,
        &req.engine,
        &req.protocol,
        &req.base_url,
        &req.model,
        voice,
        &req.resource,
        text,
        rate,
    ))?));
    let dir = cache_dir(data);
    let version = {
        let current = CACHE.lock().map_err(|_| anyhow!("无法访问朗读缓存"))?;
        if let Some(result) = cached(&dir, &key) {
            return Ok(result);
        }
        *current
    };

    let (mut audio, format) = match req.protocol.as_str() {
        "edge" => (crate::edge_tts::synthesize(voice, text, rate).await?, "mp3"),
        "system" => (system_audio(voice, text, rate).await?, "wav"),
        "local" => (
            crate::local_tts::synthesize(
                data,
                req.model.as_deref().unwrap_or(""),
                voice,
                text,
                rate,
            )
            .await?,
            "wav",
        ),
        "doubao" => {
            let voice = present(Some(voice), "zh_female_vv_uranus_bigtts");
            (
                crate::tts::synthesize_at_rate(
                    voice,
                    req.resource.as_deref().unwrap_or(""),
                    text,
                    rate,
                )
                .await?,
                "wav",
            )
        }
        _ => cloud_audio(&req, text, rate).await?,
    };
    if audio.len() as u64 > CACHE_LIMIT {
        bail!("朗读音频超过缓存大小限制");
    }
    let ext = if audio.starts_with(b"RIFF") && audio.get(8..12) == Some(b"WAVE") {
        fix_wav_lengths(&mut audio);
        "wav"
    } else if audio.starts_with(b"ID3") {
        "mp3"
    } else if audio.starts_with(b"fLaC") {
        "flac"
    } else if audio.starts_with(b"OggS") {
        "ogg"
    } else if audio.get(4..8) == Some(b"ftyp") {
        "m4a"
    } else {
        format
    };
    let current = CACHE.lock().map_err(|_| anyhow!("无法访问朗读缓存"))?;
    if *current != version {
        bail!("朗读缓存已清理，请重新朗读");
    }
    if let Some(result) = cached(&dir, &key) {
        return Ok(result);
    }
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{key}.{ext}"));
    let mut stage = tempfile::NamedTempFile::new_in(&dir)?;
    stage.write_all(&audio)?;
    let seconds = duration(stage.path()).map_err(|_| anyhow!("朗读服务返回了无法播放的音频"))?;
    stage.persist(&file)?;
    prune(&dir, &file);
    Ok(TtsResult {
        path: file.to_string_lossy().into_owned(),
        seconds,
    })
}

// DeepSeek 的流式 WAV 可以用占位长度。只修复这类头部，保留正常文件的块及尾部元数据。
fn fix_wav_lengths(audio: &mut [u8]) {
    let riff_size = audio.len().saturating_sub(8) as u32;
    if audio[4..8] == [0xff; 4] || audio[4..8] == [0; 4] {
        audio[4..8].copy_from_slice(&riff_size.to_le_bytes());
    }
    let mut offset = 12;
    while offset + 8 <= audio.len() {
        let size = u32::from_le_bytes(audio[offset + 4..offset + 8].try_into().unwrap()) as usize;
        if &audio[offset..offset + 4] == b"data" {
            if size == u32::MAX as usize || size == 0 {
                let real_size = (audio.len() - offset - 8) as u32;
                audio[offset + 4..offset + 8].copy_from_slice(&real_size.to_le_bytes());
            }
            break;
        }
        offset = offset.saturating_add(8 + size.saturating_add(size % 2));
    }
}

fn present<'a>(value: Option<&'a str>, default: &'a str) -> &'a str {
    value
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .unwrap_or(default)
}

fn endpoint(base: &str, suffix: &str) -> String {
    if base.ends_with(suffix) {
        base.to_owned()
    } else {
        format!("{base}{suffix}")
    }
}

async fn request(builder: reqwest::RequestBuilder) -> Result<reqwest::Response> {
    let response = builder
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|_| anyhow!("无法连接朗读服务，请检查网络或代理"))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        if matches!(status, 401 | 403) {
            bail!("朗读服务拒绝访问（HTTP {status}），请检查 Key 和权限");
        }
        bail!("朗读服务返回 HTTP {status}");
    }
    Ok(response)
}

async fn response_json(response: reqwest::Response) -> Result<Value> {
    response
        .json()
        .await
        .map_err(|_| anyhow!("朗读服务的响应无法解析"))
}

async fn response_audio(response: reqwest::Response) -> Result<Vec<u8>> {
    response
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|_| anyhow!("读取朗读音频失败"))
}

fn decode_audio(value: &Value) -> Result<Vec<u8>> {
    let data = value
        .as_str()
        .filter(|data| !data.is_empty())
        .ok_or_else(|| anyhow!("朗读服务没有返回音频"))?;
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| anyhow!("朗读音频解码失败"))
}

async fn cloud_audio(req: &TtsRequest, text: &str, rate: f64) -> Result<(Vec<u8>, &'static str)> {
    let client = crate::net::client();
    let key = resolve_key(&req.engine);
    if key.is_none() && (req.engine != "custom" || req.needs_key == Some(true)) {
        bail!("请先在「设置 › 朗读」填写 API Key");
    }
    let key = key.as_deref().unwrap_or("");
    let base = |default| present(req.base_url.as_deref(), default).trim_end_matches('/');
    let model = |default| present(req.model.as_deref(), default);
    let voice = |default| present(Some(&req.voice), default);
    match req.protocol.as_str() {
        "openai" => {
            let default = match req.engine.as_str() {
                "openai" => "https://api.openai.com/v1",
                "siliconflow" => "https://api.siliconflow.cn/v1",
                _ => "",
            };
            let base = base(default);
            if base.is_empty() {
                bail!("请先填写朗读接口地址");
            }
            let model = model("tts-1");
            let selected = voice("alloy");
            let selected = if req.engine == "siliconflow"
                && [
                    "alex", "anna", "bella", "benjamin", "charles", "claire", "david", "diana",
                ]
                .contains(&selected)
            {
                format!("{model}:{selected}")
            } else {
                selected.to_owned()
            };
            let mut payload = json!({"model":model,"input":text,"voice":selected,"speed":rate,"response_format":"mp3"});
            if req.engine == "siliconflow" {
                payload["sample_rate"] = json!(32000);
            }
            let mut builder = client.post(endpoint(base, "/audio/speech")).json(&payload);
            if !key.is_empty() {
                builder = builder.bearer_auth(key);
            }
            Ok((response_audio(request(builder).await?).await?, "mp3"))
        }
        "deepseek" => {
            let base = base("https://api.deepseek.com");
            let suffix = if base.ends_with("/v1") {
                "/tools/tts"
            } else {
                "/v1/tools/tts"
            };
            let url = if base.ends_with("/tools/tts") {
                base.to_owned()
            } else {
                endpoint(base, suffix)
            };
            let builder = client.post(url).bearer_auth(key)
                .json(&json!({"text":text,"voice_id":voice("stella"),"format":"wav","filter_markdown":true}));
            Ok((response_audio(request(builder).await?).await?, "wav"))
        }
        "mimo" => {
            let builder = client
                .post(endpoint(
                    base("https://api.xiaomimimo.com/v1"),
                    "/chat/completions",
                ))
                .header("api-key", key)
                .json(&json!({
                    "model": model("mimo-v2.5-tts"),
                    "messages": [
                        {"role":"user","content":format!("请以正常语速的 {rate:.2} 倍朗读。")},
                        {"role":"assistant","content":text}
                    ],
                    "audio":{"format":"wav","voice":voice("mimo_default")}
                }));
            let v = response_json(request(builder).await?).await?;
            Ok((
                decode_audio(&v["choices"][0]["message"]["audio"]["data"])?,
                "wav",
            ))
        }
        "qwen" => {
            let url = base("https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
            let builder = client.post(url).bearer_auth(key).json(&json!({
                "model":model("qwen3-tts-flash"),"input":{"text":text,"voice":voice("Cherry"),"language_type":"Auto"}
            }));
            let v = response_json(request(builder).await?).await?;
            let audio = &v["output"]["audio"];
            if audio["data"].as_str().is_some_and(|data| !data.is_empty()) {
                return Ok((decode_audio(&audio["data"])?, "wav"));
            }
            let url = audio["url"]
                .as_str()
                .filter(|url| url.starts_with("https://"))
                .ok_or_else(|| anyhow!("通义语音未返回音频地址"))?;
            Ok((
                response_audio(request(client.get(url)).await?).await?,
                "wav",
            ))
        }
        "minimax" => {
            let builder = client.post(endpoint(base("https://api.minimaxi.com/v1"), "/t2a_v2"))
                .bearer_auth(key).json(&json!({
                    "model":model("speech-02-hd"),"text":text,"stream":false,"output_format":"hex",
                    "voice_setting":{"voice_id":voice("male-qn-qingse"),"speed":rate,"vol":1,"pitch":0},
                    "audio_setting":{"sample_rate":32000,"bitrate":128000,"format":"mp3","channel":1}
                }));
            let v = response_json(request(builder).await?).await?;
            let status = v["base_resp"]["status_code"].as_i64().unwrap_or_default();
            if status != 0 {
                bail!("MiniMax 合成失败（{status}）");
            }
            let data = v["data"]["audio"]
                .as_str()
                .ok_or_else(|| anyhow!("MiniMax 未返回音频"))?;
            Ok((
                hex::decode(data).map_err(|_| anyhow!("MiniMax 音频解码失败"))?,
                "mp3",
            ))
        }
        "elevenlabs" => {
            let voice = urlencoding::encode(voice("JBFqnCBsd6RMkjVDRZzb"));
            let url = format!(
                "{}/text-to-speech/{voice}",
                base("https://api.elevenlabs.io/v1")
            );
            let builder = client.post(url).header("xi-api-key", key).header("Accept", "audio/mpeg").json(&json!({
                "text":text,"model_id":model("eleven_multilingual_v2"),
                "voice_settings":{"stability":0.5,"similarity_boost":0.75,"speed":rate.clamp(0.8,1.2)}
            }));
            Ok((response_audio(request(builder).await?).await?, "mp3"))
        }
        _ => Err(anyhow!("未知的朗读协议")),
    }
}

fn system_voice(name: &str, lang: &str) -> SystemVoice {
    SystemVoice {
        id: name.into(),
        name: name.into(),
        lang: lang.replace('_', "-"),
    }
}

#[cfg(target_os = "macos")]
pub fn list_system_voices() -> Vec<SystemVoice> {
    let Ok(output) = std::process::Command::new("/usr/bin/say")
        .args(["-v", "?"])
        .output()
    else {
        return vec![];
    };
    let mut items: Vec<_> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let (columns, _) = line.split_once('#')?;
            let (name, lang) = columns.trim_end().rsplit_once(char::is_whitespace)?;
            let name = name.trim();
            let novelty = [
                "Albert",
                "Bad News",
                "Bahh",
                "Bells",
                "Boing",
                "Bubbles",
                "Cellos",
                "Good News",
                "Jester",
                "Junior",
                "Kathy",
                "Organ",
                "Ralph",
                "Superstar",
                "Trinoids",
                "Whisper",
                "Wobble",
                "Zarvox",
            ];
            (!name.is_empty() && !novelty.contains(&name)).then(|| system_voice(name, lang))
        })
        .collect();
    items.sort_by_key(|v| {
        let lang = if v.lang.starts_with("zh") {
            0
        } else if v.lang.starts_with("en") {
            1
        } else {
            2
        };
        let quality = if v.name.contains("Premium") {
            0
        } else if v.name.contains("Enhanced") {
            1
        } else {
            2
        };
        (lang, quality, v.name.clone())
    });
    items.dedup_by(|a, b| a.id == b.id && a.lang == b.lang);
    items
}

#[cfg(windows)]
pub fn list_system_voices() -> Vec<SystemVoice> {
    use std::os::windows::process::CommandExt;
    let script = r#"[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
$speech.GetInstalledVoices() | Where-Object Enabled | ForEach-Object { $_.VoiceInfo.Name + [char]9 + $_.VoiceInfo.Culture.Name }"#;
    let Ok(out) = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(0x08000000)
        .output()
    else {
        return vec![];
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let (name, lang) = line.split_once('\t')?;
            Some(system_voice(name, lang))
        })
        .collect()
}

#[cfg(not(any(windows, target_os = "macos")))]
fn espeak() -> Option<&'static str> {
    ["espeak-ng", "espeak"].into_iter().find(|program| {
        std::process::Command::new(program)
            .arg("--version")
            .output()
            .is_ok_and(|r| r.status.success())
    })
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn list_system_voices() -> Vec<SystemVoice> {
    espeak()
        .map(|_| vec![system_voice("cmn", "zh-CN"), system_voice("en-us", "en-US")])
        .unwrap_or_default()
}

async fn system_audio(voice: &str, text: &str, rate: f64) -> Result<Vec<u8>> {
    let voice = voice.to_owned();
    let text = text.to_owned();
    tokio::task::spawn_blocking(move || {
        let work = tempfile::tempdir()?;
        let input = work.path().join("text.txt");
        let output = work.path().join("speech.wav");
        std::fs::write(&input, &text)?;
        let chosen = if voice.is_empty() {
            let chinese = text.chars().any(|c| ('\u{3400}'..='\u{9fff}').contains(&c));
            let lang = if chinese { "zh-CN" } else { "en-US" };
            let available = list_system_voices();
            available
                .iter()
                .find(|v| {
                    v.lang == lang && (v.name.contains("Premium") || v.name.contains("Enhanced"))
                })
                .or_else(|| {
                    available.iter().find(|v| {
                        v.lang == lang
                            && (v.name.starts_with("Samantha") || v.name.starts_with("Tingting"))
                    })
                })
                .or_else(|| available.iter().find(|v| v.lang == lang))
                .map(|v| v.id.clone())
                .unwrap_or_default()
        } else {
            voice
        };
        #[cfg(target_os = "macos")]
        let executed = {
            let mut command = std::process::Command::new("/usr/bin/say");
            if !chosen.is_empty() {
                command.args(["-v", &chosen]);
            }
            command
                .args([
                    "--file-format=WAVE",
                    "--data-format=LEI16@24000",
                    "-r",
                    &format!("{:.0}", 180.0 * rate),
                ])
                .arg("-f")
                .arg(input)
                .arg("-o")
                .arg(&output)
                .output()
        };
        #[cfg(windows)]
        let executed = {
            use std::os::windows::process::CommandExt;
            let script = r#"$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($env:SUBPODCAST_TTS_VOICE) { $speech.SelectVoice($env:SUBPODCAST_TTS_VOICE) }
$speech.Rate = [int]$env:SUBPODCAST_TTS_RATE
$speech.SetOutputToWaveFile($env:SUBPODCAST_TTS_OUTPUT)
$speech.Speak([IO.File]::ReadAllText($env:SUBPODCAST_TTS_TEXT))
$speech.Dispose()"#;
            std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .env("SUBPODCAST_TTS_VOICE", chosen)
                .env(
                    "SUBPODCAST_TTS_RATE",
                    ((rate - 1.0) * 10.0).round().to_string(),
                )
                .env("SUBPODCAST_TTS_TEXT", input)
                .env("SUBPODCAST_TTS_OUTPUT", &output)
                .creation_flags(0x08000000)
                .output()
        };
        #[cfg(not(any(windows, target_os = "macos")))]
        let executed = {
            let program = espeak().ok_or_else(|| anyhow!("此系统缺少可用的离线系统语音"))?;
            let mut command = std::process::Command::new(program);
            if !chosen.is_empty() {
                command.args(["-v", &chosen]);
            }
            command
                .args(["-s", &format!("{:.0}", 175.0 * rate)])
                .arg("-f")
                .arg(input)
                .arg("-w")
                .arg(&output)
                .output()
        };
        if !executed.is_ok_and(|out| out.status.success()) {
            bail!("系统语音合成失败，请检查音色是否已安装");
        }
        Ok(std::fs::read(output)?)
    })
    .await?
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn system_audio_uses_disk_cache() {
        let data = tempfile::tempdir().unwrap();
        let req = || TtsRequest {
            engine: "system".into(),
            protocol: "system".into(),
            base_url: None,
            model: None,
            voice: String::new(),
            resource: None,
            text: "This is a Subpodcast speech test.".into(),
            rate: Some(1.1),
            needs_key: None,
        };
        let first = synthesize(data.path(), req()).await.unwrap();
        assert!(first.seconds > 0.1);
        assert!(Path::new(&first.path).starts_with(cache_dir(data.path())));
        let cached = synthesize(data.path(), req()).await.unwrap();
        assert_eq!(first.path, cached.path);
        assert_eq!(first.seconds, cached.seconds);
        assert_eq!(cache_dir(data.path()).read_dir().unwrap().count(), 1);
        clear_cache(data.path()).unwrap();
        assert!(!Path::new(&first.path).exists());
    }

    #[tokio::test]
    #[ignore = "需要访问 Edge 在线语音"]
    async fn edge_audio_uses_disk_cache() {
        let data = tempfile::tempdir().unwrap();
        let req = TtsRequest {
            engine: "edge".into(),
            protocol: "edge".into(),
            base_url: None,
            model: None,
            voice: "zh-CN-XiaoxiaoNeural".into(),
            resource: None,
            text: "你好，欢迎使用声译。".into(),
            rate: Some(1.0),
            needs_key: None,
        };
        let result = synthesize(data.path(), req).await.unwrap();
        assert!(result.path.ends_with(".mp3") && result.seconds > 0.1);
    }
}
