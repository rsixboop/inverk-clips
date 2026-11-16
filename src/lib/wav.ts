// Minimal WAV (RIFF PCM16 / float32) decode, narrator-first mix with ducking, and PCM16 encode.
// Runs inside the Worker so the app owns the voice/SFX balance (fal compose has no gain control).
import Mp3 from "js-mp3";
export type Pcm = { rate: number; channels: Float32Array[] };

export function decodeWav(buf: Uint8Array): Pcm {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!);
  if (buf.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Звук не в формате WAV");
  let o = 12, fmt: { format: number; ch: number; rate: number; bits: number } | null = null, data: [number, number] | null = null;
  while (o + 8 <= buf.byteLength) {
    const id = tag(o), size = v.getUint32(o + 4, true);
    if (id === "fmt ") fmt = { format: v.getUint16(o + 8, true), ch: v.getUint16(o + 10, true), rate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    if (id === "data") { data = [o + 8, Math.min(size, buf.byteLength - o - 8)]; break; }
    o += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("WAV без fmt/data");
  const format = fmt.format === 0xfffe ? (fmt.bits === 32 ? 3 : 1) : fmt.format;
  const bps = fmt.bits / 8, frames = Math.floor(data[1] / (bps * fmt.ch));
  if (!(format === 1 && fmt.bits === 16) && !(format === 3 && fmt.bits === 32)) throw new Error(`WAV ${fmt.bits}-бит формат ${fmt.format} не поддержан`);
  const channels = Array.from({ length: fmt.ch }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) for (let c = 0; c < fmt.ch; c++) {
    const p = data[0] + (f * fmt.ch + c) * bps;
    channels[c]![f] = format === 1 ? v.getInt16(p, true) / 32768 : v.getFloat32(p, true);
  }
  return { rate: fmt.rate, channels };
}
/** MP3 (ID3 tag or MPEG frame sync) → PCM via pure-JS decoder (16-bit stereo interleaved output). */
export const isMp3 = (b: Uint8Array) => (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0);
export function decodeAudio(buf: Uint8Array): Pcm {
  if (!isMp3(buf)) return decodeWav(buf);
  const d = Mp3.newDecoder(buf.slice().buffer);
  if (!d) throw new Error("MP3 не удалось прочитать");
  const raw = d.decode(), v = new DataView(raw), frames = Math.floor(raw.byteLength / 4);
  const L = new Float32Array(frames), R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { L[i] = v.getInt16(i * 4, true) / 32768; R[i] = v.getInt16(i * 4 + 2, true) / 32768; }
  return { rate: d.sampleRate, channels: [L, R] };
}
export const wavDuration = (buf: Uint8Array) => { const p = decodeAudio(buf); return (p.channels[0]?.length ?? 0) / p.rate; };

function mono(p: Pcm, rate: number): Float32Array {
  const n = p.channels[0]?.length ?? 0, out = new Float32Array(Math.floor((n * rate) / p.rate));
  for (let i = 0; i < out.length; i++) {
    const x = (i * p.rate) / rate, a = Math.floor(x), t = x - a;
    let s = 0;
    for (const ch of p.channels) s += (ch[a] ?? 0) * (1 - t) + (ch[a + 1] ?? ch[a] ?? 0) * t;
    out[i] = s / p.channels.length;
  }
  return out;
}

export type Placed = { pcm: Pcm; at: number };
export type MixStats = { duration: number; peakDb: number; voiceRmsDb: number; sfxUnderVoiceDb: number; gapRmsDb: number; duckDb: number };
const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -120);

/** Voice at unity, SFX ducked by `duckDb` while the narrator speaks (attack 20ms, release 250ms), peak-normalised to -1 dBFS. */
export function mixNarratorFirst(voice: Placed[], sfx: Placed[], duration: number, o: { rate?: number; sfxGain?: number; duckDb?: number } = {}) {
  const rate = o.rate ?? 44100, n = Math.round(duration * rate), duckDb = o.duckDb ?? -14, sfxGain = o.sfxGain ?? 0.5;
  const V = new Float32Array(n), S = new Float32Array(n);
  const put = (dst: Float32Array, p: Placed) => { const m = mono(p.pcm, rate), off = Math.round(p.at * rate); for (let i = 0; i < m.length && off + i < n; i++) if (off + i >= 0) dst[off + i]! += m[i]!; };
  voice.forEach((p) => put(V, p)); sfx.forEach((p) => put(S, p));
  const win = Math.round(rate * 0.01), aA = Math.exp(-1 / (0.02 * rate)), aR = Math.exp(-1 / (0.25 * rate)), duck = 10 ** (duckDb / 20);
  let env = 0, gate = 0;
  const out = new Float32Array(n), speech = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (i % win === 0) { let e = 0; for (let k = i; k < Math.min(n, i + win); k++) e = Math.max(e, Math.abs(V[k]!)); gate = e > 0.02 ? 1 : 0; }
    env = gate > env ? aA * env + (1 - aA) * gate : aR * env + (1 - aR) * gate;
    speech[i] = gate;
    out[i] = V[i]! + S[i]! * sfxGain * (1 - env * (1 - duck));
  }
  let peak = 0; for (const x of out) peak = Math.max(peak, Math.abs(x));
  const g = peak > 0 ? 10 ** (-1 / 20) / peak : 1;
  let vs = 0, vn = 0, ss = 0, gs = 0, gn = 0;
  for (let i = 0; i < n; i++) { const y = out[i]! * g; out[i] = y; if (speech[i]) { vs += (V[i]! * g) ** 2; ss += (S[i]! * sfxGain * duck * g) ** 2; vn++; } else { gs += y * y; gn++; } }
  const stats: MixStats = { duration, peakDb: db(peak * g), voiceRmsDb: db(Math.sqrt(vs / Math.max(1, vn))), sfxUnderVoiceDb: db(Math.sqrt(ss / Math.max(1, vn))), gapRmsDb: db(Math.sqrt(gs / Math.max(1, gn))), duckDb };
  return { samples: out, rate, stats };
}

export function encodeWav16(samples: Float32Array, rate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i]!)) * 32767, true);
  return new Uint8Array(buf);
}
