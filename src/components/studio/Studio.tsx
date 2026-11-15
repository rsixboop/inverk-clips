import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Upload, Link2, Play, Pause, Square, RotateCcw, Sparkles, Download, Check, Clapperboard, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { addUrlSource, createJob, getOutputUrl, jobAction } from "@/lib/jobs.functions";
import { LANGS, MODES, PERMISSIONS, STAGES } from "@/lib/job-meta";
import { useEvents, useJobs, useSources, type Job } from "@/hooks/use-jobs";
import { StatusBadge } from "./AppShell";
import { useOutputUrl } from "./useOutputUrl";

function Seg<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: readonly { key: T; label: string }[] }) {
  return (
    <div className="flex rounded-md border border-border bg-muted p-0.5">
      {items.map((i) => (
        <button key={i.key} type="button" onClick={() => onChange(i.key)}
          className={`flex-1 rounded px-2 py-1.5 text-xs font-medium transition-colors ${value === i.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

export function Studio({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const jobs = useJobs(true).data ?? [];
  const sources = (useSources(true).data ?? []).filter((s) => s.status === "ready");
  const [selected, setSelected] = useState<string | null>(null);
  const job = jobs.find((j) => j.id === selected) ?? jobs[0] ?? null;

  const [mode, setMode] = useState<"niche" | "link" | "mixed">("niche");
  const [prompt, setPrompt] = useState("Сделай 40-секундный ролик про детали GTA V с английской озвучкой");
  const [language, setLanguage] = useState<"en" | "ru" | "uk">("en");
  const [seconds, setSeconds] = useState(40);
  const [audioMode, setAudioMode] = useState<"voiceover" | "original">("voiceover");
  const [review, setReview] = useState(true);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [permission, setPermission] = useState<"owned" | "licensed" | "permitted" | "unknown">("owned");
  const [busy, setBusy] = useState<string | null>(null);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());

  const create = useServerFn(createJob);
  const addUrl = useServerFn(addUrlSource);

  async function upload(file: File) {
    if (!/^video\/(mp4|quicktime)$/.test(file.type)) return toast.error("Нужен MP4 или MOV");
    if (file.size > 200 * 1024 * 1024) return toast.error("Максимум 200 МБ");
    setBusy("upload");
    const path = `${userId}/${crypto.randomUUID()}.${file.type === "video/mp4" ? "mp4" : "mov"}`;
    const { error } = await supabase.storage.from("footage").upload(path, file, { contentType: file.type });
    if (error) { setBusy(null); return toast.error(error.message); }
    const { data, error: e2 } = await supabase.from("sources").insert({ user_id: userId, kind: "upload", storage_path: path, title: file.name, mime: file.type, bytes: file.size, permission }).select("id").single();
    setBusy(null);
    if (e2) return toast.error(e2.message);
    setSourceId(data.id); qc.invalidateQueries({ queryKey: ["sources"] }); toast.success("Видео загружено");
  }
  async function attachUrl() {
    setBusy("url");
    try {
      const s = await addUrl({ data: { url, permission, note: "" } });
      qc.invalidateQueries({ queryKey: ["sources"] });
      if (s.status === "ready") { setSourceId(s.id); setUrl(""); toast.success("Прямое видео подключено"); }
      else toast.warning(s.status_note);
    } catch (e) { toast.error((e as Error).message); }
    setBusy(null);
  }
  async function submit() {
    setBusy("create");
    try {
      const r = await create({ data: { idempotencyKey: idemKey, mode, prompt, language, targetSeconds: seconds, audioMode, reviewBeforeRender: review, nicheId: null, sourceId } });
      setSelected(r.id); setIdemKey(crypto.randomUUID());
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast.success(r.duplicate ? "Эта задача уже создана" : "Задача запущена");
    } catch (e) { toast.error((e as Error).message); }
    setBusy(null);
  }

  return (
    <div className="grid gap-4 xl:h-[calc(100vh-2.5rem)] xl:grid-cols-[340px_minmax(300px,1fr)_380px]">
      {/* Controls */}
      <section className="panel flex flex-col gap-4 overflow-y-auto p-4">
        <h1 className="text-base font-bold">Новый ролик</h1>
        <Seg value={mode} onChange={setMode} items={MODES} />
        <div className="space-y-1.5">
          <div className="label-xs">Запрос</div>
          <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} className="resize-none text-sm" />
        </div>
        <div className="space-y-2">
          <div className="label-xs">Футаж {mode === "niche" && <span className="normal-case tracking-normal">— обязателен: автопоиск лицензированного видео не подключён</span>}</div>
          <Seg value={permission} onChange={setPermission} items={PERMISSIONS.filter((p) => p.key !== "unknown")} />
          <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground hover:border-primary hover:text-foreground">
            <Upload className="h-4 w-4" /> {busy === "upload" ? "Загрузка…" : "Загрузить MP4/MOV (до 200 МБ)"}
            <input type="file" accept="video/mp4,video/quicktime" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </label>
          <div className="flex gap-2">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/video.mp4, YouTube, Twitch" className="text-xs" />
            <Button size="sm" variant="secondary" disabled={!url || busy === "url"} onClick={attachUrl}><Link2 className="h-4 w-4" /></Button>
          </div>
          <select value={sourceId ?? ""} onChange={(e) => setSourceId(e.target.value || null)} className="w-full rounded-md border border-input bg-muted px-2 py-2 text-xs">
            <option value="">— без футажа —</option>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.title} · {s.kind === "upload" ? "файл" : "ссылка"}</option>)}
          </select>
        </div>
        <div className="space-y-1.5"><div className="label-xs">Язык контента</div><Seg value={language} onChange={setLanguage} items={LANGS} /></div>
        <div className="space-y-1.5"><div className="label-xs">Звук</div>
          <Seg value={audioMode} onChange={setAudioMode} items={[{ key: "voiceover", label: "ИИ-озвучка" }, { key: "original", label: "Оригинал" }] as const} /></div>
        <div className="space-y-2">
          <div className="flex justify-between"><span className="label-xs">Длительность</span><span className="font-mono text-xs text-primary">{seconds} с</span></div>
          <Slider min={15} max={90} step={5} value={[seconds]} onValueChange={(v) => setSeconds(v[0])} />
        </div>
        <label className="flex items-center justify-between text-xs"><span>Проверить сценарий перед рендером</span><Switch checked={review} onCheckedChange={setReview} /></label>
        <Button onClick={submit} disabled={busy === "create" || !prompt.trim()} className="glow mt-auto">
          <Sparkles className="h-4 w-4" /> {busy === "create" ? "Создаю…" : "Создать ролик"}
        </Button>
      </section>

      {/* Preview */}
      <section className="flex flex-col items-center gap-3">
        <Preview job={job} />
        <RecentStrip jobs={jobs} selected={job?.id ?? null} onSelect={setSelected} />
      </section>

      {/* Details */}
      <section className="panel overflow-y-auto p-4">{job ? <JobDetails job={job} /> : <p className="text-sm text-muted-foreground">Задач пока нет. Создайте первый ролик слева.</p>}</section>
    </div>
  );
}

function Preview({ job }: { job: Job | null }) {
  const url = useOutputUrl(job?.status === "succeeded" ? job.id : null, false);
  return (
    <div className="relative aspect-[9/16] w-full max-w-[360px] overflow-hidden rounded-xl border border-border bg-sidebar xl:max-h-[calc(100vh-11rem)] xl:w-auto">
      {url ? <video key={url} src={url} controls playsInline className="h-full w-full object-contain" /> : (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          {!job && <><Clapperboard className="h-8 w-8 text-muted-foreground" /><p className="text-sm text-muted-foreground">Здесь появится готовый MP4 1080×1920</p></>}
          {job && ["queued", "running"].includes(job.status) && <><span className="pulse-dot h-3 w-3 rounded-full bg-primary" /><p className="text-sm">{STAGES.find((s) => s.key === job.stage)?.label}…</p></>}
          {job && ["failed", "blocked"].includes(job.status) && <><AlertTriangle className="h-8 w-8 text-warning" /><p className="text-sm text-muted-foreground">{job.error}</p></>}
          {job && job.status === "review" && <p className="text-sm text-warning">Сценарий ждёт вашей проверки справа →</p>}
          {job && ["paused", "cancelled"].includes(job.status) && <p className="text-sm text-muted-foreground">{job.status === "paused" ? "На паузе" : "Отменено"}</p>}
        </div>
      )}
    </div>
  );
}

function RecentStrip({ jobs, selected, onSelect }: { jobs: Job[]; selected: string | null; onSelect: (id: string) => void }) {
  if (!jobs.length) return null;
  return (
    <div className="flex w-full max-w-full gap-2 overflow-x-auto pb-1">
      {jobs.slice(0, 12).map((j) => (
        <button key={j.id} onClick={() => onSelect(j.id)} className={`min-w-40 rounded-md border px-2.5 py-2 text-left ${selected === j.id ? "border-primary" : "border-border"} bg-card`}>
          <div className="truncate text-xs">{(j.plan as any)?.title ?? j.prompt}</div>
          <div className="mt-1 flex items-center justify-between"><StatusBadge status={j.status} /><span className="font-mono text-[10px] text-muted-foreground">{new Date(j.created_at).toLocaleTimeString("ru")}</span></div>
        </button>
      ))}
    </div>
  );
}

export function JobDetails({ job }: { job: Job }) {
  const qc = useQueryClient();
  const events = useEvents(job.id).data ?? [];
  const act = useServerFn(jobAction);
  const dl = useServerFn(getOutputUrl);
  const [script, setScript] = useState(job.script ?? "");
  const [caption, setCaption] = useState(job.caption ?? "");
  useEffect(() => { setScript(job.script ?? ""); setCaption(job.caption ?? ""); }, [job.id, job.script, job.caption]);
  const plan = (job.plan ?? {}) as any;
  const stageIdx = useMemo(() => STAGES.findIndex((s) => s.key === job.stage), [job.stage]);

  async function run(action: Parameters<typeof act>[0]["data"]["action"]) {
    try { await act({ data: { jobId: job.id, action } }); qc.invalidateQueries({ queryKey: ["jobs"] }); qc.invalidateQueries({ queryKey: ["events"] }); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function save() {
    const { error } = await supabase.from("jobs").update({ script, caption }).eq("id", job.id);
    if (error) toast.error(error.message); else { toast.success("Сохранено"); qc.invalidateQueries({ queryKey: ["jobs"] }); }
  }
  async function download() {
    try { const { url } = await dl({ data: { jobId: job.id, download: true } }); window.location.href = url; } catch (e) { toast.error((e as Error).message); }
  }
  const active = ["queued", "running"].includes(job.status);

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0"><h2 className="truncate text-sm font-bold">{plan.title ?? "Ролик"}</h2><p className="truncate text-xs text-muted-foreground">{job.prompt}</p></div>
        <StatusBadge status={job.status} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {job.status === "succeeded" && <Button size="sm" onClick={download}><Download className="h-4 w-4" /> Скачать MP4</Button>}
        {job.status === "review" && <Button size="sm" onClick={() => run("approve")}><Check className="h-4 w-4" /> Рендерить</Button>}
        {active && <Button size="sm" variant="secondary" onClick={() => run("pause")}><Pause className="h-4 w-4" /> Пауза</Button>}
        {job.status === "paused" && <Button size="sm" variant="secondary" onClick={() => run("resume")}><Play className="h-4 w-4" /> Продолжить</Button>}
        {["failed", "blocked", "cancelled"].includes(job.status) && <Button size="sm" variant="secondary" onClick={() => run("retry")}><RotateCcw className="h-4 w-4" /> Повторить шаг</Button>}
        {job.plan && !(active && ["render_wait", "finalize"].includes(job.stage)) && <Button size="sm" variant="secondary" onClick={() => run("regenerate")}><Sparkles className="h-4 w-4" /> Новый сценарий</Button>}
        {["succeeded", "failed"].includes(job.status) && job.script && <Button size="sm" variant="secondary" onClick={() => confirm("Новый рендер спишет минуту рендера. Продолжить?") && run("rerender")}><Clapperboard className="h-4 w-4" /> Перерендер</Button>}
        {["queued", "running", "review", "paused", "blocked"].includes(job.status) && <Button size="sm" variant="destructive" onClick={() => run("cancel")}><Square className="h-4 w-4" /> Стоп</Button>}
      </div>
      {job.error && <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs">{job.error}</div>}

      <ol className="space-y-1">
        {STAGES.map((s, i) => {
          const done = job.status === "succeeded" || i < stageIdx;
          const cur = i === stageIdx && job.status !== "succeeded";
          return (
            <li key={s.key} className="flex items-center gap-2 text-xs">
              <span className={`h-2 w-2 rounded-full ${done ? "bg-primary" : cur ? (active ? "pulse-dot bg-info" : job.status === "failed" ? "bg-destructive" : "bg-warning") : "bg-muted"}`} />
              <span className={done || cur ? "text-foreground" : "text-muted-foreground"}>{s.label}</span>
            </li>
          );
        })}
      </ol>

      {job.plan && (
        <div className="space-y-2">
          <div className="label-xs">Сценарий озвучки</div>
          <Textarea value={script} onChange={(e) => setScript(e.target.value)} rows={5} className="text-xs" />
          <div className="label-xs">Подпись для TikTok</div>
          <Textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={3} className="text-xs" />
          <Button size="sm" variant="outline" onClick={save} disabled={script === (job.script ?? "") && caption === (job.caption ?? "")}>Сохранить правки</Button>
          {plan.clip_length && <p className="font-mono text-[11px] text-muted-foreground">Фрагмент: {Number(plan.clip_start).toFixed(1)}–{(Number(plan.clip_start) + Number(plan.clip_length)).toFixed(1)} с · {plan.selection_note}</p>}
        </div>
      )}
      {plan.claims?.length > 0 && (
        <div className="space-y-1.5">
          <div className="label-xs">Факты и источники</div>
          {plan.claims.map((c: any, i: number) => (
            <div key={i} className="rounded border border-border p-2 text-xs">
              <span className={c.status === "sourced" ? "text-primary" : "text-warning"}>{c.status === "sourced" ? "● источник" : "● проверить"}</span> {c.claim}
              {c.source_url && <a href={c.source_url} target="_blank" rel="noreferrer noopener" className="block truncate text-info underline">{c.source_url}</a>}
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground">Ссылки предложены ИИ без веб-поиска — проверьте перед публикацией.</p>
        </div>
      )}
      <div className="space-y-1">
        <div className="label-xs">Журнал</div>
        {events.map((e) => (
          <div key={e.id} className="flex gap-2 text-[11px]">
            <span className="shrink-0 font-mono text-muted-foreground">{new Date(e.created_at).toLocaleTimeString("ru")}</span>
            <span className={e.level === "error" ? "text-destructive" : e.level === "warn" ? "text-warning" : ""}>{e.message}{e.duration_ms ? ` · ${(e.duration_ms / 1000).toFixed(1)} с` : ""}</span>
          </div>
        ))}
      </div>
      <div className="rounded-md border border-border p-2 text-[11px] text-muted-foreground">Публикация в TikTok: <b>не подключено</b>. Скачайте MP4 и подпись.</div>
    </div>
  );
}
