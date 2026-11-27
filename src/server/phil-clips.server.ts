import { supabaseAdmin as db } from "@/integrations/supabase/client.server";
import { hashToken } from "./live-worker.server";

export async function latestClip(request: Request) {
  const token = /^Bearer (phc_[a-f0-9]{64})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  const error = (status: number) => Response.json({ status }, { status });
  if (!token) return error(401);
  const { data: owner, error: lookup } = await db.from("live_workers").select("user_id").eq("label", "phil-read").eq("token_hash", await hashToken(token)).maybeSingle();
  if (lookup) return error(503);
  if (!owner) return error(401);
  const input = await request.json().catch(() => null);
  if (!input || typeof input.channel !== "string") return error(400);
  const channel = input.channel.trim();
  if (channel && !/^[a-z0-9_-]{1,100}$/i.test(channel)) return error(400);
  const uid = owner.user_id;
  let local = db.from("local_candidates").select("id,output_path,created_at").eq("user_id", uid).eq("status", "done").not("output_path", "is", null);
  let live = db.from("live_highlights").select("id,output_path,created_at,live_monitors!inner(user_id,channel_id,channel_title)").eq("user_id", uid).eq("live_monitors.user_id", uid).eq("status", "done").not("output_path", "is", null);
  if (channel) {
    const exact = channel.replaceAll("_", "\\_");
    local = local.ilike("channel", exact);
    live = live.or(`channel_id.ilike.${exact},channel_title.ilike.${exact}`, { referencedTable: "live_monitors" });
  }
  const [a, b] = await Promise.all([local.order("created_at", { ascending: false }).limit(1), live.order("created_at", { ascending: false }).limit(1)]);
  if (a.error || b.error) return error(502);
  const clip = [...(a.data ?? []), ...(b.data ?? [])].sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at))[0];
  if (!clip) return error(404);
  if (!clip.output_path || ![`${uid}/live/${clip.id}.mp4`, `${uid}/local/${clip.id}.mp4`].includes(clip.output_path)) return error(409);
  const signed = await db.storage.from("outputs").createSignedUrl(clip.output_path, 3600);
  if (signed.error) return error(502);
  return Response.json({ url: signed.data.signedUrl }, { headers: { "Cache-Control": "no-store" } });
}
