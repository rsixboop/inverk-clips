import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { parseLiveInput } from "@/lib/live-detect";
import { parsePublicUrl } from "@/lib/url-guard";

async function admin() { return (await import("@/integrations/supabase/client.server")).supabaseAdmin; }

export const liveStatus = createServerFn({ method: "GET" }).middleware([requireSupabaseAuth]).handler(async () => {
  const { youtubeConfigured, twitchHelixConfigured } = await import("@/server/live.server");
  return { youtube: youtubeConfigured(), twitchHelix: twitchHelixConfigured() };
});

const addSchema = z.object({ input: z.string().min(2).max(300), media_mode: z.enum(["timestamp_only", "recorder", "recording_url"]), recording_url: z.string().max(1000).optional(), rights: z.boolean() });
export const addMonitor = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).inputValidator((d: unknown) => addSchema.parse(d))
  .handler(async ({ data, context }) => {
    const p = parseLiveInput(data.input); if (!p) throw new Error("Нужен YouTube канал/@handle/ссылка на эфир или twitch.tv/<канал>");
    if (data.media_mode !== "timestamp_only" && !data.rights) throw new Error("Запись медиа только для своих каналов или с разрешением правообладателя — подтвердите права");
    let recording_url: string | null = null;
    if (data.media_mode === "recording_url") { if (!data.recording_url) throw new Error("Укажите ссылку на свою запись/поток"); recording_url = parsePublicUrl(data.recording_url).toString(); }
    const db = await admin();
    const { data: row, error } = await db.from("live_monitors").insert({ user_id: context.userId, platform: p.platform, input: data.input.trim(), media_mode: data.media_mode, recording_url, rights_confirmed: data.rights,
      status: "resolving", channel_id: p.platform === "twitch" ? p.login : null }).select("id").single();
    if (error) throw new Error(error.message);
    return row;
  });

export const monitorAction = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).inputValidator((d: unknown) => z.object({ id: z.string().uuid(), action: z.enum(["start", "stop"]) }).parse(d))
  .handler(async ({ data, context }) => {
    const db = await admin();
    const patch = data.action === "stop" ? { status: "stopped", stopped_at: new Date().toISOString(), lease: null, lease_until: null, status_detail: "Остановлено пользователем" }
      : { status: "resolving", status_detail: "Запуск…", live_chat_id: null, page_token: null, next_poll_at: new Date().toISOString(), stopped_at: null, lease: null, lease_until: null };
    const { error } = await db.from("live_monitors").update(patch).eq("id", data.id).eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Foreground tick (open tab): advances the caller's due monitors; the cron drains everyone on the published app. */
export const tickLive = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { drainLive } = await import("@/server/live.server");
  return { processed: await drainLive(15_000, context.userId) };
});

export const createWorkerToken = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const bytes = crypto.getRandomValues(new Uint8Array(32)); const token = "lrw_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const { hashToken } = await import("@/server/live-worker.server");
  const { error } = await (await admin()).from("live_workers").insert({ user_id: context.userId, token_hash: await hashToken(token) });
  if (error) throw new Error(error.message);
  return { token }; // shown once; only the hash is stored
});

export const highlightUrl = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: h } = await context.supabase.from("live_highlights").select("output_path").eq("id", data.id).maybeSingle();
    if (!h?.output_path) throw new Error("Клип ещё не готов");
    const { data: s, error } = await (await admin()).storage.from("outputs").createSignedUrl(h.output_path, 3600, { download: true });
    if (error) throw new Error(error.message);
    return { url: s.signedUrl };
  });
