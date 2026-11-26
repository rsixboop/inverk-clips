import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { AppShell } from "@/components/studio/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useVpsAgent } from "@/components/vps/useVps";
import { VpsBadge } from "@/components/vps/VpsBadge";
import { agentState, parseRedditUrl, type ServiceInfo } from "@/lib/vps-ops";
import { Textarea } from "@/components/ui/textarea";
import { createVpsPairing, enqueueVpsOp, revokeVpsAgent } from "@/lib/vps.functions";

export const Route = createFileRoute("/control")({
  head: () => ({ meta: [
    { title: "VPS — Inverk Clips" }, { name: "description", content: "Архив Reddit, сбор, рекордер, Buffer и история действий VPS." },
    { property: "og:title", content: "VPS — Inverk Clips" }, { property: "og:description", content: "Управление VPS с телефона." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: () => <AppShell>{() => <Control />}</AppShell>,
});

type Row = { kind: string; row_key: string; data: any; updated_at: string };
const fmt = (s?: string | null) => (s ? new Date(s).toLocaleString("ru-RU", { hour12: false }) : "—");

function Control() {
  const agent = useVpsAgent().data;
  const st = agentState(agent);
  const mirror = useQuery({ queryKey: ["vps-mirror", agent?.id], enabled: !!agent, refetchInterval: 20000, queryFn: async () =>
    ((await supabase.from("vps_mirror").select("kind,row_key,data,updated_at").eq("agent_id", agent!.id).limit(5000)).data ?? []) as Row[] }).data ?? [];
  const cmds = useQuery({ queryKey: ["vps-cmds", agent?.id], enabled: !!agent, refetchInterval: 5000, queryFn: async () =>
    (await supabase.from("vps_commands").select("id,op,args,status,error,result,created_at,done_at").eq("agent_id", agent!.id).order("created_at", { ascending: false }).limit(50)).data ?? [] }).data ?? [];
  const qc = useQueryClient();
  const enqueue = useServerFn(enqueueVpsOp);
  const run = async (op: string, args: object, key?: string) => {
    try { await enqueue({ data: { agent_id: agent!.id, op, args, idem_key: key ?? `${op}:${crypto.randomUUID()}` } }); toast.success("Отправлено на VPS"); qc.invalidateQueries({ queryKey: ["vps-cmds"] }); }
    catch (e) { toast.error((e as Error).message); }
  };

  if (!agent) return <div className="mx-auto max-w-xl space-y-4"><h1 className="text-base font-bold">VPS</h1><Pairing /></div>;
  const services = Object.entries((agent.services ?? {}) as Record<string, ServiceInfo>);
  const workloads = (agent.info as { workloads?: Record<string, { memory_mib: number; cpu_percent: number | null }> } | null)?.workloads;
  const stories = mirror.filter((r) => r.kind === "stories");
  const settings = mirror.find((r) => r.kind === "settings")?.data as { enabled: boolean; minutes: number } | undefined;
  const chans = mirror.filter((r) => r.kind === "buffer:channels");
  const posts = mirror.filter((r) => r.kind === "buffer:posts");
  const bufErr = mirror.find((r) => r.kind === "buffer:error")?.data?.error;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-base font-bold">VPS · {agent.name}</h1><VpsBadge /></div>
      <p className="font-mono text-[11px] text-muted-foreground">агент {agent.agent_version || "?"} · сигнал {fmt(agent.last_seen_at)} · подтверждённое время сервера {fmt(agent.last_server_ts)} · база {(agent.info as any)?.db ? "есть" : "не найдена"} · buffer.key {(agent.info as any)?.buffer_key ? "есть" : "нет"}</p>
      {st === "stale" && <p className="text-sm text-warning">Нет сигнала больше 75 с. Команды подождут и выполнятся, когда агент вернётся.</p>}

      <Section title="Нагрузка на VPS">
        <table className="w-full text-left text-sm tabular-nums">
          <thead className="text-xs text-muted-foreground"><tr><th>Приложение</th><th>CPU · % VPS</th><th>Память</th></tr></thead>
          <tbody>{Object.entries({ phil: "Фил", clips: "Нарезчик" }).map(([key, label]) => {
            const sample = workloads?.[key];
            return <tr key={key} className="border-t border-border">
              <th scope="row" className="py-2 text-left font-medium">{label}</th>
              <td>{sample?.cpu_percent == null ? "—" : sample.cpu_percent.toLocaleString("ru-RU") + " %"}</td>
              <td>{sample ? sample.memory_mib.toLocaleString("ru-RU") + " МиБ" : "—"}</td>
            </tr>;
          })}</tbody>
        </table>
        <p className="text-xs text-muted-foreground">Последний замер · {fmt(agent.last_seen_at)}. Прочерк означает, что данных нет.</p>
      </Section>

      <Section title="Службы и рекордер">
        {!services.length && <p className="text-sm text-muted-foreground">Агент не нашёл служб inverk*.</p>}
        {services.map(([u, s]) => (
          <div key={u} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-1.5 text-sm last:border-0">
            <span className="font-mono text-xs">{u}</span>
            <span className="flex items-center gap-2">
              <span className={s.active === "active" ? "text-primary" : s.active === "failed" ? "text-destructive" : "text-muted-foreground"}>{s.active}{s.sub ? `/${s.sub}` : ""}{s.result && s.result !== "success" ? ` · ${s.result}` : ""}</span>
              <Button size="sm" variant="secondary" onClick={() => confirm(`Перезапустить ${u}?`) && run("service.restart", { unit: u })}>Перезапуск</Button>
            </span>
          </div>
        ))}
      </Section>

      <Section title="Сбор Reddit">
        <CollectForm current={settings} onSave={(enabled, minutes) => run("collect.set", { enabled, minutes }, `collect:${enabled}:${minutes}:${(Date.now() / 60000) | 0}`)} />
      </Section>

      <Section title="Архив" right={<Button size="sm" variant="secondary" onClick={() => run("sync.now", {})}>Обновить</Button>}>
        <RedditForm onAdd={(url, title, body) => run("reddit.add", { url, ...(title ? { title } : {}), ...(body ? { body } : {}) }, `reddit:${url}:${body ? body.length : 0}:${title ?? ""}`)} />
        {!stories.length && <p className="text-sm text-muted-foreground">Архив ещё не получен с VPS.</p>}
        {stories.map((r) => <StoryRow key={r.row_key} r={r} />)}
      </Section>

      <Section title="Buffer" right={<Button size="sm" variant="secondary" onClick={() => run("buffer.refresh", {})}>Обновить</Button>}>
        <p className="text-[11px] text-muted-foreground">Приложение ничего не публикует. Черновик в Buffer создаётся только по вашей кнопке.</p>
        {chans.length > 0 && <DraftForm chans={chans} onCreate={(channel_id, text, video_url) => run("buffer.create_draft", { channel_id, text, video_url })} />}
        {bufErr && <p className="text-sm text-destructive">{bufErr}</p>}
        {chans.map((c) => {
          const ps = posts.filter((p) => p.data.channel === c.row_key);
          return (
            <div key={c.row_key} className="border-b border-border py-2 last:border-0">
              <div className="text-sm font-medium">{c.data.name} <span className="text-xs text-muted-foreground">{c.data.service}{c.data.paused ? " · пауза" : ""} · черновиков {ps.filter((p) => p.data.status === "draft").length} · в очереди {ps.filter((p) => p.data.status === "scheduled").length}</span></div>
              {ps.slice(0, 10).map((p) => <div key={p.row_key} className="mt-1 text-xs"><span className="text-muted-foreground">{p.data.status === "draft" ? "черновик" : `очередь ${fmt(p.data.due_at)}`}</span> · {String(p.data.text).slice(0, 140)}</div>)}
            </div>
          );
        })}
      </Section>

      <Section title="История действий">
        {!cmds.length && <p className="text-sm text-muted-foreground">Пока пусто.</p>}
        {cmds.map((c: any) => (
          <div key={c.id} className="border-b border-border py-1.5 text-xs last:border-0">
            <span className={c.status === "done" ? "text-primary" : c.status === "failed" ? "text-destructive" : "text-muted-foreground"}>{({ pending: "ждёт", sent: "выполняется", done: "готово", failed: "ошибка" } as any)[c.status] ?? c.status}</span>
            {" · "}<span className="font-mono">{c.op}</span> {JSON.stringify(c.args) !== "{}" && <span className="text-muted-foreground">{JSON.stringify(c.args)}</span>}
            <span className="float-right text-muted-foreground">{fmt(c.created_at)}</span>
            {c.error && <div className="text-destructive">{c.error}</div>}
            {c.result?.existing && <div className="text-muted-foreground">уже было в архиве — дубликат не создан</div>}
            {c.result?.post_id && <div className="text-muted-foreground">черновик Buffer {c.result.post_id}</div>}
          </div>
        ))}
      </Section>

      <RevokeBlock id={agent.id} />
    </div>
  );
}

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return <section className="panel space-y-2 p-3"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold">{title}</h2>{right}</div>{children}</section>;
}

function CollectForm({ current, onSave }: { current?: { enabled: boolean; minutes: number } | undefined; onSave: (enabled: boolean, m: number) => void }) {
  const [en, setEn] = useState<boolean | null>(null); const [v, setV] = useState("");
  const enabled = en ?? current?.enabled ?? false;
  return (
    <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); const m = Number(v || current?.minutes); if (m >= 5 && m <= 1440) onSave(enabled, m); else toast.error("От 5 до 1440 минут"); }}>
      <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={enabled} onChange={(e) => setEn(e.target.checked)} /> включён</label>
      <Input className="w-24" inputMode="numeric" placeholder={String(current?.minutes ?? "мин")} value={v} onChange={(e) => setV(e.target.value)} />
      <span className="text-sm text-muted-foreground">мин · сейчас: {current ? `${current.enabled ? "вкл" : "выкл"}, ${current.minutes}` : "нет данных"}</span>
      <Button size="sm" type="submit">Сохранить</Button>
    </form>
  );
}

function RedditForm({ onAdd }: { onAdd: (url: string, title?: string, body?: string) => void }) {
  const [url, setUrl] = useState(""); const [title, setTitle] = useState(""); const [body, setBody] = useState("");
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (!parseRedditUrl(url)) { toast.error("Нужна ссылка reddit.com/r/<sub>/comments/<id>/"); return; } onAdd(url.trim(), title.trim() || undefined, body.trim() || undefined); setUrl(""); setTitle(""); setBody(""); }}>
      <Input placeholder="https://www.reddit.com/r/…/comments/…/" value={url} onChange={(e) => setUrl(e.target.value)} />
      <Input placeholder="Заголовок (необязательно)" value={title} onChange={(e) => setTitle(e.target.value)} />
      <Textarea placeholder="Текст истории (необязательно, сохранится как ручной)" value={body} onChange={(e) => setBody(e.target.value)} rows={3} />
      <Button size="sm" type="submit">Добавить в архив</Button>
    </form>
  );
}

function StoryRow({ r }: { r: Row }) {
  const [open, setOpen] = useState(false); const d = r.data;
  return (
    <div className="border-t border-border pt-2 text-xs">
      <div><span className="text-muted-foreground">r/{d.community}{d.seen ? " · просмотрено" : ""}{d.manual ? " · ручной текст" : ""}</span>{" "}
        <a className="underline" href={d.url} target="_blank" rel="noreferrer">{d.title || r.row_key}</a>
        {d.body && <button className="ml-2 text-muted-foreground" onClick={() => setOpen(!open)}>{open ? "скрыть" : "текст"}</button>}</div>
      {open && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{d.body}</p>}
    </div>
  );
}

function DraftForm({ chans, onCreate }: { chans: Row[]; onCreate: (ch: string, text: string, url: string) => void }) {
  const [ch, setCh] = useState(chans[0]!.row_key); const [url, setUrl] = useState(""); const [text, setText] = useState("");
  return (
    <form className="space-y-2 border-b border-border pb-3" onSubmit={(e) => { e.preventDefault(); if (!/^https:\/\/\S+$/.test(url.trim())) { toast.error("Нужна HTTPS ссылка на видео"); return; } if (!text.trim()) { toast.error("Нужна подпись"); return; }
      if (confirm("Создать черновик в Buffer? Он не будет опубликован.")) { onCreate(ch, text.trim(), url.trim()); setUrl(""); setText(""); } }}>
      <select className="w-full rounded border border-input bg-background px-2 py-1.5 text-sm" value={ch} onChange={(e) => setCh(e.target.value)}>
        {chans.map((c) => <option key={c.row_key} value={c.row_key}>{c.data.name} · {c.data.service}</option>)}
      </select>
      <Input placeholder="https://…/video.mp4" value={url} onChange={(e) => setUrl(e.target.value)} />
      <Textarea placeholder="Подпись" value={text} onChange={(e) => setText(e.target.value)} rows={2} />
      <Button size="sm" type="submit">Создать черновик</Button>
    </form>
  );
}

function Pairing() {
  const make = useServerFn(createVpsPairing);
  const [p, setP] = useState<{ code: string; expires_at: string } | null>(null);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const cmd = p ? `curl -fsSL ${origin}/vps/install.sh | sudo bash -s -- ${p.code} ${origin}` : "";
  return (
    <Section title="Подключить VPS (один раз)">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>Нажмите «Получить код» — он одноразовый и действует 15 минут.</li>
        <li>Зайдите на VPS по SSH и выполните команду ниже. Она ставит только агента, существующие службы и данные в /var/lib/inverk-studio не трогает.</li>
        <li>Через ~30 секунд значок станет «VPS онлайн». Старый локальный интерфейс можно оставить или выключить сами.</li>
      </ol>
      {!p ? <Button size="sm" onClick={async () => setP(await make())}>Получить код</Button> : (
        <div className="space-y-2">
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-sidebar p-2 font-mono text-xs">{cmd}</pre>
          <div className="flex items-center gap-2"><Button size="sm" onClick={() => { navigator.clipboard.writeText(cmd); toast.success("Скопировано"); }}><Copy className="h-4 w-4" /> Копировать</Button>
          <span className="text-xs text-muted-foreground">до {fmt(p.expires_at)}</span></div>
        </div>
      )}
    </Section>
  );
}

function RevokeBlock({ id }: { id: string }) {
  const revoke = useServerFn(revokeVpsAgent); const qc = useQueryClient();
  return <div className="text-right"><Button size="sm" variant="ghost" onClick={async () => { if (!confirm("Отключить этот VPS? Агент перестанет получать команды.")) return; await revoke({ data: { agent_id: id } }); qc.invalidateQueries({ queryKey: ["vps-agent"] }); }}>Отключить VPS</Button></div>;
}
