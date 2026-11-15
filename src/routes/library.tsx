import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Download, Copy } from "lucide-react";
import { AppShell } from "@/components/studio/AppShell";
import { useOutputUrl } from "@/components/studio/useOutputUrl";
import { Button } from "@/components/ui/button";
import { useJobs, type Job } from "@/hooks/use-jobs";
import { getOutputUrl } from "@/lib/jobs.functions";

export const Route = createFileRoute("/library")({
  head: () => ({ meta: [
    { title: "Библиотека — Inverk Clips" }, { name: "description", content: "Готовые MP4 и подписи для TikTok." },
    { property: "og:title", content: "Библиотека — Inverk Clips" }, { property: "og:description", content: "Готовые MP4 и подписи." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: () => <AppShell>{() => <Library />}</AppShell>,
});

function Library() {
  const done = (useJobs(true).data ?? []).filter((j) => j.status === "succeeded");
  return (
    <div className="space-y-4">
      <h1 className="text-base font-bold">Библиотека</h1>
      {!done.length && <p className="text-sm text-muted-foreground">Готовых роликов пока нет.</p>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">{done.map((j) => <Card key={j.id} job={j} />)}</div>
    </div>
  );
}
function Card({ job }: { job: Job }) {
  const url = useOutputUrl(job.id, false);
  const dl = useServerFn(getOutputUrl);
  return (
    <div className="panel overflow-hidden">
      <div className="aspect-[9/16] bg-sidebar">{url && <video src={url} controls playsInline preload="metadata" className="h-full w-full object-contain" />}</div>
      <div className="space-y-2 p-3">
        <div className="truncate text-sm font-medium">{(job.plan as any)?.title}</div>
        <div className="font-mono text-[11px] text-muted-foreground">{((job.output_bytes ?? 0) / 1048576).toFixed(1)} МБ · {job.output_mime} · TikTok: не подключено</div>
        <div className="flex gap-1.5">
          <Button size="sm" onClick={async () => { window.location.href = (await dl({ data: { jobId: job.id, download: true } })).url; }}><Download className="h-4 w-4" /> MP4</Button>
          <Button size="sm" variant="secondary" onClick={() => { navigator.clipboard.writeText(job.caption ?? ""); toast.success("Подпись скопирована"); }}><Copy className="h-4 w-4" /> Подпись</Button>
        </div>
      </div>
    </div>
  );
}
