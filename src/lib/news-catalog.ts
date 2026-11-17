// Fixed catalog of official Rockstar GTA VI screenshots (https://www.rockstargames.com/VI/media/screenshots).
// The server proxy serves ONLY these IDs, never arbitrary URLs.
const BASE = "https://www.rockstargames.com/VI/_next/static/media/";
export type CatalogAsset = { id: string; title: string; file: string; tags: string[] };
export const CATALOG: CatalogAsset[] = [
  { id: "vc14", title: "Vice City 14", file: "Vice_City_14.0fu8u9jh5hkg7.jpg", tags: ["key", "art", "city", "skyline", "fps"] },
  { id: "vc01", title: "Vice City 01", file: "Vice_City_01.135x56yoeu.6t.jpg", tags: ["wide", "city", "coast", "leonida", "confirmed", "consoles"] },
  { id: "jl02", title: "Jason and Lucia 02", file: "Jason_and_Lucia_02.0uig00eojlokf.jpg", tags: ["jason", "lucia", "characters", "trade", "would", "visuals"] },
  { id: "vc04", title: "Vice City 04", file: "Vice_City_04.06evqutgh7624.jpg", tags: ["sunlight", "shadows", "ray", "sharper", "pro"] },
  { id: "vc02", title: "Vice City 02", file: "Vice_City_02.0c5.7qx17u9kl.jpg", tags: ["city", "street", "traffic", "night"] },
  { id: "vc07", title: "Vice City 07", file: "Vice_City_07.0b3mhak4k78oh.jpg", tags: ["beach", "ocean", "coast"] },
  { id: "vc11", title: "Vice City 11", file: "Vice_City_11.09paum3g942sc.jpg", tags: ["city", "neon", "nightlife"] },
  { id: "vc16", title: "Vice City 16", file: "Vice_City_16.16hjjmnxqg9mv.jpg", tags: ["downtown", "skyline", "wide"] },
  { id: "vc20", title: "Vice City 20", file: "Vice_City_20.18c75478u52nf.jpg", tags: ["sunset", "sky", "lighting"] },
  { id: "jl06", title: "Jason and Lucia 06", file: "Jason_and_Lucia_06.1035xf1yo78.b.jpg", tags: ["jason", "lucia", "car", "drive"] },
  { id: "jl13", title: "Jason and Lucia 13", file: "Jason_and_Lucia_13.0q.hw42xbhptg.jpg", tags: ["jason", "lucia", "crime", "heist"] },
  { id: "jd01", title: "Jason Duval 01", file: "Jason_Duval_01.07m377xeb6jhq.jpg", tags: ["jason", "character"] },
  { id: "lc01", title: "Lucia Caminos 01", file: "Lucia_Caminos_01.0a7yqvewctkfp.jpg", tags: ["lucia", "character"] },
  { id: "lk01", title: "Leonida Keys 01", file: "Leonida_Keys_01.0zgz7tveur6y8.jpg", tags: ["leonida", "keys", "islands", "water", "boat"] },
  { id: "mk02", title: "Mount Kalaga National Park 02", file: "Mount_Kalaga_National_Park_02.0f24dhopdprvx.jpg", tags: ["nature", "forest", "park", "wildlife"] },
  { id: "gr02", title: "Grassrivers 02", file: "Grassrivers_02.0teqs5xe2pem1.jpg", tags: ["swamp", "grassrivers", "alligator"] },
  { id: "pg06", title: "Port Gellhorn 06", file: "Port_Gellhorn_06.13ghhmb440r6e.jpg", tags: ["port", "industrial", "town"] },
  { id: "am01", title: "Ambrosia 01", file: "Ambrosia_01.0rqphs0gazkm..jpg", tags: ["ambrosia", "rural", "town"] },
];
export const assetUrl = (a: CatalogAsset) => `${BASE}${a.file}?akim=1&imdensity=1&imwidth=3840`;
export const findAsset = (id: string) => CATALOG.find((a) => a.id === id);
const hasWord = (text: string, tag: string) => new RegExp(`\\b${tag.replace(/[^a-z0-9 ]/g, "")}\\b`).test(text);
/** Pick a distinct asset per shot by whole-word tag matches; the visual brief weighs 3x. Evidence shots and zero matches stay empty. */
export function pickAssets(shots: { text: string; material: string; brief?: string; role?: string }[]): string[] {
  const used = new Set<string>();
  return shots.map((s) => {
    if (s.role === "evidence") return "";
    const brief = (s.brief ?? "").toLowerCase(), rest = (s.text + " " + s.material).toLowerCase();
    // The catalog contains game art, NOT console menus or proof of technical
    // claims. Do not silently substitute a random character/city shot for a
    // requested storage screen, download UI, lock, countdown or game library.
    // These need a purpose-built explanation layer or an explicitly supplied asset.
    if (/\\b(storage (?:screen|menu|interface)|disk (?:space|meter)|download (?:bar|progress|screen)|console (?:menu|interface)|game library|latency graph|connection meter|release calendar|countdown|lock icon)\\b/.test(brief)) return "";
    const best = CATALOG.filter((a) => !used.has(a.id))
      .map((a) => ({ a, score: a.tags.reduce((n, t) => n + (hasWord(brief, t) ? 3 : 0) + (hasWord(rest, t) ? 1 : 0), 0) }))
      .sort((x, y) => y.score - x.score)[0];
    if (!best || best.score === 0) return ""; // no match: leave empty, never a random topical photo
    used.add(best.a.id); return best.a.id;
  });
}

// Official GTA VI character clips (https://www.rockstargames.com/VI/media/videos). HEAD-verified 200 video/mp4, 5.9–16 MB.
// Rockstar sends no CORS header for these, so they are served only through the fixed-ID proxy (never arbitrary URLs).
export type CatalogClip = { id: string; title: string; file: string };
export const CLIPS: CatalogClip[] = [
  { id: "c-jason", title: "Jason Duval", file: "Jason_Duval_Video_Clip.10.gc09c9y-j9.mp4" },
  { id: "c-lucia", title: "Lucia Caminos", file: "Lucia_Caminos_Video_Clip.0g8.3fx84ixw..mp4" },
  { id: "c-cal", title: "Cal Hampton", file: "Cal_Hampton_Video_Clip.13-520tpb1vbq.mp4" },
  { id: "c-boobie", title: "Boobie Ike", file: "Boobie_Ike_Video_Clip.0yf7eprhr68rj.mp4" },
  { id: "c-dre", title: "DreQuan Priest", file: "DreQuan_Priest_Video_Clip.0g~ify.ccqpkj.mp4" },
  { id: "c-dimez", title: "Real Dimez", file: "Real_Dimez_Video_Clip.0.cgr_26mspvm.mp4" },
  { id: "c-raul", title: "Raul Bautista", file: "Raul_Bautista_Video_Clip.0vg4g-gyqaksg.mp4" },
  { id: "c-brian", title: "Brian Heder", file: "Brian_Heder_Video_Clip.0yy.ets6sso8~.mp4" },
];
export const clipUrl = (c: CatalogClip) => `${BASE}${c.file}`;
export const findClip = (id: string) => CLIPS.find((c) => c.id === id);

// Verified local copies (public/gta6-media, provenance in its README): images byte-identical originals,
// clips re-encoded to 1080p, no audio, original fps/frame count. IDs not listed fall back to the remote proxy and show its real error.
export const LOCAL_MEDIA: Record<string, string> = Object.fromEntries([
  ...CATALOG.map((a) => [a.id, `/gta6-media/${a.id}.jpg`]),
  ...CLIPS.map((c) => [c.id, `/gta6-media/${c.id}.mp4`]),
]);
export const mediaUrl = (id: string) => LOCAL_MEDIA[id] ?? `/api/rockstar-media/${id}`;
export const isCatalogUrl = (u: string) => u.startsWith("/gta6-media/") || u.startsWith("/api/rockstar-media/");
