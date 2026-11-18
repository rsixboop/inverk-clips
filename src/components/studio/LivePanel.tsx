import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { addMonitor, createWorkerToken, highlightUrl, liveStatus, monitorAction, tickLive } from "@/lib/live.functions";

const ST: Record<string, string> = { resolving: "поиск эфира", live: "в эфире", offline: "не в эфире", blocked: "заблокировано", stopped: "остановлено" };
const HS: Record<string, string> = { timestamp_only: "только таймкод", awaiting_media: "ждёт запись", claimed: "рекордер режет", done: "MP4 готов", failed: "ошибка", unavailable: "медиа недоступно" };
const MODES = [["timestamp_only", "Только таймкоды"], ["recorder", "Рекордер (свой эфир)"], ["recording_url", "Своя запись/поток по ссылке"]] as const;
const t = (s: string) => new Date(s).toLocaleTimeString("ru");

export function LivePanel() {
  const qc = useQueryClient();
  const add = useServerFn(addMonitor), act = useServerFn(monitorAction), tick = useServerFn(tickLive), mkToken = useServerFn(createWorkerToken), dl = useServerFn(highlightUrl), status = useServerFn(liveStatus);
  const [input, setInput] = useState(""); const [mode, setMode] = useState<string>("timestamp_only"); const [rec, setRec] = useState(""); const [rights, setRights] = useState(false); const [token, setToken] = useState("");
  const creds = useQuery({ queryKey: ["live-creds"], queryFn: () => status() }).data;
  const monitors = useQuery({ queryKey: ["live-monitors"], queryFn: async () => (await supabase.from("live_monitors").select("*").order("created_at", { ascending: false })).data ?? [], refetchInterval: 5000 }).data ?? [];
  const hl = useQuery({ queryKey: ["live-highlights"], queryFn: async () => (await supabase.from("live_highlights").select("*").order("start_at", { ascending: false }).limit(100)).data ?? [], refetchInterval: 5000 }).data ?? [];
  const scenes = useQuery({ queryKey: ["live-scenes"], queryFn: async () => (await supabase.from("live_scene_checks").select("*").order("frame_at", { ascending: false }).limit(60)).data ?? [], refetchInterval: 10000 }).data ?? [];
  const active = monitors.some((m) => m.status !== "stopped");
  // Open tab drives polling (the minute cron does it on the published app).
  useEffect(() => { if (!active) return; let on = true; const loop = async () => { while (on) { try { await tick(); } catch { /* shown via status */ } await new Promise((r) => setTimeout(r, 2000)); } }; loop(); return () => { on = false; }; }, [active, tick]);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["live-monitors"] }); qc.invalidateQueries({ queryKey: ["live-highlights"] }); };
  async function submit() {
    try { await add({ data: { input, media_mode: mode as any, recording_url: rec || undefined, rights } }); setInput(""); refresh(); } catch (e) { toast.error((e as Error).message); }
  }
  return (
    <div className="panel overflow-hidden">
      <div className="border-b border-border px-4 py-3"><h2 className="text-base font-bold">Хайлайты эфиров · YouTube Live и Twitch</h2>
        <p className="text-xs text-muted-foreground">Чат читается на сервере; всплески уникальных зрителей и эмодзи за 10 с сохраняются сразу с таймкодом. Видео режется только из своего эфира или своей записи.</p>
        <p className="mt-1 font-mono text-[11px]">YouTube: {creds?.youtube ? "ключ подключён" : <span className="text-warning">не подключено (нужен YOUTUBE_API_KEY)</span>} · Twitch: чат анонимно, статус эфира {creds?.twitchHelix ? "через Twitch API" : <span className="text-warning">не проверяется (Twitch не подключён)</span>}</p></div>
      <div className="grid gap-2 border-b border-border px-4 py-3 text-sm md:grid-cols-[1fr_200px_auto]">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="@handle, youtube.com/live/…, twitch.tv/канал" className="h-8 rounded-md border border-input bg-muted px-2 text-xs" />
        <select value={mode} onChange={(e) => setMode(e.target.value)} className="h-8 rounded-md border border-input bg-muted px-2 text-xs">{MODES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <button onClick={submit} disabled={!input} className="h-8 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground disabled:opacity-50">Следить</button>
        {mode === "recording_url" && <input value={rec} onChange={(e) => setRec(e.target.value)} placeholder="https://… прямая ссылка на вашу запись/HLS" className="h-8 rounded-md border border-input bg-muted px-2 text-xs md:col-span-3" />}
        {mode !== "timestamp_only" && <label className="flex items-center gap-2 text-xs md:col-span-3"><input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} />Это мой канал или у меня есть разрешение на запись и нарезку</label>}
      </div>
      {monitors.map((m) => {
        const mine = hl.filter((h) => h.monitor_id === m.id);
        return (
          <div key={m.id} className="border-b border-border px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><b className="truncate">{m.channel_title || m.input}</b>
              <span className="font-mono text-[11px] text-muted-foreground">{m.platform} · {ST[m.status] ?? m.status} · {MODES.find(([k]) => k === m.media_mode)?.[1]} · сообщений {m.messages_seen} · порог {(m.stats as any)?.threshold ?? "—"}</span>
              <span className="ml-auto flex gap-1">{m.status === "stopped" ? <button onClick={() => act({ data: { id: m.id, action: "start" } }).then(refresh)} className="rounded border border-border px-2 text-xs">Старт</button>
                : <button onClick={() => act({ data: { id: m.id, action: "stop" } }).then(refresh)} className="rounded border border-border px-2 text-xs">Стоп</button>}
                <button onClick={async () => { await supabase.from("live_monitors").delete().eq("id", m.id); refresh(); }} className="rounded border border-border px-2 text-xs">Удалить</button></span></div>
            {m.status_detail && <div className={`text-xs ${m.status === "blocked" ? "text-warning" : "text-muted-foreground"}`}>{m.status_detail}</div>}
            <div className="mt-1 font-mono text-[11px] text-muted-foreground">Экран: {(() => { const sc = scenes.filter((x) => x.monitor_id === m.id);
              if (!sc.length) return m.media_mode === "recorder" ? "ждёт кадров от рекордера" : "недоступно — кадры берутся только из записи рекордера";
              return sc.slice(0, 5).map((x) => `${t(x.frame_at)} ${x.activity === "unavailable" ? "недоступно" : `${x.game ?? "игра не определена"} · ${x.activity}`}${x.switched_from ? ` (смена с ${x.switched_from})` : ""}`).join(" ← "); })()}</div>
            {mine.map((h) => (
              <div key={h.id} className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px]">
                <span>{t(h.start_at)}–{t(h.end_at)}</span><span>пик {t(h.peak_at)}{h.offset_s != null ? ` · ${Math.floor(Number(h.offset_s) / 60)}:${String(Math.floor(Number(h.offset_s) % 60)).padStart(2, "0")} от начала` : ""}</span>
                <span>{h.chatters} зрит. · {h.emotes} эмодзи</span><span className="text-primary">{HS[h.status] ?? h.status}</span>{h.detail && <span className="text-muted-foreground">{h.detail}</span>}
                {h.status === "done" && <button onClick={async () => { try { window.location.href = (await dl({ data: { id: h.id } })).url; } catch (e) { toast.error((e as Error).message); } }} className="text-primary underline">Скачать MP4</button>}
              </div>))}
            {!mine.length && <div className="text-[11px] text-muted-foreground">Всплесков пока нет (первые ~60 с — калибровка порога).</div>}
          </div>);
      })}
      <div className="px-4 py-3 text-xs text-muted-foreground space-y-1">
        <b className="text-foreground">Рекордер для видео</b>
        <p>Облачная часть не может держать видеопоток, поэтому видео пишет ваш рекордер (scripts/live-recorder/recorder.py, нужны ffmpeg и streamlink). Он берёт хайлайты, режет окно с оригинальным звуком в вертикаль 1080×1920 и загружает MP4 сюда; готовые клипы появятся в Очереди и Библиотеке.</p>
        <button onClick={async () => { try { setToken((await mkToken()).token); } catch (e) { toast.error((e as Error).message); } }} className="rounded border border-border px-2 py-1">Создать токен рекордера</button>
        {token && <p className="break-all font-mono text-foreground">INVERK_URL={typeof window !== "undefined" ? window.location.origin : ""} INVERK_WORKER_TOKEN={token} python3 recorder.py <span className="text-warning">(показан один раз)</span></p>}
      </div>
    </div>
  );
}
