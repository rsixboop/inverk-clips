import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { tiktokPost, tiktokRefresh } from "@/lib/vps.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Row = { kind: string; row_key: string; data: any; updated_at: string };
const fmt = (s?: string | null) => s ? new Date(s).toLocaleString("ru-RU") : "N/A";

export function TikTokPanel({ agentId, version, rows }: { agentId: string; version: string | null; rows: Row[] }) {
  const refresh = useServerFn(tiktokRefresh); const submit = useServerFn(tiktokPost); const qc = useQueryClient();
  const [busy, setBusy] = useState(false); const [channel, setChannel] = useState(""); const [job, setJob] = useState("");
  const [text, setText] = useState(""); const [mode, setMode] = useState<"draft" | "schedule" | "publish">("draft"); const [due, setDue] = useState("");
  const channels = rows.filter((r) => r.kind === "buffer:channels" && r.data.service === "tiktok");
  const posts = rows.filter((r) => r.kind === "buffer:posts" && channels.some((c) => c.row_key === r.data.channel));
  const error = rows.find((r) => r.kind === "buffer:error");
  const clips = useQuery({ queryKey: ["tiktok-ready-clips"], queryFn: async () => {
    const { data, error } = await supabase.from("jobs").select("id,prompt,caption").eq("status", "succeeded").eq("output_mime", "video/mp4").not("output_path", "is", null).order("finished_at", { ascending: false }).limit(50);
    if (error) throw error; return data ?? [];
  } }).data ?? [];
  const selected = channels.find((c) => c.row_key === channel);
  return <section className="space-y-3 border-t border-border pt-3">
    <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">TikTok · Buffer</h2>
      <Button size="sm" variant="secondary" disabled={busy} onClick={async () => {
        setBusy(true); try { await refresh({ data: { agent_id: agentId } }); toast.success("Обновление в очереди VPS"); await qc.invalidateQueries({ queryKey: ["vps-cmds"] }); }
        catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
      }}><RefreshCw className="h-3.5 w-3.5" /> Обновить</Button>
    </div>
    {version !== "1.2" && <p className="text-xs text-warning">Нужен VPS агент 1.2. Сначала опубликуйте обновление приложения, затем обновите только inverk-agent и дождитесь сигнала версии 1.2.</p>}
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Обновление VPS агента</summary><pre className="mt-2 whitespace-pre-wrap break-all border border-border p-2">curl -fsSL https://inverk-clips.lovable.app/vps/update.sh | sudo bash</pre></details>
    {error && <p className="text-xs text-destructive">{error.data.error} · {fmt(error.updated_at)}</p>}
    {!channels.length && <p className="text-xs text-muted-foreground">Подключённые TikTok аккаунты пока не получены.</p>}
    {channels.map((c) => <div key={c.row_key} className="border-b border-border py-2 text-xs">
      <p className="font-medium">{c.data.name} · {c.data.disconnected === false ? "подключён" : c.data.disconnected === true ? "отключён" : "статус N/A"}{c.data.locked ? " · заблокирован" : ""}{c.data.paused ? " · очередь на паузе" : ""}</p>
      <p className="text-muted-foreground">Подписчики: {c.data.followers ?? "N/A"} · данные {fmt(c.updated_at)} · ID {c.row_key}</p>
      {c.data.metrics_note && <p className="text-warning">Метрики N/A: {c.data.metrics_note}</p>}
      {c.data.truncated && <p className="text-muted-foreground">Показаны последние 50 постов каждого статуса на организацию.</p>}
    </div>)}
    <Tabs defaultValue="sent"><TabsList><TabsTrigger value="sent">Опубликованные</TabsTrigger><TabsTrigger value="draft">Черновики</TabsTrigger><TabsTrigger value="scheduled">Очередь</TabsTrigger></TabsList>
      {(["sent", "draft", "scheduled"] as const).map((status) => <TabsContent key={status} value={status} className="space-y-2">
        {!posts.some((p) => p.data.status === status) && <p className="text-xs text-muted-foreground">Нет полученных постов.</p>}
        {posts.filter((p) => p.data.status === status).map((p) => <div key={p.row_key} className="border-b border-border py-2 text-xs">
          <p className="break-words">{p.data.text}</p><p className="font-mono text-muted-foreground">{p.row_key} · {p.data.status} · {fmt(status === "sent" ? p.data.sent_at : p.data.due_at)}</p>
          {typeof p.data.external_link === "string" && p.data.external_link.startsWith("https://") && <a className="underline" href={p.data.external_link} target="_blank" rel="noreferrer">Открыть в TikTok</a>}
          {(p.data.assets ?? []).filter((a: any) => String(a.mimeType).startsWith("video/") && a.status === "ready" && typeof a.source === "string" && a.source.startsWith("https://")).map((a: any, i: number) => <video key={i} className="mt-2 max-h-72 w-full bg-background" src={a.source} controls preload="none" />)}
          {p.data.error && <p className="text-destructive">{p.data.error}</p>}
          <p className="text-muted-foreground">{channels.find((c) => c.row_key === p.data.channel)?.data.name} · данные {fmt(p.updated_at)}</p>
          {Array.isArray(p.data.metrics) && p.data.metrics.length ? <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">{p.data.metrics.map((m: any) => <span key={m.type}>{m.name || m.type}: {m.value ?? "N/A"}{m.unit === "percentage" ? "%" : ""}</span>)}</div> : <p className="text-muted-foreground">Метрики: N/A</p>}
          <p className="text-muted-foreground">Обновление метрик: {fmt(p.data.metrics_updated_at)}</p>
        </div>)}
      </TabsContent>)}
    </Tabs>
    <form className="space-y-2 border-t border-border pt-3" onSubmit={async (e) => {
      e.preventDefault(); if (!selected || !job || !text.trim()) return;
      const action = mode === "draft" ? "Создать черновик" : mode === "schedule" ? "Запланировать публикацию" : "Опубликовать сейчас";
      if (!confirm(`${action} в TikTok @${selected.data.name} (${channel})?`)) return;
      setBusy(true);
      try {
        const result = await submit({ data: { agent_id: agentId, job_id: job, channel_id: channel, authorized_channel_id: channel, text: text.trim(), mode, ...(mode === "schedule" ? { due_at: new Date(due).toISOString() } : {}) } });
        toast.success(`Команда Buffer: ${"command_id" in result ? result.command_id : "в очереди"}`); await qc.invalidateQueries({ queryKey: ["vps-cmds"] });
      } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
    }}>
      <select aria-label="TikTok аккаунт" className="w-full rounded border border-input bg-background p-2 text-sm" value={channel} onChange={(e) => setChannel(e.target.value)}><option value="">Выберите аккаунт</option>{channels.map((c) => <option key={c.row_key} value={c.row_key}>{c.data.name}</option>)}</select>
      <select aria-label="Готовый клип" className="w-full rounded border border-input bg-background p-2 text-sm" value={job} onChange={(e) => { setJob(e.target.value); setText(clips.find((c) => c.id === e.target.value)?.caption ?? ""); }}><option value="">Готовый MP4 из Библиотеки</option>{clips.map((c) => <option key={c.id} value={c.id}>{c.id.slice(0, 8)} · {c.prompt.slice(0, 80)}</option>)}</select>
      <Textarea aria-label="Подпись TikTok" placeholder="Подпись" maxLength={2200} rows={2} value={text} onChange={(e) => setText(e.target.value)} />
      <select aria-label="Действие Buffer" className="w-full rounded border border-input bg-background p-2 text-sm" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="draft">Черновик</option><option value="schedule">По расписанию</option><option value="publish">Опубликовать сейчас</option></select>
      {mode === "schedule" && <Input aria-label="Время публикации" type="datetime-local" required value={due} onChange={(e) => setDue(e.target.value)} />}
      <Button type="submit" size="sm" disabled={busy || version !== "1.2" || !selected || !job || !text.trim()}>{mode === "draft" ? "Создать черновик" : mode === "schedule" ? "Запланировать" : "Опубликовать сейчас"}</Button>
    </form>
  </section>;
}