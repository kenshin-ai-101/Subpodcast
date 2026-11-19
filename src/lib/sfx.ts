/**
 * [INPUT]: settings.learnSounds；Web Audio
 * [OUTPUT]: keySound / wrongSound / rightSound / doneSound
 * [POS]: 拼写复习反馈音；无外部音频文件
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useStore } from "../store";

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (!useStore.getState().settings.learnSounds) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(
  a: AudioContext,
  freq: number,
  at: number,
  len: number,
  gain: number,
  type: OscillatorType = "sine",
  to?: number,
) {
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  if (to) o.frequency.exponentialRampToValueAtTime(to, at + len);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  o.connect(g).connect(a.destination);
  o.start(at);
  o.stop(at + len + 0.02);
}

let noise: AudioBuffer | null = null;

/** 按键轻响。 */
export function keySound() {
  const a = audio();
  if (!a) return;
  if (!noise) {
    noise = a.createBuffer(1, Math.floor(a.sampleRate * 0.03), a.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
  }
  const src = a.createBufferSource();
  src.buffer = noise;
  const f = a.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = 2400 + Math.random() * 900;
  f.Q.value = 1.4;
  const g = a.createGain();
  g.gain.value = 0.55;
  src.connect(f).connect(g).connect(a.destination);
  src.start();
  tone(a, 140 + Math.random() * 30, a.currentTime, 0.035, 0.05, "triangle");
}

/** 拼错一字母。 */
export function wrongSound() {
  const a = audio();
  if (!a) return;
  tone(a, 220, a.currentTime, 0.16, 0.12, "square", 150);
}

/** 拼对整词。 */
export function rightSound() {
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  tone(a, 784, t, 0.18, 0.16, "triangle");
  tone(a, 1175, t + 0.09, 0.32, 0.14, "triangle");
  tone(a, 2350, t + 0.09, 0.25, 0.025);
}

/** 本日复习结束。 */
export function doneSound() {
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  [523, 659, 784, 1047].forEach((f, i) => tone(a, f, t + i * 0.09, 0.35, 0.12, "triangle"));
}
