// In-Worker MP4/MOV remux (no re-encode): concatenates the H.264 video samples of several MP4 clips
// and adds a 16-bit PCM narration track. The result is a QuickTime file that fal's permitted
// workflow-utilities/scale-video re-encodes to H.264 + AAC. Used because fal-ai/ffmpeg-api/* is
// access-denied for this account; we never bypass that, we only rearrange our own files.
import { boxes, child } from "./mp4-inspect";

type Sample = { off: number; size: number; dur: number; cto: number; sync: boolean };
export type VideoTrack = { timescale: number; entry: Uint8Array; width: number; height: number; samples: Sample[]; mediaTime: number; bytes: Uint8Array };

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const fourcc = (b: Uint8Array, p: number) => String.fromCharCode(b[p]!, b[p + 1]!, b[p + 2]!, b[p + 3]!);

/** Reads the first video track's sample table (sizes, file offsets, timing, sync flags, sample entry). */
export function readVideoTrack(b: Uint8Array): VideoTrack {
  const v = dv(b), moov = boxes(b, 0, b.byteLength).find((x) => x.type === "moov");
  if (!moov) throw new Error("В клипе нет moov");
  for (const trak of boxes(b, moov.body, moov.end).filter((x) => x.type === "trak")) {
    const mdia = child(b, trak, "mdia"), hdlr = mdia && child(b, mdia, "hdlr");
    if (!mdia || !hdlr || fourcc(b, hdlr.body + 8) !== "vide") continue;
    const mdhd = child(b, mdia, "mdhd")!, ver = b[mdhd.body]!;
    const timescale = v.getUint32(mdhd.body + (ver === 1 ? 20 : 12));
    const stbl = child(b, child(b, mdia, "minf")!, "stbl")!;
    const get = (t: string) => child(b, stbl, t);
    const stsd = get("stsd")!;
    if (v.getUint32(stsd.body + 4) !== 1) throw new Error("Клип с несколькими описаниями видео не поддерживается");
    const ePos = stsd.body + 8, entry = b.slice(ePos, ePos + v.getUint32(ePos));
    if (!/^avc[13]$/.test(fourcc(entry, 4))) throw new Error(`Видеокодек ${fourcc(entry, 4)}, нужен H.264`);
    const width = dv(entry).getUint16(32), height = dv(entry).getUint16(34);
    const stsz = get("stsz")!, fixed = v.getUint32(stsz.body + 4), n = v.getUint32(stsz.body + 8);
    const sizes = Array.from({ length: n }, (_, i) => fixed || v.getUint32(stsz.body + 12 + i * 4));
    const durs: number[] = [], stts = get("stts")!;
    for (let i = 0, c = v.getUint32(stts.body + 4); i < c; i++) { const cnt = v.getUint32(stts.body + 8 + i * 8), d = v.getUint32(stts.body + 12 + i * 8); for (let k = 0; k < cnt; k++) durs.push(d); }
    const ctos: number[] = [], ctts = get("ctts");
    if (ctts) for (let i = 0, c = v.getUint32(ctts.body + 4); i < c; i++) { const cnt = v.getUint32(ctts.body + 8 + i * 8), o = v.getInt32(ctts.body + 12 + i * 8); for (let k = 0; k < cnt; k++) ctos.push(o); }
    const stss = get("stss"), sync = new Set<number>();
    if (stss) for (let i = 0, c = v.getUint32(stss.body + 4); i < c; i++) sync.add(v.getUint32(stss.body + 8 + i * 4) - 1);
    const stco = get("stco"), co64 = get("co64"), co = (stco ?? co64)!, chunks = v.getUint32(co.body + 4);
    const chunkOff = (k: number) => stco ? v.getUint32(co.body + 8 + k * 4) : Number(v.getBigUint64(co.body + 8 + k * 8));
    const stsc = get("stsc")!, sc = Array.from({ length: v.getUint32(stsc.body + 4) }, (_, i) => ({ first: v.getUint32(stsc.body + 8 + i * 12), spc: v.getUint32(stsc.body + 12 + i * 12) }));
    const samples: Sample[] = []; let s = 0;
    for (let k = 0; k < chunks && s < n; k++) {
      let spc = 0; for (const e of sc) if (e.first <= k + 1) spc = e.spc;
      let off = chunkOff(k);
      for (let j = 0; j < spc && s < n; j++, s++) { samples.push({ off, size: sizes[s]!, dur: durs[s] ?? durs.at(-1) ?? 1, cto: ctos[s] ?? 0, sync: !stss || sync.has(s) }); off += sizes[s]!; }
    }
    if (samples.length !== n || samples.some((x) => x.off + x.size > b.byteLength)) throw new Error("Таблица кадров клипа повреждена");
    let mediaTime = 0; const edts = child(b, trak, "edts"), elst = edts && child(b, edts, "elst");
    if (elst && v.getUint32(elst.body + 4) > 0) mediaTime = b[elst.body] === 1 ? Number(v.getBigInt64(elst.body + 16)) : v.getInt32(elst.body + 12);
    if (mediaTime < 0) mediaTime = 0;
    return { timescale, entry, width, height, samples, mediaTime, bytes: b };
  }
  throw new Error("В клипе нет видеодорожки");
}

// ---- box writers ----
const u32 = (n: number) => { const a = new Uint8Array(4); dv(a).setUint32(0, n >>> 0); return a; };
const i32 = (n: number) => { const a = new Uint8Array(4); dv(a).setInt32(0, n); return a; };
const u16 = (n: number) => { const a = new Uint8Array(2); dv(a).setUint16(0, n); return a; };
const str = (s: string) => new TextEncoder().encode(s);
const cat = (parts: Uint8Array[]) => { const n = parts.reduce((a, p) => a + p.byteLength, 0), o = new Uint8Array(n); let p = 0; for (const x of parts) { o.set(x, p); p += x.byteLength; } return o; };
const box = (type: string, ...parts: Uint8Array[]) => { const body = cat(parts); return cat([u32(body.byteLength + 8), str(type), body]); };
const full = (type: string, ver: number, flags: number, ...parts: Uint8Array[]) => box(type, u32(((ver & 255) << 24) | (flags & 0xffffff)), ...parts);
const zeros = (n: number) => new Uint8Array(n);
const MATRIX = cat([0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32));
const runs = (xs: number[]) => { const r: [number, number][] = []; for (const x of xs) { const l = r.at(-1); if (l && l[1] === x) l[0]++; else r.push([1, x]); } return r; };

function trak(id: number, kind: "vide" | "soun", movieDur: number, mediaTs: number, mediaDur: number, w: number, h: number, mediaTime: number, stbl: Uint8Array) {
  const tkhd = full("tkhd", 0, 3, zeros(8), u32(id), zeros(4), u32(movieDur), zeros(8), u16(0), u16(0), u16(kind === "soun" ? 0x100 : 0), zeros(2), MATRIX, u32(w << 16), u32(h << 16));
  const edts = mediaTime > 0 ? [box("edts", full("elst", 0, 0, u32(1), u32(movieDur), i32(mediaTime), u32(0x10000)))] : [];
  const mdhd = full("mdhd", 0, 0, zeros(8), u32(mediaTs), u32(mediaDur), u16(0x55c4), u16(0));
  const hdlr = full("hdlr", 0, 0, zeros(4), str(kind), zeros(12), str(kind === "vide" ? "VideoHandler\0" : "SoundHandler\0"));
  const mhd = kind === "vide" ? full("vmhd", 0, 1, zeros(8)) : full("smhd", 0, 0, zeros(4));
  const dinf = box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1)));
  return box("trak", tkhd, ...edts, box("mdia", mdhd, hdlr, box("minf", mhd, dinf, stbl)));
}

/** Concatenate H.264 clips (in order) and attach mono/stereo 16-bit PCM audio. Returns MOV bytes. */
export function muxClipsWithPcm(clips: Uint8Array[], pcm: { samples: Float32Array; rate: number }): Uint8Array {
  if (!clips.length) throw new Error("Нет клипов для сборки");
  const tracks = clips.map(readVideoTrack), ts = tracks[0]!.timescale, { width, height } = tracks[0]!;
  if (tracks.some((t) => t.width !== width || t.height !== height)) throw new Error("Клипы разного размера — сначала приведите к 1080×1920");
  // Deduplicate identical sample entries (same SPS/PPS); otherwise one entry per clip.
  const entries: Uint8Array[] = [], sdi = tracks.map((t) => {
    const k = entries.findIndex((e) => e.byteLength === t.entry.byteLength && e.every((x, i) => x === t.entry[i]));
    if (k >= 0) return k + 1; entries.push(t.entry); return entries.length;
  });
  const sc = (x: number, t: VideoTrack) => Math.round((x * ts) / t.timescale);
  const all = tracks.flatMap((t) => t.samples.map((s) => ({ ...s, dur: sc(s.dur, t), cto: sc(s.cto, t), src: t.bytes })));
  const videoBytes = all.reduce((a, s) => a + s.size, 0);
  const pcmBytes = pcm.samples.length * 2;
  const ftyp = box("ftyp", str("qt  "), u32(0x200), str("qt  "));
  const mdatHeader = 8, dataStart = ftyp.byteLength + mdatHeader;
  // mdat: each clip is one chunk, then the PCM as a single chunk.
  const mdat = new Uint8Array(mdatHeader + videoBytes + pcmBytes); dv(mdat).setUint32(0, mdat.byteLength); mdat.set(str("mdat"), 4);
  let p = mdatHeader; const chunkOffsets: number[] = [];
  for (const t of tracks) { chunkOffsets.push(dataStart + p - mdatHeader); for (const s of t.samples) { mdat.set(t.bytes.subarray(s.off, s.off + s.size), p); p += s.size; } }
  const audioOff = dataStart + p - mdatHeader, av = dv(mdat);
  for (let i = 0; i < pcm.samples.length; i++, p += 2) av.setInt16(p, Math.max(-32768, Math.min(32767, Math.round(pcm.samples[i]! * 32767))), true);

  const vDur = all.reduce((a, s) => a + s.dur, 0), mediaTime = tracks[0]!.mediaTime ? sc(tracks[0]!.mediaTime, tracks[0]!) : 0;
  const movieV = Math.round(((vDur - mediaTime) * 1000) / ts), movieA = Math.round((pcm.samples.length * 1000) / pcm.rate);
  const stts = runs(all.map((s) => s.dur)), ctts = runs(all.map((s) => s.cto)), hasCtts = all.some((s) => s.cto !== 0);
  const stscRows: Uint8Array[] = []; let prev = "";
  tracks.forEach((t, i) => { const key = `${t.samples.length}:${sdi[i]}`; if (key !== prev) stscRows.push(cat([u32(i + 1), u32(t.samples.length), u32(sdi[i]!)])); prev = key; });
  const vStbl = box("stbl",
    full("stsd", 0, 0, u32(entries.length), ...entries),
    full("stts", 0, 0, u32(stts.length), ...stts.flatMap(([c, d]) => [u32(c), u32(d)])),
    ...(hasCtts ? [full("ctts", all.some((s) => s.cto < 0) ? 1 : 0, 0, u32(ctts.length), ...ctts.flatMap(([c, o]) => [u32(c), i32(o)]))] : []),
    ...(all.every((s) => s.sync) ? [] : [full("stss", 0, 0, u32(all.filter((s) => s.sync).length), ...all.flatMap((s, i) => (s.sync ? [u32(i + 1)] : [])))]),
    full("stsz", 0, 0, u32(0), u32(all.length), ...all.map((s) => u32(s.size))),
    full("stsc", 0, 0, u32(stscRows.length), ...stscRows),
    full("stco", 0, 0, u32(chunkOffsets.length), ...chunkOffsets.map(u32)));
  const sowt = box("sowt", zeros(6), u16(1), u16(0), u16(0), zeros(4), u16(1), u16(16), u16(0), u16(0), u32(pcm.rate * 65536));
  const aStbl = box("stbl", full("stsd", 0, 0, u32(1), sowt), full("stts", 0, 0, u32(1), u32(pcm.samples.length), u32(1)),
    full("stsz", 0, 0, u32(2), u32(pcm.samples.length)), full("stsc", 0, 0, u32(1), u32(1), u32(pcm.samples.length), u32(1)), full("stco", 0, 0, u32(1), u32(audioOff)));
  const dur = Math.max(movieV, movieA);
  const mvhd = full("mvhd", 0, 0, zeros(8), u32(1000), u32(dur), u32(0x10000), u16(0x100), zeros(10), MATRIX, zeros(24), u32(3));
  const moov = box("moov", mvhd, trak(1, "vide", movieV, ts, vDur, width, height, mediaTime, vStbl), trak(2, "soun", movieA, pcm.rate, pcm.samples.length, 0, 0, 0, aStbl));
  if (ftyp.byteLength + mdat.byteLength > 0xffffffff) throw new Error("Сборка слишком большая");
  return cat([ftyp, mdat, moov]);
}
