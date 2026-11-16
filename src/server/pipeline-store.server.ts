// Supabase-backed Store for the pipeline. Uses the service client, so EVERY query is scoped by the
// job owner's user_id explicitly; job writes are fenced by lease_token + live status.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { Job, Src, Store } from "./pipeline.server";

const SIGNED_URL_SECONDS = 3 * 3600; // bounded: covers max provider processing window

export function supabaseStore(db: SupabaseClient<Database>): Store {
  return {
    async lease(jobId, token, untilMs) {
      const now = new Date().toISOString();
      const { data } = await db.from("jobs").update({ lock_until: new Date(untilMs).toISOString(), lease_token: token })
        .eq("id", jobId).in("status", ["queued", "running"]).lte("next_attempt_at", now)
        .or(`lock_until.is.null,lock_until.lt.${now}`).select("*").maybeSingle();
      return (data as Job) ?? null;
    },
    async update(job, token, p) {
      const { data, error } = await db.from("jobs").update({ ...p, updated_at: new Date().toISOString() } as any)
        .eq("id", job.id).eq("user_id", job.user_id).eq("lease_token", token).gt("lock_until", new Date().toISOString()).in("status", ["queued", "running"]).select("id");
      if (error) throw new Error(error.message);
      return (data ?? []).length === 1;
    },
    async release(jobId, token) {
      await db.from("jobs").update({ lock_until: null, lease_token: null }).eq("id", jobId).eq("lease_token", token);
    },
    async recordOrphan(jobId, field, id) {
      await db.from("jobs").update({ [field]: id, submit_state: "orphaned" } as any).eq("id", jobId).is(field, null);
    },
    async log(job, stage, message, level = "info", duration_ms) {
      await db.from("job_events").insert({ job_id: job.id, user_id: job.user_id, stage, message, level, duration_ms: duration_ms ?? null });
    },
    async getSource(userId, id) {
      const { data } = await db.from("sources").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
      return (data as Src) ?? null;
    },
    async library(userId) {
      const { data } = await db.from("sources").select("*").eq("user_id", userId).in("kind", ["upload", "direct_url", "stock"]).eq("status", "ready").neq("permission", "unknown").order("created_at", { ascending: false }).limit(30);
      return (data ?? []) as Src[];
    },
    async setSourceDuration(userId, id, d) { await db.from("sources").update({ duration_s: d }).eq("id", id).eq("user_id", userId); },
    async signFootage(userId, path) {
      if (!path.startsWith(`${userId}/`)) throw new Error("Файл источника не принадлежит владельцу задачи");
      const { data, error } = await db.storage.from("footage").createSignedUrl(path, SIGNED_URL_SECONDS);
      if (error || !data) throw new Error("Не удалось подписать ссылку на загруженный файл");
      return data.signedUrl;
    },
    async uploadOutput(path, bytes) {
      const { error } = await db.storage.from("outputs").upload(path, bytes, { contentType: "video/mp4", upsert: true });
      if (error) throw new Error(`Сохранение MP4: ${error.message}`);
    },
    async removeOutput(path) { await db.storage.from("outputs").remove([path]); },
    async uploadAsset(path, bytes, mime) {
      const { error } = await db.storage.from("outputs").upload(path, bytes, { contentType: mime, upsert: true });
      if (error) throw new Error(`Сохранение файла: ${error.message}`);
    },
    async downloadAsset(path) {
      const { data, error } = await db.storage.from("outputs").download(path);
      if (error || !data) throw new Error(`Не удалось прочитать файл сборки: ${error?.message ?? "нет данных"}`);
      return new Uint8Array(await data.arrayBuffer());
    },
    async signAsset(path) {
      const { data, error } = await db.storage.from("outputs").createSignedUrl(path, SIGNED_URL_SECONDS);
      if (error || !data) throw new Error("Не удалось подписать ссылку на файл");
      return data.signedUrl;
    },
  };
}
