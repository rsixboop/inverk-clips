// Fixed catalog of official Rockstar GTA VI screenshots (https://www.rockstargames.com/VI/media/screenshots).
// The server proxy serves ONLY these IDs, never arbitrary URLs.
const BASE = "https://www.rockstargames.com/VI/_next/static/media/";
export type CatalogAsset = { id: string; title: string; file: string; tags: string[] };
export const CATALOG: CatalogAsset[] = [
  { id: "vc14", title: "Vice City 14", file: "Vice_City_14.0fu8u9jh5hkg7.jpg", tags: ["key", "art", "logo", "fps", "city"] },
  { id: "vc01", title: "Vice City 01", file: "Vice_City_01.135x56yoeu.6t.jpg", tags: ["wide", "city", "coast", "leonida", "confirmed"] },
  { id: "jl02", title: "Jason and Lucia 02", file: "Jason_and_Lucia_02.0uig00eojlokf.jpg", tags: ["trade", "visuals", "would", "characters"] },
  { id: "vc04", title: "Vice City 04", file: "Vice_City_04.06evqutgh7624.jpg", tags: ["sunlight", "shadows", "ray", "sharper", "pro"] },
];
export const assetUrl = (a: CatalogAsset) => `${BASE}${a.file}?akim=1&imdensity=1&imwidth=3840`;
export const findAsset = (id: string) => CATALOG.find((a) => a.id === id);
/** Pick a distinct asset per shot by keyword overlap with text+material. */
export function pickAssets(shots: { text: string; material: string }[]): string[] {
  const used = new Set<string>();
  return shots.map((s) => {
    const words = (s.text + " " + s.material).toLowerCase();
    const best = CATALOG.filter((a) => !used.has(a.id))
      .map((a) => ({ a, score: a.tags.filter((t) => words.includes(t)).length }))
      .sort((x, y) => y.score - x.score)[0];
    if (!best) return "";
    used.add(best.a.id); return best.a.id;
  });
}
