// Visual game check: one real recent stream frame → vision model → stored, timestamped scene.
import { detectSwitch, normalizeScene, SCENE_INTERVAL_MS, type Scene } from "@/lib/live-scene";
type Admin = (typeof import("@/integrations/supabase/client.server"))["supabaseAdmin"];
export const MAX_FRAME_BYTES = 400_000;

export async function classifyFrame(jpegBase64: string): Promise<Scene> {
  const { generateResponse } = await import("@lovable.dev/ai-gateway");
  const r: any = await generateResponse({ model: "openai/gpt-6-astra",
    instructions: "You classify one frame of a live stream. Judge ONLY from visible pixels (HUD, art style, UI, menus, webcam); never infer from titles. Return strict JSON {\"game\": string|null, \"activity\": \"gameplay\"|\"menu\"|\"chatting\"|\"unknown\", \"confidence\": 0..1, \"note\": short visual evidence}. game=null when not confidently identifiable. chatting = streamer/webcam/talking screen without active play. menu = pause, map, inventory, loading, lobby or settings.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Classify this frame." }, { type: "input_image", image_url: `data:image/jpeg;base64,${jpegBase64}`, detail: "low" }] }] } as any);
  let out: string | undefined = r?.output_text;
  if (!out) for (const o of r?.output ?? []) for (const x of o?.content ?? []) if (x?.type === "output_text") out = x.text;
  const m = out?.match(/\{[\s\S]*\}/); if (!m) throw new Error("vision: no JSON");
  return normalizeScene(JSON.parse(m[0]));
}

/** Store a scene for a monitor; rate-limited per monitor so sampling never floods vision calls. */
export async function recordScene(db: Admin, userId: string, monitorId: string, frameAt: Date, jpegBase64: string | null, unavailableReason?: string) {
  const { data: mon } = await db.from("live_monitors").select("id,stats").eq("id", monitorId).eq("user_id", userId).maybeSingle();
  if (!mon) return { error: "monitor not found" };
  const stats: any = mon.stats ?? {};
  if (jpegBase64 && stats.scene_at && Date.now() - Date.parse(stats.scene_at) < SCENE_INTERVAL_MS - 5000) return { skipped: "rate" };
  let s: Scene;
  if (!jpegBase64) s = { game: null, activity: "unavailable", confidence: 0, note: unavailableReason ?? "кадр недоступен" };
  else { try { s = await classifyFrame(jpegBase64); } catch (e) { s = { game: null, activity: "unavailable", confidence: 0, note: `vision: ${(e as Error).message.slice(0, 120)}` }; } }
  const switched = detectSwitch(stats.last_game, s);
  await db.from("live_scene_checks").upsert({ monitor_id: monitorId, user_id: userId, frame_at: frameAt.toISOString(), game: s.game, activity: s.activity, confidence: s.confidence, note: s.note ?? null, switched_from: switched }, { onConflict: "monitor_id,frame_at" });
  await db.from("live_monitors").update({ stats: { ...stats, scene_at: new Date().toISOString(), scene: { ...s, frame_at: frameAt.toISOString() }, ...(s.game ? { last_game: s.game } : {}) } }).eq("id", monitorId);
  return { scene: s, switched_from: switched };
}

/** Successive buffered frames (oldest→newest) → is this a meaningful story beat / novel interaction, or routine? */
export async function classifyEvent(frames: string[]) {
  const { normalizeEvent } = await import("@/lib/live-events");
  const { generateResponse } = await import("@lovable.dev/ai-gateway");
  const r: any = await generateResponse({ model: "openai/gpt-6-astra",
    instructions: "You see successive frames (oldest first, ~5 s apart) from a live game stream. Decide from visible pixels only whether they show a meaningful gameplay EVENT worth a short clip: story_beat (cutscene, mission start/finish, dramatic plot moment, death/defeat/win) or novel_interaction (entering a new place and interacting with an NPC/object, a fight, a deal, a stunt, a surprising encounter). routine = ordinary driving/walking/travel, menus, map, inventory, loading, idle, streamer just chatting, repetitive farming. none = nothing identifiable. Be conservative. Return strict JSON {\"kind\": \"story_beat\"|\"novel_interaction\"|\"routine\"|\"none\", \"label\": short concrete description (who/where/what), \"confidence\": 0..1, \"setup\": what leads in, \"payoff\": what happens}.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Frames in time order:" }, ...frames.map((f) => ({ type: "input_image", image_url: `data:image/jpeg;base64,${f}`, detail: "low" }))] }] } as any);
  let out: string | undefined = r?.output_text;
  if (!out) for (const o of r?.output ?? []) for (const x of o?.content ?? []) if (x?.type === "output_text") out = x.text;
  const m = out?.match(/\{[\s\S]*\}/); if (!m) throw new Error("vision: no JSON");
  return normalizeEvent(JSON.parse(m[0]));
}

/** Speech judge: stitched dialogue lines from the rolling buffer → is there a clip-worthy spoken moment? */
export async function judgeDialogue(lines: { t: number; text: string }[]) {
  const { normalizeSpeechJudge } = await import("@/lib/speech-judge");
  const { generateResponse } = await import("@lovable.dev/ai-gateway");
  const transcript = lines.map((l) => `[${l.t.toFixed(1)}] ${l.text}`).join("\n").slice(0, 6000);
  const r: any = await generateResponse({ model: "openai/gpt-6-astra",
    instructions: "You read a timestamped transcript (seconds) of a live game stream, Russian or English, streamer and possibly game dialogue mixed. Decide whether it contains a moment worth a short vertical clip: a funny exchange, a strong reaction to something surprising, a conflict, a punchline, a dramatic story beat. Reject routine commentary, reading chat, greetings, ads/donation reading, silence, filler. Be conservative. Pick the tightest span from setup (what triggers it) to reaction/payoff, 8-60 s. Return strict JSON {\"keep\": boolean, \"score\": 0..1, \"start\": seconds, \"end\": seconds, \"reason\": short concrete reason in Russian, \"setup\": short, \"payoff\": short}.",
    input: [{ role: "user", content: [{ type: "input_text", text: transcript }] }] } as any);
  let out: string | undefined = r?.output_text;
  if (!out) for (const o of r?.output ?? []) for (const x of o?.content ?? []) if (x?.type === "output_text") out = x.text;
  const m = out?.match(/\{[\s\S]*\}/); if (!m) throw new Error("judge: no JSON");
  return normalizeSpeechJudge(JSON.parse(m[0]), lines);
}
