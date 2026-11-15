// Minimal ISO-BMFF (MP4) metadata reader: verifies the real container/codec/dimensions of a
// rendered output before we claim success. Pure function, unit-tested with real ffmpeg fixtures.
export type Mp4Info = { brand: string; video: { codec: string; width: number; height: number } | null; audio: { codec: string } | null; durationS: number | null };

type Box = { type: string; start: number; end: number; body: number };
function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = v.getUint32(p);
    const type = String.fromCharCode(b[p + 4]!, b[p + 5]!, b[p + 6]!, b[p + 7]!);
    let body = p + 8;
    if (size === 1) { if (p + 16 > end) break; size = Number(v.getBigUint64(p + 8)); body = p + 16; }
    else if (size === 0) size = end - p;
    if (size < 8 || p + size > end) break;
    out.push({ type, start: p, end: p + size, body });
    p += size;
  }
  return out;
}
const child = (b: Uint8Array, parent: Box, type: string) => boxes(b, parent.body, parent.end).find((x) => x.type === type);

export function inspectMp4(b: Uint8Array): Mp4Info {
  const top = boxes(b, 0, b.byteLength);
  const ftyp = top.find((x) => x.type === "ftyp");
  if (!ftyp || top[0] !== ftyp) throw new Error("Нет заголовка ftyp — это не MP4");
  const brand = String.fromCharCode(...b.slice(ftyp.body, ftyp.body + 4));
  const moov = top.find((x) => x.type === "moov");
  if (!moov) throw new Error("В MP4 нет блока moov (файл неполный)");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let durationS: number | null = null;
  const mvhd = child(b, moov, "mvhd");
  if (mvhd) {
    const ver = b[mvhd.body]!;
    const ts = ver === 1 ? v.getUint32(mvhd.body + 20) : v.getUint32(mvhd.body + 12);
    const dur = ver === 1 ? Number(v.getBigUint64(mvhd.body + 24)) : v.getUint32(mvhd.body + 16);
    if (ts) durationS = dur / ts;
  }
  let video: Mp4Info["video"] = null, audio: Mp4Info["audio"] = null;
  for (const trak of boxes(b, moov.body, moov.end).filter((x) => x.type === "trak")) {
    const mdia = child(b, trak, "mdia"); if (!mdia) continue;
    const hdlr = child(b, mdia, "hdlr"); if (!hdlr) continue;
    const handler = String.fromCharCode(...b.slice(hdlr.body + 8, hdlr.body + 12));
    const minf = child(b, mdia, "minf"); const stbl = minf && child(b, minf, "stbl"); const stsd = stbl && child(b, stbl, "stsd");
    if (!stsd) continue;
    const entry = stsd.body + 8; // fullbox header (4) + entry_count (4)
    if (entry + 36 > stsd.end) continue;
    const codec = String.fromCharCode(...b.slice(entry + 4, entry + 8));
    if (handler === "vide" && !video) video = { codec, width: v.getUint16(entry + 32), height: v.getUint16(entry + 34) };
    if (handler === "soun" && !audio) audio = { codec };
  }
  return { brand, video, audio, durationS };
}

/** Throws a readable error unless the file is H.264 + AAC; requireExact enforces 1080x1920. */
export function assertTikTokReady(info: Mp4Info, requireExact: boolean) {
  if (!info.video) throw new Error("В MP4 нет видеодорожки");
  if (!/^avc[13]$/.test(info.video.codec)) throw new Error(`Видеокодек ${info.video.codec}, нужен H.264`);
  if (!info.audio) throw new Error("В MP4 нет звуковой дорожки");
  if (info.audio.codec !== "mp4a") throw new Error(`Аудиокодек ${info.audio.codec}, нужен AAC`);
  const { width: w, height: h } = info.video;
  if (requireExact && (w !== 1080 || h !== 1920)) throw new Error(`Размер ${w}×${h}, ожидался 1080×1920`);
  if (!requireExact && h <= w) throw new Error(`Видео не вертикальное (${w}×${h})`);
}
