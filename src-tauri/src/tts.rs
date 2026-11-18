/**
 * [INPUT]: secrets.get_key；net.client；豆包 unidirectional TTS
 * [OUTPUT]: synthesize → WAV 字节（导读/精读朗读）
 * [POS]: 豆包语音合成；Key 优先 tts.doubao，回落 asr.doubao
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use anyhow::{anyhow, Result};
use base64::Engine;
use serde_json::{json, Value};

const TTS_ENDPOINT: &str = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
const TTS_RATE: u32 = 24_000;

fn wav_bytes(samples: &[f32], rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    out
}

/// 合成至多 1000 字，返回 WAV。
pub async fn synthesize(voice: &str, resource: &str, text: &str) -> Result<Vec<u8>> {
    let key = crate::secrets::get_key("tts.doubao")
        .ok()
        .flatten()
        .or_else(|| crate::secrets::get_key("asr.doubao").ok().flatten())
        .filter(|k| !k.is_empty())
        .ok_or_else(|| anyhow!("请先在设置里填写豆包语音的 API Key"))?;
    let text = text.trim();
    if text.is_empty() || text.chars().count() > 1000 {
        return Err(anyhow!("每次朗读 1–1000 个字"));
    }
    let resource = if resource.is_empty() {
        "seed-tts-2.0"
    } else {
        resource
    };
    let resp = crate::net::client()
        .post(TTS_ENDPOINT)
        .header("X-Api-Key", key)
        .header("X-Api-Resource-Id", resource)
        .header("X-Api-Request-Id", uuid::Uuid::new_v4().to_string())
        .json(&json!({
            "req_params": {
                "text": text,
                "speaker": voice,
                "audio_params": { "format": "pcm", "sample_rate": TTS_RATE }
            }
        }))
        .timeout(std::time::Duration::from_secs(180))
        .send()
        .await
        .map_err(|_| anyhow!("连不上豆包语音服务"))?;
    if !resp.status().is_success() {
        return Err(anyhow!(
            "豆包语音合成返回 HTTP {}（检查 Key 与音色）",
            resp.status()
        ));
    }
    let body = resp.text().await?;
    let mut pcm = vec![];
    for line in body.lines().filter(|l| !l.trim().is_empty()) {
        let v: Value =
            serde_json::from_str(line).map_err(|_| anyhow!("豆包返回了无法解析的音频"))?;
        let code = v["code"].as_i64().unwrap_or(0);
        if code != 0 && code != 20_000_000 {
            return Err(anyhow!(
                "豆包拒绝了合成请求（{code}）：{}",
                v["message"].as_str().unwrap_or("检查 Key、模型和音色")
            ));
        }
        if let Some(d) = v["data"].as_str() {
            base64::engine::general_purpose::STANDARD
                .decode_vec(d, &mut pcm)
                .map_err(|_| anyhow!("音频数据损坏"))?;
        }
    }
    if pcm.len() < 2 {
        return Err(anyhow!("豆包没有返回音频"));
    }
    let samples: Vec<f32> = pcm
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect();
    Ok(wav_bytes(&samples, TTS_RATE))
}
