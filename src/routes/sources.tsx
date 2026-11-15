import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AppShell } from "@/components/studio/AppShell";
import { useSources } from "@/hooks/use-jobs";
import { supabase } from "@/integrations/supabase/client";
import { PERMISSIONS } from "@/lib/job-meta";

export const Route = createFileRoute("/sources")({
  head: () => ({ meta: [
    { title: "Источники — Inverk Clips" }, { name: "description", content: "Футаж, ссылки и права на использование." },
    { property: "og:title", content: "Источники — Inverk Clips" }, { property: "og:description", content: "Футаж и права на использование." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: () => <AppShell>{() => <Sources />}</AppShell>,
});

const KIND: Record<string, string> = { upload: "Загруженный файл", direct_url: "Прямой MP4", youtube: "YouTube (нужен файл)", twitch: "Twitch (нужен файл)", stock: "Сохранённый сток", channel: "Канал", research_link: "Ссылка-источник" };

function Sources() {
  const qc = useQueryClient();
  const list = useSources(true).data ?? [];
  async function setPerm(id: string, permission: string) {
    const { error } = await supabase.from("sources").update({ permission }).eq("id", id);
    if (error) toast.error(error.message); else qc.invalidateQueries({ queryKey: ["sources"] });
  }
  return (
    <div className="panel overflow-hidden">
      <div className="border-b border-border px-4 py-3"><h1 className="text-base font-bold">Источники</h1>
        <p className="text-xs text-muted-foreground">Используйте только своё видео или материалы с лицензией/разрешением. Источник без указанных прав блокирует рендер.</p></div>
      {!list.length && <p className="p-4 text-sm text-muted-foreground">Источников нет — добавьте их в Студии.</p>}
      {list.map((s) => (
        <div key={s.id} className="grid gap-2 border-b border-border px-4 py-3 text-sm md:grid-cols-[1fr_160px]">
          <div className="flex min-w-0 gap-2">{s.preview_url && <img src={s.preview_url} alt="" className="h-12 w-8 shrink-0 rounded object-cover" />}<div className="min-w-0">
            <div className="truncate">{s.title || s.url}</div>
            <div className="font-mono text-[11px] text-muted-foreground">{KIND[s.kind]} · {s.duration_s ? `${Number(s.duration_s).toFixed(1)} с · ` : ""}{s.bytes ? `${(s.bytes / 1048576).toFixed(1)} МБ` : ""}</div>
            {(s.license || s.attribution) && <div className="text-[11px] text-muted-foreground">{s.license}{s.attribution ? ` · ${s.attribution}` : ""}</div>}
            {s.status_note && <div className="text-xs text-warning">{s.status_note}</div>}
          </div></div>
          <select value={s.permission} onChange={(e) => setPerm(s.id, e.target.value)} className="h-8 rounded-md border border-input bg-muted px-2 text-xs">
            {PERMISSIONS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </div>
      ))}
    </div>
  );
}
