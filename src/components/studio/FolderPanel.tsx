import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { candidateUrl } from "@/lib/live.functions";

const FS: Record<string, string> = { writing: "пишется", checking: "проверка", ready: "готов", invalid: "не завершён" };
const CS: Record<string, string> = { transcribing: "распознаётся речь", rendering: "рендер", done: "готов", failed: "ошибка" };
const dur = (s: number | null) => (s == null ? "—" : `${Math.floor(Number(s) / 60)}:${String(Math.floor(Number(s) % 60)).padStart(2, "0")}`);

/** Folder import: local StreamClips recordings reported by the user's recorder, and reviewable candidates. */
export function FolderPanel() {
  const qc = useQueryClient(); const url = useServerFn(candidateUrl); const [play, setPlay] = useState<Record<string, string>>({});
  const files = useQuery({ queryKey: ["local-footage"], queryFn: async () => (await supabase.from("local_footage").select("*").order("rel_path", { ascending: false }).limit(1000)).data ?? [], refetchInterval: 10000 }).data ?? [];
  const cands = useQuery({ queryKey: ["local-candidates"], queryFn: async () => (await supabase.from("local_candidates").select("*").order("created_at", { ascending: false }).limit(20)).data ?? [], refetchInterval: 5000 }).data ?? [];
  const channels = [...new Set(files.map((f) => f.channel))].sort();
  async function review(id: string, review: "ok" | "next" | "reject") {
    const { error } = await supabase.from("local_candidates").update({ review }).eq("id", id);
    if (error) toast.error(error.message); else qc.invalidateQueries({ queryKey: ["local-candidates"] });
  }
  return (
    <div className="panel overflow-hidden">
      <div className="border-b border-border px-4 py-3"><h2 className="text-base font-bold">Папка записей · StreamClips</h2>
        <p className="text-xs text-muted-foreground">Рекордер только читает готовые файлы из %USERPROFILE%\Videos\StreamClips\&lt;канал&gt;\&lt;дата-время&gt;\clip_NNNN.mp4 — ваши записи он не трогает. Делается один кандидат; следующий — только после вашей оценки.</p></div>
      {!channels.length && <p className="px-4 py-3 text-xs text-muted-foreground">Файлов пока нет: запустите рекордер (inverk-recorder.bat) — папка подхватится сама.</p>}
      {cands.map((c) => {
        const segs = (c.segments as { file: string; from_s: number; to_s: number }[]) ?? [];
        return (
          <div key={c.id} className="border-b border-border px-4 py-3 text-xs">
            <div className="flex flex-wrap items-center gap-2"><b>Кандидат · {c.channel}</b><span className="text-primary">{CS[c.status] ?? c.status}</span>{c.review && <span className="text-muted-foreground">оценка: {c.review === "ok" ? "хорошо" : c.review === "next" ? "нужен следующий" : "отклонён"}</span>}</div>
            <div className="font-mono text-[11px] text-muted-foreground">{segs.map((s) => `${s.file} ${s.from_s.toFixed(1)}–${s.to_s.toFixed(1)} с`).join(" + ")}</div>
            {c.reason && <div className="text-muted-foreground">почему: {c.reason}</div>}
            {(c.caption_note || c.detail) && <div className={c.status === "failed" ? "text-warning" : "text-muted-foreground"}>{[c.caption_note, c.detail].filter(Boolean).join(" · ")}</div>}
            {c.status === "done" && <div className="mt-1 flex flex-wrap items-center gap-2">
              {play[c.id] ? <video src={play[c.id]} controls className="h-80 rounded bg-muted" /> : <button onClick={async () => { try { const u = (await url({ data: { id: c.id } })).url; setPlay((p) => ({ ...p, [c.id]: u })); } catch (e) { toast.error((e as Error).message); } }} className="rounded border border-border px-2">Смотреть</button>}
              {!c.review && <><button onClick={() => review(c.id, "ok")} className="rounded border border-border px-2">Хорошо</button>
                <button onClick={() => review(c.id, "next")} className="rounded bg-primary px-2 text-primary-foreground">Следующий кандидат</button>
                <button onClick={() => review(c.id, "reject")} className="rounded border border-border px-2">Отклонить и следующий</button></>}
            </div>}
          </div>);
      })}
      {channels.map((ch) => {
        const list = files.filter((f) => f.channel === ch); const ready = list.filter((f) => f.status === "ready");
        return (
          <details key={ch} className="border-b border-border px-4 py-2 text-xs">
            <summary className="cursor-pointer"><b>{ch}</b> <span className="text-muted-foreground">· файлов {list.length}, готовы {ready.length}, всего {dur(ready.reduce((t, f) => t + Number(f.duration_s ?? 0), 0))} · время {ready.length && ready.every((f) => f.aligned) ? "сверено" : "не сверено"}</span></summary>
            {list.slice(0, 40).map((f) => (
              <div key={f.id} className="flex gap-2 font-mono text-[11px]"><span>{f.session}/{f.file_name}</span><span>{dur(f.duration_s)}</span>
                <span className={f.status === "ready" ? "text-primary" : f.status === "invalid" ? "text-warning" : "text-muted-foreground"}>{FS[f.status] ?? f.status}</span>
                <span className="text-muted-foreground">{f.aligned ? "время ✓" : ""}{f.detail ? ` ${f.detail}` : ""}</span></div>))}
          </details>);
      })}
    </div>
  );
}
