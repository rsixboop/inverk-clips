// Rolling buffer of a fragmented MP4 stream (Chrome MediaRecorder "video/mp4" output) that can cut a
// standalone, decodable MP4 for any wall-clock window still in the buffer: init (ftyp+moov) + the
// moof/mdat pairs from the last video keyframe at/before the window start, with tfdt rebased to 0.
// Pure (no DOM), so the cut logic is unit-tested against real fragmented MP4s.
import { boxes, child, type Box } from "./mp4-inspect";

export type Fragment = { bytes: Uint8Array; start: number; end: number; key: boolean };
type Track = { timescale: number; video: boolean; defaultFlags: number };

const u32 = (b: Uint8Array, p: number) => ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0;
const flags24 = (b: Uint8Array, box: Box) => (b[box.body + 1]! << 16) | (b[box.body + 2]! << 8) | b[box.body + 3]!;
const concat = (parts: Uint8Array[]) => { const n = parts.reduce((s, p) => s + p.byteLength, 0); const o = new Uint8Array(n); let p = 0; for (const x of parts) { o.set(x, p); p += x.byteLength; } return o; };

export class Fmp4Buffer {
  init: Uint8Array | null = null;
  frags: Fragment[] = [];
  tracks = new Map<number, Track>();
  private pending = new Uint8Array(0);
  private moof: Uint8Array | null = null;
  private initParts: Uint8Array[] = [];

  /** Media seconds of the first fragment (Chrome starts near 0; kept for alignment). */
  get bufferedFrom() { return this.frags[0]?.start ?? 0; }
  get bufferedTo() { return this.frags.at(-1)?.end ?? 0; }

  push(chunk: Uint8Array) {
    const all = this.pending.byteLength ? concat([this.pending, chunk]) : chunk;
    let p = 0;
    while (p + 8 <= all.byteLength) {
      let size = u32(all, p); const type = String.fromCharCode(all[p + 4]!, all[p + 5]!, all[p + 6]!, all[p + 7]!);
      if (size === 1) { if (p + 16 > all.byteLength) break; size = Number(new DataView(all.buffer, all.byteOffset + p + 8, 8).getBigUint64(0)); }
      if (size < 8) throw new Error(`Повреждённый MP4-поток (box ${type})`);
      if (p + size > all.byteLength) break;
      const box = all.slice(p, p + size); p += size;
      if (type === "ftyp") this.initParts = [box];
      else if (type === "moov") { this.initParts.push(box); this.init = concat(this.initParts); this.parseMoov(box); }
      else if (type === "moof") this.moof = box;
      else if (type === "mdat" && this.moof) { this.addFragment(this.moof, box); this.moof = null; }
    }
    this.pending = all.slice(p);
  }

  private parseMoov(m: Uint8Array) {
    const root = boxes(m, 0, m.byteLength)[0]!;
    for (const trak of boxes(m, root.body, root.end).filter((x) => x.type === "trak")) {
      const tkhd = child(m, trak, "tkhd"), mdia = child(m, trak, "mdia"); if (!tkhd || !mdia) continue;
      const id = u32(m, tkhd.body + (m[tkhd.body] === 1 ? 20 : 12));
      const mdhd = child(m, mdia, "mdhd"), hdlr = child(m, mdia, "hdlr"); if (!mdhd || !hdlr) continue;
      const timescale = u32(m, mdhd.body + (m[mdhd.body] === 1 ? 20 : 12));
      this.tracks.set(id, { timescale, video: String.fromCharCode(...m.slice(hdlr.body + 8, hdlr.body + 12)) === "vide", defaultFlags: 0 });
    }
    const mvex = boxes(m, root.body, root.end).find((x) => x.type === "mvex");
    if (mvex) for (const trex of boxes(m, mvex.body, mvex.end).filter((x) => x.type === "trex")) {
      const t = this.tracks.get(u32(m, trex.body + 4)); if (t) t.defaultFlags = u32(m, trex.body + 20);
    }
  }

  private addFragment(moof: Uint8Array, mdat: Uint8Array) {
    const root = boxes(moof, 0, moof.byteLength)[0]!;
    let start = Infinity, end = 0, key = false, hasVideo = false;
    for (const traf of boxes(moof, root.body, root.end).filter((x) => x.type === "traf")) {
      const tfhd = child(moof, traf, "tfhd"), tfdt = child(moof, traf, "tfdt"), trun = child(moof, traf, "trun"); if (!tfhd || !tfdt) continue;
      const tr = this.tracks.get(u32(moof, tfhd.body + 4)); if (!tr) continue;
      const base = moof[tfdt.body] === 1 ? Number(new DataView(moof.buffer, moof.byteOffset + tfdt.body + 4, 8).getBigUint64(0)) : u32(moof, tfdt.body + 4);
      const tf = flags24(moof, tfhd); let q = tfhd.body + 8;
      if (tf & 0x1) q += 8; if (tf & 0x2) q += 4;
      const defDur = tf & 0x8 ? u32(moof, q) : 0; if (tf & 0x8) q += 4; if (tf & 0x10) q += 4;
      const defFlags = tf & 0x20 ? u32(moof, q) : tr.defaultFlags;
      let dur = 0, first = defFlags;
      if (trun) {
        const rf = flags24(moof, trun), n = u32(moof, trun.body + 4); let r = trun.body + 8;
        if (rf & 0x1) r += 4; if (rf & 0x4) { first = u32(moof, r); r += 4; }
        for (let i = 0; i < n; i++) {
          const d = rf & 0x100 ? u32(moof, r) : defDur; if (rf & 0x100) r += 4; if (rf & 0x200) r += 4;
          if (rf & 0x400) { if (i === 0 && !(rf & 0x4)) first = u32(moof, r); r += 4; } if (rf & 0x800) r += 4;
          dur += d;
        }
      }
      start = Math.min(start, base / tr.timescale); end = Math.max(end, (base + dur) / tr.timescale);
      if (tr.video) { hasVideo = true; key = !(first & 0x10000); }
    }
    if (!Number.isFinite(start)) return;
    this.frags.push({ bytes: concat([moof, mdat]), start, end: Math.max(end, start), key: hasVideo && key });
  }

  /** Drop fragments older than keepS, always keeping a keyframe at the head. */
  prune(keepS: number) {
    const cutoff = this.bufferedTo - keepS; let idx = -1;
    for (let i = 0; i < this.frags.length; i++) { if (this.frags[i]!.start > cutoff) break; if (this.frags[i]!.key) idx = i; }
    if (idx > 0) this.frags.splice(0, idx);
  }

  bytes() { return this.frags.reduce((s, f) => s + f.bytes.byteLength, 0); }

  /** Cut [from,to) in media seconds. Returns null when the window is not (yet) covered. */
  cut(from: number, to: number): { bytes: Uint8Array; start: number; end: number; preRollShort: boolean } | null {
    if (!this.init || !this.frags.length || this.bufferedTo < to) return null;
    let i0 = -1;
    for (let i = 0; i < this.frags.length; i++) { if (this.frags[i]!.start > from) break; if (this.frags[i]!.key) i0 = i; }
    let preRollShort = false;
    if (i0 < 0) { i0 = this.frags.findIndex((f) => f.key); preRollShort = true; }
    if (i0 < 0 || this.frags[i0]!.start >= to) return null;
    const sel = this.frags.slice(i0).filter((f) => f.start < to);
    const t0 = sel[0]!.start;
    const parts = sel.map((f) => this.rebase(f.bytes, t0));
    return { bytes: concat([this.init, ...parts]), start: t0, end: sel.at(-1)!.end, preRollShort };
  }

  private rebase(src: Uint8Array, t0: number) {
    const b = src.slice(); const moof = boxes(b, 0, b.byteLength)[0]!; const v = new DataView(b.buffer);
    for (const traf of boxes(b, moof.body, moof.end).filter((x) => x.type === "traf")) {
      const tfhd = child(b, traf, "tfhd"), tfdt = child(b, traf, "tfdt"); if (!tfhd || !tfdt) continue;
      const tr = this.tracks.get(v.getUint32(tfhd.body + 4)); if (!tr) continue;
      const shift = Math.round(t0 * tr.timescale);
      if (b[tfdt.body] === 1) v.setBigUint64(tfdt.body + 4, BigInt(Math.max(0, Number(v.getBigUint64(tfdt.body + 4)) - shift)));
      else v.setUint32(tfdt.body + 4, Math.max(0, v.getUint32(tfdt.body + 4) - shift));
    }
    return b;
  }
}

/** Clip window around a chat spike: 20 s before its start, 15 s after its end, shifted by the viewer delay. */
export function clipWindow(startAtMs: number, endAtMs: number, delayS = 0) {
  return { from: startAtMs - 20_000 + delayS * 1000, to: endAtMs + 15_000 + delayS * 1000 };
}
