// Live highlight ingestion: YouTube Data API chat polling (needs YOUTUBE_API_KEY) and anonymous Twitch
// IRC chat sampling (no credentials; live status via the Twitch connector when linked). Each monitor is
// advanced under a fenced lease; spike windows are upserted as soon as their bucket closes.
import { emptyDetector, feed, parseLiveInput, countTwitchEmotes, countYoutubeEmotes, type ChatEvent, type DetectorState, type Window } from "@/lib/live-detect";

type Admin = (typeof import("@/integrations/supabase/client.server"))["supabaseAdmin"];
type Monitor = { id: string; user_id: string; platform: string; input: string; channel_id: string | null; channel_title: string | null; live_video_id: string | null;
  live_chat_id: string | null; status: string; page_token: string | null; stream_started_at: string | null; stats: any; media_mode: string; messages_seen: number };
type Patch = Record<string, unknown>;
const YT = "https://www.googleapis.com/youtube/v3";
const OFFLINE_RECHECK_MS = 15 * 60_000; // search.list costs 100 quota units; 96/day fits the default 10k quota
export const youtubeConfigured = () => Boolean(process.env["YOUTUBE_API_KEY"]);
export const twitchHelixConfigured = () => Boolean(process.env["TWITCH_API_KEY"] && process.env["LOVABLE_API_KEY"]);

class LiveError extends Error { constructor(msg: string, public kind: "offline" | "blocked" | "retry") { super(msg); } }

async function yt(path: string, q: Record<string, string>) {
  const key = process.env["YOUTUBE_API_KEY"]; if (!key) throw new LiveError("Не подключено: YOUTUBE_API_KEY", "blocked");
  const r = await fetch(`${YT}/${path}?${new URLSearchParams({ ...q, key })}`, { signal: AbortSignal.timeout(10_000) });
  const body: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    const reason = body?.error?.errors?.[0]?.reason ?? r.status;
    if (["liveChatEnded", "liveChatNotFound", "liveChatDisabled"].includes(reason)) throw new LiveError(`Чат эфира недоступен: ${reason}`, "offline");
    if (reason === "quotaExceeded" || reason === "rateLimitExceeded") throw new LiveError(`YouTube: лимит квоты (${reason})`, "retry");
    throw new LiveError(`YouTube API ${r.status}: ${String(body?.error?.message ?? reason).slice(0, 160)}`, r.status >= 500 ? "retry" : "blocked");
  }
  return body;
}

async function youtubeStep(m: Monitor): Promise<{ patch: Patch; events: ChatEvent[]; continuous: boolean }> {
  if (!m.live_chat_id) {
    const p = parseLiveInput(m.input); if (!p || p.platform !== "youtube") throw new LiveError("Не распознан YouTube-адрес", "blocked");
    let videoId = p.videoId, channelId = p.channelId ?? m.channel_id ?? undefined, title = m.channel_title;
    if (!videoId) {
      if (!channelId) {
        const c = await yt("channels", { part: "snippet", forHandle: p.handle! });
        if (!c.items?.length) throw new LiveError("Канал не найден", "blocked");
        channelId = c.items[0].id; title = c.items[0].snippet?.title ?? null;
      }
      const s = await yt("search", { part: "id", channelId: channelId!, eventType: "live", type: "video", maxResults: "1" });
      videoId = s.items?.[0]?.id?.videoId;
      if (!videoId) return { patch: { status: "offline", status_detail: "Канал сейчас не в эфире; повторная проверка через 15 мин", channel_id: channelId, channel_title: title, next_poll_at: iso(OFFLINE_RECHECK_MS) }, events: [], continuous: true };
    }
    const v = await yt("videos", { part: "snippet,liveStreamingDetails", id: videoId });
    const it = v.items?.[0]; const d = it?.liveStreamingDetails;
    if (!d?.activeLiveChatId || d.actualEndTime) return { patch: { status: "offline", status_detail: d?.actualEndTime ? "Эфир завершён" : "У видео нет активного чата эфира", live_video_id: videoId, channel_id: it?.snippet?.channelId ?? channelId, next_poll_at: iso(OFFLINE_RECHECK_MS), ...(p.videoId ? {} : {}) }, events: [], continuous: true };
    return { patch: { status: "live", status_detail: "Эфир найден, читаю чат", live_video_id: videoId, live_chat_id: d.activeLiveChatId, channel_id: it.snippet.channelId,
      channel_title: it.snippet.channelTitle ?? title, stream_started_at: d.actualStartTime ?? null, page_token: null, next_poll_at: iso(0) }, events: [], continuous: true };
  }
  const q: Record<string, string> = { liveChatId: m.live_chat_id, part: "snippet,authorDetails", maxResults: "2000" };
  if (m.page_token) q["pageToken"] = m.page_token;
  try {
    const r = await yt("liveChat/messages", q);
    const events: ChatEvent[] = (r.items ?? []).filter((i: any) => i.snippet?.type === "textMessageEvent" || i.snippet?.type === "superChatEvent")
      .map((i: any) => ({ ts: Date.parse(i.snippet.publishedAt), author: i.authorDetails?.channelId ?? i.snippet.authorChannelId, emotes: countYoutubeEmotes(i.snippet.displayMessage ?? "") }));
    if (r.offlineAt) return { patch: { status: "offline", status_detail: "Эфир завершён", live_chat_id: null, page_token: null, next_poll_at: iso(OFFLINE_RECHECK_MS) }, events, continuous: true };
    // Respect the API's pollingIntervalMillis (never faster than 5s).
    return { patch: { status: "live", status_detail: `Чат: ${events.length} сообщ. за опрос`, page_token: r.nextPageToken ?? m.page_token, next_poll_at: iso(Math.max(5000, Number(r.pollingIntervalMillis) || 5000)) }, events, continuous: true };
  } catch (e) {
    if (e instanceof LiveError && e.kind === "offline") return { patch: { status: "offline", status_detail: e.message, live_chat_id: null, page_token: null, next_poll_at: iso(OFFLINE_RECHECK_MS) }, events: [], continuous: true };
    throw e;
  }
}

async function twitchStatus(login: string): Promise<{ live: boolean; startedAt?: string; title?: string } | null> {
  if (!twitchHelixConfigured()) return null;
  const r = await fetch(`https://connector-gateway.lovable.dev/twitch/streams?user_login=${encodeURIComponent(login)}`, {
    headers: { Authorization: `Bearer ${process.env["LOVABLE_API_KEY"]}`, "X-Connection-Api-Key": process.env["TWITCH_API_KEY"]! }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new LiveError(`Twitch API ${r.status}: ${(await r.text()).slice(0, 160)}`, r.status >= 500 ? "retry" : "blocked");
  const s = (await r.json() as any).data?.[0];
  return s ? { live: true, startedAt: s.started_at, title: s.user_name } : { live: false };
}

/** Anonymous read-only IRC session (Twitch documents justinfan logins for read-only chat). */
export function sampleTwitchChat(login: string, ms: number): Promise<{ events: ChatEvent[]; joined: boolean }> {
  return new Promise((resolve) => {
    const events: ChatEvent[] = []; let joined = false; let done = false;
    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    const finish = () => { if (done) return; done = true; try { ws.close(); } catch { /* closed */ } resolve({ events, joined }); };
    const timer = setTimeout(finish, ms);
    ws.addEventListener("open", () => { ws.send("CAP REQ :twitch.tv/tags"); ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`); ws.send(`JOIN #${login}`); });
    ws.addEventListener("message", (ev) => {
      for (const line of String(ev.data).split("\r\n")) {
        if (line.startsWith("PING")) ws.send("PONG :tmi.twitch.tv");
        else if (line.includes(` JOIN #${login}`) || line.includes(" 366 ")) joined = true;
        else if (line.includes(" PRIVMSG #")) {
          const tags = Object.fromEntries(line.slice(1, line.indexOf(" ")).split(";").map((kv) => kv.split("=") as [string, string]));
          const author = tags["user-id"] || line.split("!")[0]!; const ts = Number(tags["tmi-sent-ts"]) || Date.now();
          events.push({ ts, author, emotes: countTwitchEmotes(tags["emotes"]) });
        }
      }
    });
    ws.addEventListener("error", () => { clearTimeout(timer); finish(); });
    ws.addEventListener("close", () => { clearTimeout(timer); finish(); });
  });
}

async function twitchStep(m: Monitor, sampleMs: number): Promise<{ patch: Patch; events: ChatEvent[]; continuous: boolean }> {
  const p = parseLiveInput(m.input); if (!p || p.platform !== "twitch") throw new LiveError("Не распознан Twitch-адрес", "blocked");
  const st = await twitchStatus(p.login);
  if (st && !st.live) return { patch: { status: "offline", status_detail: "Канал не в эфире (Twitch API)", channel_id: p.login, next_poll_at: iso(2 * 60_000) }, events: [], continuous: false };
  const { events, joined } = await sampleTwitchChat(p.login, sampleMs);
  if (!joined) throw new LiveError("Не удалось подключиться к чату Twitch", "retry");
  const statusNote = st ? "Эфир подтверждён Twitch API" : "Статус эфира не проверен (нет подключения Twitch); чат читается анонимно";
  return { patch: { status: "live", status_detail: `${statusNote} · выборка ${Math.round(sampleMs / 1000)} с: ${events.length} сообщ.`, channel_id: p.login, channel_title: st?.title ?? p.login,
    ...(st?.startedAt ? { stream_started_at: st.startedAt } : {}), next_poll_at: iso(0) }, events, continuous: false };
}

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

async function persistWindows(db: Admin, m: Monitor, started: string | null, windows: Window[]) {
  for (const w of windows) {
    const row = { monitor_id: m.id, user_id: m.user_id, start_at: new Date(w.start).toISOString(), end_at: new Date(w.end).toISOString(), peak_at: new Date(w.peak).toISOString(),
      offset_s: started ? Math.max(0, (w.start - Date.parse(started)) / 1000) : null, score: w.score, chatters: w.chatters, emotes: w.emotes,
      status: m.media_mode === "timestamp_only" ? "timestamp_only" : "awaiting_media", updated_at: new Date().toISOString() };
    // Upsert on (monitor_id,start_at): a merged window only extends end/peak; never resets clip progress.
    const { data: existing } = await db.from("live_highlights").select("id,status").eq("monitor_id", m.id).eq("start_at", row.start_at).maybeSingle();
    if (existing) await db.from("live_highlights").update({ end_at: row.end_at, peak_at: row.peak_at, score: row.score, chatters: row.chatters, emotes: row.emotes, updated_at: row.updated_at }).eq("id", existing.id).in("status", ["timestamp_only", "awaiting_media"]);
    else await db.from("live_highlights").insert(row);
  }
}

/** Advance one monitor once under a lease. Returns false when it could not be claimed. */
export async function advanceMonitor(db: Admin, id: string, sampleMs: number): Promise<boolean> {
  const lease = crypto.randomUUID(), now = new Date().toISOString();
  const { data: claimed } = await db.from("live_monitors").update({ lease, lease_until: iso(sampleMs + 30_000) }).eq("id", id).not("status", "eq", "stopped")
    .lte("next_poll_at", now).or(`lease_until.is.null,lease_until.lt.${now}`).select("*").maybeSingle();
  if (!claimed) return false;
  const m = claimed as unknown as Monitor;
  let patch: Patch;
  try {
    const step = m.platform === "youtube" ? await youtubeStep(m) : await twitchStep(m, sampleMs);
    const state: DetectorState = m.stats?.detector ?? emptyDetector();
    const windows = feed(state, step.events, Date.now(), step.continuous);
    await persistWindows(db, m, (step.patch["stream_started_at"] as string | undefined) ?? m.stream_started_at, windows);
    patch = { ...step.patch, stats: { ...m.stats, detector: state, last_batch: step.events.length, threshold: Math.round((Math.max(8, state.mean + 3 * Math.sqrt(state.var) + 2)) * 10) / 10 },
      messages_seen: m.messages_seen + step.events.length, last_poll_at: new Date().toISOString() };
  } catch (e) {
    const le = e instanceof LiveError ? e : new LiveError(String((e as Error)?.message ?? e).slice(0, 200), "retry");
    patch = { status: le.kind === "blocked" ? "blocked" : m.status === "resolving" ? "resolving" : m.status, status_detail: le.message, next_poll_at: iso(le.kind === "blocked" ? 10 * 60_000 : 60_000), last_poll_at: new Date().toISOString() };
  }
  // Fenced write: a stopped monitor or a newer lease discards this result.
  await db.from("live_monitors").update({ ...patch, lease: null, lease_until: null }).eq("id", id).eq("lease", lease).neq("status", "stopped");
  return true;
}

/** Background drain: advance every due monitor in parallel within the budget. */
export async function drainLive(budgetMs: number, userId?: string) {
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  let q = db.from("live_monitors").select("id").neq("status", "stopped").lte("next_poll_at", new Date().toISOString()).limit(8);
  if (userId) q = q.eq("user_id", userId);
  const { data } = await q;
  const done = await Promise.all((data ?? []).map((r) => advanceMonitor(db, r.id, Math.max(5000, budgetMs - 5000)).catch((e) => { console.error("live monitor", e); return false; })));
  return done.filter(Boolean).length;
}
