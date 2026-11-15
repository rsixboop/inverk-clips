// Pexels Video Search — https://www.pexels.com/api/documentation/#videos-search
import { ProviderError, providerFetch } from "./http";
export type StockClip = { externalId: string; pageUrl: string; fileUrl: string; preview: string; duration: number; width: number; height: number; author: string; authorUrl: string; title: string };
export const pexelsConfigured = () => !!process.env["PEXELS_API_KEY"];

/** pick the smallest file that is still >=1080 on the short side (or the largest available), mp4 only */
export function parsePexels(j: any): StockClip[] {
  const out: StockClip[] = [];
  for (const v of Array.isArray(j?.videos) ? j.videos : []) {
    const files = (v.video_files ?? []).filter((f: any) => f?.file_type === "video/mp4" && typeof f.link === "string" && f.width && f.height);
    if (!files.length) continue;
    files.sort((a: any, b: any) => Math.min(a.width, a.height) - Math.min(b.width, b.height));
    const f = files.find((x: any) => Math.min(x.width, x.height) >= 1080) ?? files[files.length - 1];
    const slug = String(v.url ?? "").split("/").filter(Boolean).pop() ?? "";
    out.push({ externalId: String(v.id), pageUrl: v.url, fileUrl: f.link, preview: v.image ?? "", duration: Number(v.duration) || 0, width: f.width, height: f.height,
      author: v.user?.name ?? "Pexels", authorUrl: v.user?.url ?? "", title: slug.replace(/-\d+$/, "").replace(/-/g, " ") });
  }
  return out;
}
export async function pexelsSearch(query: string, perPage = 8): Promise<StockClip[]> {
  const key = process.env["PEXELS_API_KEY"];
  if (!key) throw new ProviderError("Не подключено: PEXELS_API_KEY (стоковый футаж)", 0, false);
  const u = `https://api.pexels.com/v1/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&size=medium&per_page=${perPage}`;
  return parsePexels(await providerFetch("Pexels", u, { headers: { Authorization: key } }));
}
