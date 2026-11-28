import { z } from "zod";
import { tiktokPostSchema, tiktokIdemKey } from "@/lib/vps-ops";

export const bufferAgentSchema = z.object({ agent_id: z.string().uuid() }).strict();
export const bufferStatusSchema = z.object({ agent_id: z.string().uuid(), command_id: z.string().uuid().optional(), post_id: z.string().regex(/^[a-f0-9]{24}$/).optional() }).strict();

/** Shared by authenticated controls and owner-token Phil API; never sends the VPS key to this server. */
export async function bufferOperation(owner: string, operation: string, input: unknown) {
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  const a = operation === "tiktokPost" ? tiktokPostSchema.parse(input) : operation === "tiktokStatus" ? bufferStatusSchema.parse(input) : bufferAgentSchema.parse(input);
  const { data: agent } = await db.from("vps_agents").select("id,agent_version,last_seen_at").eq("id", a.agent_id).eq("user_id", owner).is("revoked_at", null).maybeSingle();
  if (!agent) throw Error("VPS не подключён");
  if (operation === "tiktokStatus") {
    const status = bufferStatusSchema.parse(input);
    if (status.post_id) {
      if (agent.agent_version !== "1.2") throw Error("Нужен VPS агент 1.2");
      const idem_key = `buffer.status:${agent.id}:${status.post_id}:${Math.floor(Date.now() / 60_000)}`;
      const { error } = await db.from("vps_commands").upsert({ user_id: owner, agent_id: agent.id, op: "buffer.check_post", args: { post_id: status.post_id }, idem_key }, { onConflict: "user_id,idem_key", ignoreDuplicates: true });
      if (error) throw Error("Проверка Buffer недоступна");
      const { data: command } = await db.from("vps_commands").select("id,status,result,error").eq("user_id", owner).eq("idem_key", idem_key).single();
      return { command_id: command?.id, status: command?.status, result: command?.result, error: command?.error };
    }
  }
  if (operation === "tiktokRead" || operation === "tiktokStatus") {
    const { data: mirror, error } = await db.from("vps_mirror").select("kind,row_key,data,updated_at").eq("agent_id", agent.id).eq("user_id", owner).in("kind", ["buffer:channels", "buffer:posts", "buffer:error"]).limit(1000);
    if (error) throw Error("Данные Buffer недоступны");
    const status = bufferStatusSchema.parse(input);
    const commands = db.from("vps_commands").select("id,op,status,result,error,created_at,done_at").eq("agent_id", agent.id).eq("user_id", owner);
    const { data: actions } = await (status.command_id ? commands.eq("id", status.command_id) : commands.in("op", ["buffer.refresh", "buffer.check_post", "buffer.ready_post", "buffer.create_draft"])).order("created_at", { ascending: false }).limit(20);
    return { agent, mirror: mirror ?? [], commands: actions ?? [], note: "Cached Buffer data; inspect updated_at. A done submission is not proof of publication; sent is the Buffer published status." };
  }
  const post = operation === "tiktokPost" ? tiktokPostSchema.parse(input) : null;
  if (post && (agent.agent_version !== "1.2" || !agent.last_seen_at || Date.now() - Date.parse(agent.last_seen_at) > 75_000)) throw Error("Нужен онлайн VPS агент 1.2");
  const idem_key = post ? tiktokIdemKey(post) : `buffer.refresh:${agent.id}:${Math.floor(Date.now() / 60_000)}`;
  const { data: existing } = await db.from("vps_commands").select("id,status,args").eq("user_id", owner).eq("idem_key", idem_key).maybeSingle();
  if (existing) {
    const args = existing.args as Record<string, unknown>;
    if (post && (args["text"] !== post.text || args["authorized_channel_id"] !== post.channel_id)) throw Error("Этот клип уже отправлен с другими параметрами. Проверьте Buffer.");
    return { command_id: existing.id, status: existing.status, existing: true };
  }
  let args: Record<string, unknown> = {};
  if (post) {
    const { data: channel } = await db.from("vps_mirror").select("data,updated_at").eq("agent_id", agent.id).eq("user_id", owner).eq("kind", "buffer:channels").eq("row_key", post.channel_id).maybeSingle();
    const ch = channel?.data as Record<string, unknown> | undefined;
    if (ch?.["service"] !== "tiktok" || Date.now() - Date.parse(channel?.updated_at ?? "") > 900_000) throw Error("Обновите подключённые TikTok аккаунты");
    const { data: job } = await db.from("jobs").select("id,status,output_path,output_mime").eq("id", post.job_id).eq("user_id", owner).maybeSingle();
    if (!job?.output_path || !(["succeeded", "completed"] as string[]).includes(job.status) || job.output_mime !== "video/mp4") throw Error("Нужен готовый MP4 из вашей Библиотеки");
    const { data: signed, error } = await db.storage.from("outputs").createSignedUrl(job.output_path, 30 * 86400);
    if (error || !signed) throw Error("Не удалось открыть MP4 для Buffer");
    const { agent_id: _agent, ...rest } = post;
    args = { ...rest, video_url: signed.signedUrl };
  }
  const { error } = await db.from("vps_commands").upsert({ user_id: owner, agent_id: agent.id, op: post ? "buffer.ready_post" : "buffer.refresh", args: args as never, idem_key }, { onConflict: "user_id,idem_key", ignoreDuplicates: true });
  if (error) throw Error("Не удалось поставить команду Buffer в очередь");
  const { data: command } = await db.from("vps_commands").select("id,status").eq("user_id", owner).eq("idem_key", idem_key).single();
  return { command_id: command?.id, status: command?.status };
}