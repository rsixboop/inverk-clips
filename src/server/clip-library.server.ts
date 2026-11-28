import { z } from "zod";
import { categories, clipCard, type ClipCategory } from "@/lib/clip-library";
import { supabaseAdmin as db } from "@/integrations/supabase/client.server";

const filters = z.object({
  cursor:z.string().uuid().optional(), limit:z.number().int().min(1).max(50).default(25),
  category:z.enum(categories).optional(), only_candidates:z.boolean().default(false)
}).strict();

export async function clipLibrary(owner:string, input:unknown) {
  const f = filters.parse(input ?? {});
  let query = db.from("clip_analysis").select("id,job_id,state,description").eq("user_id",owner).order("id").limit(f.limit+1);
  if (f.cursor) query = query.gt("id",f.cursor);
  const {data,error} = await query;
  if (error) throw Error("Не удалось прочитать разборы клипов");
  const rows = (data ?? []).slice(0,f.limit);
  const ids = rows.map(row => row.job_id);
  if (!ids.length) return {groups:[],next_cursor:null};
  const [live,local] = await Promise.all([
    db.from("live_highlights").select("job_id,monitor_id,peak_at,trigger,reason").eq("user_id",owner).in("job_id",ids),
    db.from("local_candidates").select("job_id,channel,reason").eq("user_id",owner).in("job_id",ids)
  ]);
  if (live.error || local.error) throw Error("Не удалось определить источники клипов");
  const monitors = [...new Set(live.data.map(h=>h.monitor_id))];
  const channels = monitors.length ? await db.from("live_monitors").select("id,input").eq("user_id",owner).in("id",monitors) : {data:[],error:null};
  if (channels.error) throw Error("Не удалось прочитать каналы");
  const channelById = new Map(channels.data.map(m=>[m.id,m.input]));
  const cards = rows.map(row=>{
    const h = live.data.find(h=>h.job_id===row.job_id);
    const l = local.data.find(l=>l.job_id===row.job_id);
    const card = clipCard(row.description,row.state);
    // Legacy descriptions have no editorial verdict. Keep evidence and an explicit review state.
    if (card.topic === "Без разметки" && h?.trigger === "speech") {
      card.category = "dialogue";
      card.topic = "Отобрано по речи";
    }
    return {...card, summary:card.summary.slice(0,1200), job_id:row.job_id, state:row.state,
      channel:(h && channelById.get(h.monitor_id)) || l?.channel || "Неизвестный источник",
      peak_at:h?.peak_at ?? null, reason:h?.reason ?? l?.reason ?? null};
  });
  const groups = new Map<string,{channel:string;category:ClipCategory;clips:typeof cards}>();
  for (const card of cards) {
    if ((f.category && f.category!==card.category) || (f.only_candidates && !card.candidate)) continue;
    const key = JSON.stringify([card.channel,card.category]);
    const group = groups.get(key) ?? {channel:card.channel,category:card.category,clips:[]};
    group.clips.push(card);
    groups.set(key,group);
  }
  return {groups:[...groups.values()],next_cursor:(data?.length ?? 0)>f.limit ? rows[rows.length-1]!.id : null};
}
