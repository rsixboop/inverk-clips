import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { TabCapture } from "@/components/studio/TabCapture";
import { buildWindowsLauncher } from "@/lib/recorder-launcher";
import { addMonitor, setMediaMode, revokeWorkerTokens, createPhilClipToken, createWorkerToken, highlightUrl, liveStatus, monitorAction, tickLive } from "@/lib/live.functions";

const ST: Record<string, string> = { resolving: "поиск эфира", live: "в эфире", offline: "не в эфире", blocked: "заблокировано", stopped: "остановлено" };
const HS: Record<string, string> = { timestamp_only: "только таймкод", awaiting_media: "ждёт запись", claimed: "рекордер режет", done: "MP4 готов", failed: "ошибка", unavailable: "медиа недоступно" };
const MODES = [["timestamp_only", "Только таймкоды"], ["recorder", "Рекордер (свой эфир)"], ["recording_url", "Своя запись/поток по ссылке"]] as const;
// Worker timers are not throttled when this tab is in the background, so chat polling keeps going.
function workerSleep(ms: number) { return new Promise<void>((r) => { const w = new Worker(URL.createObjectURL(new Blob([`setTimeout(()=>postMessage(0),${ms})`], { type: "text/javascript" }))); w.onmessage = () => { w.terminate(); r(); }; }); }
const t = (s: string) => new Date(s).toLocaleTimeString("ru");

export function LivePanel() {
  const qc = useQueryClient();
  const philToken = useServerFn(createPhilClipToken);
  const switchMode = useServerFn(setMediaMode); const revoke = useServerFn(revokeWorkerTokens); const [swRights, setSwRights] = useState<Record<string, boolean>>({});
  const add = useServerFn(addMonitor), act = useServerFn(monitorAction), tick = useServerFn(tickLive), mkToken = useServerFn(createWorkerToken), dl = useServerFn(highlightUrl), status = useServerFn(liveStatus);
  const [input, setInput] = useState(""); const [mode, setMode] = useState<string>("timestamp_only"); const [rec, setRec] = useState(""); const [rights, setRights] = useState(false); const [token, setToken] = useState("");
  const creds = useQuery({ queryKey: ["live-creds"], queryFn: () => status() }).data;
  const monitors = useQuery({ queryKey: ["live-monitors"], queryFn: async () => (await supabase.from("live_monitors").select("*").order("created_at", { ascending: false })).data ?? [], refetchInterval: 5000, refetchIntervalInBackground: true }).data ?? [];
  const hl = useQuery({ queryKey: ["live-highlights"], queryFn: async () => (await supabase.from("live_highlights").select("*").order("start_at", { ascending: false }).limit(100)).data ?? [], refetchInterval: 5000, refetchIntervalInBackground: true }).data ?? [];
  const scenes = useQuery({ queryKey: ["live-scenes"], queryFn: async () => (await supabase.from("live_scene_checks").select("*").order("frame_at", { ascending: false }).limit(60)).data ?? [], refetchInterval: 10000 }).data ?? [];
  const active = monitors.some((m) => m.status !== "stopped");
  // Open tab drives polling (the minute cron does it on the published app).
  useEffect(() => { if (!active) return; let on = true; const loop = async () => { while (on) { try { await tick(); } catch { /* shown via status */ } await workerSleep(2000); } }; loop(); return () => { on = false; }; }, [active, tick]);
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
            <RecorderRow m={m} rights={!!swRights[m.id]} setRights={(v) => setSwRights((x) => ({ ...x, [m.id]: v }))}
              onSwitch={async (mode) => { try { await switchMode({ data: { id: m.id, media_mode: mode, rights: mode === "timestamp_only" || !!swRights[m.id] } }); refresh(); } catch (e) { toast.error((e as Error).message); } }} />
            {m.platform === "youtube" && <TabCapture monitorId={m.id} />}
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
        <b className="text-foreground">Рекордер на вашем компьютере (Windows)</b>
        <p>1. Установите Streamlink для Windows (в нём уже есть ffmpeg). Python возьмётся системный или встроенный в Streamlink; если его нет, запуск подскажет, как поставить.</p>
        <p>2. Скачайте запуск рекордера и откройте файл двойным щелчком. Он сам скачает актуальный рекордер.</p>
        <button onClick={() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([buildWindowsLauncher(window.location.origin)], { type: "application/octet-stream" })); a.download = "inverk-recorder.bat"; a.click(); }} className="rounded border border-border px-2 py-1">Скачать запуск рекордера для Windows (.bat)</button>
        <p>3. Создайте токен и вставьте его в окно рекордера, когда он попросит (ввод скрыт, токен хранится только у вас в профиле Windows). Новый токен: запустите с параметром --reset-token. macOS/Linux: <a className="underline" href="/recorder/recorder.py" download>recorder.py</a>, нужны Python 3, ffmpeg и streamlink.</p>
        <button onClick={async () => { try { setToken((await mkToken()).token); } catch (e) { toast.error((e as Error).message); } }} className="rounded border border-border px-2 py-1">Создать токен рекордера</button>
        <button className="rounded border border-border px-2 py-1" onClick={async () => {
          try { setToken((await philToken()).token); } catch (e) { toast.error((e as Error).message); }
        }}>Создать токен Фила для чтения клипов</button>
        {token && <p className="flex flex-wrap items-center gap-2 font-mono text-foreground"><span className="break-all">{token}</span>
          <button onClick={async () => { try { await navigator.clipboard.writeText(token); setToken(""); toast.success("Токен скопирован и скрыт"); } catch { toast.error("Не удалось скопировать — выделите вручную"); } }} className="rounded border border-border px-2 font-sans">Скопировать и скрыть</button>
          <span className="font-sans text-warning">показан один раз</span></p>}
        <button onClick={async () => { if (!confirm("Отозвать все токены рекордера и Фила? Запущенный рекордер попросит новый.")) return; try { const r = await revoke(); setToken(""); toast.success(`Отозвано токенов: ${r.revoked}. Создайте новый и запустите рекордер с --reset-token`); } catch (e) { toast.error((e as Error).message); } }} className="ml-2 rounded border border-border px-2 py-1">Отозвать все токены</button>
      </div>
    </div>
  );
}

const ago = (iso: string) => Math.round((Date.now() - Date.parse(iso)) / 1000);
/** In-place switch timestamp_only ⇄ recorder (peaks are kept) and the recorder's heartbeat/buffer/errors. */
function RecorderRow({ m, rights, setRights, onSwitch }: { m: any; rights: boolean; setRights: (v: boolean) => void; onSwitch: (mode: "timestamp_only" | "recorder") => void }) {
  const rs = m.recorder_state as null | { at: string; buffer_s: number; ready: boolean; error: string | null; version?: string; quality?: string | null };
  if (m.media_mode === "timestamp_only") return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
      <label className="flex items-center gap-1"><input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} />это мой эфир или есть разрешение на запись</label>
      <button disabled={!rights} onClick={() => onSwitch("recorder")} className="rounded border border-border px-2 disabled:opacity-50">Включить рекордер (найденные всплески сохранятся)</button>
    </div>);
  if (m.media_mode !== "recorder") return null;
  const age = rs ? ago(rs.at) : null; const online = age != null && age < 45;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px]">
      <span className={online ? "text-primary" : "text-warning"}>Рекордер: {rs ? (online ? `на связи (${age} с назад)` : `нет связи ${Math.round(age! / 60)} мин`) : "ещё не подключался — запустите inverk-recorder.bat"}</span>
      {rs && online && <span>буфер {Math.floor(rs.buffer_s / 60)}:{String(Math.floor(rs.buffer_s % 60)).padStart(2, "0")} · {rs.ready ? "готов резать (есть 20 с до всплеска)" : "набирает буфер"}{rs.quality ? ` · поток ${rs.quality}` : ""}</span>}
      {rs?.error && <span className="text-warning">{rs.error}</span>}
      <span className="text-muted-foreground">новые всплески режутся рекордером; найденные до включения остаются таймкодами</span>
      <button onClick={() => onSwitch("timestamp_only")} className="rounded border border-border px-2 font-sans">Только таймкоды</button>
    </div>);
}
