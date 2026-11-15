import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell, StatusBadge } from "@/components/studio/AppShell";
import { JobDetails } from "@/components/studio/Studio";
import { useJobs } from "@/hooks/use-jobs";
import { stagesFor } from "@/lib/job-meta";

export const Route = createFileRoute("/queue")({
  head: () => ({ meta: [
    { title: "Очередь — Inverk Clips" }, { name: "description", content: "Все задачи рендера, их этапы и статусы." },
    { property: "og:title", content: "Очередь — Inverk Clips" }, { property: "og:description", content: "Задачи рендера и статусы." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: () => <AppShell>{() => <Queue />}</AppShell>,
});

function Queue() {
  const jobs = useJobs(true).data ?? [];
  const [sel, setSel] = useState<string | null>(null);
  const job = jobs.find((j) => j.id === sel);
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <div className="panel overflow-hidden">
        <div className="border-b border-border px-4 py-3"><h1 className="text-base font-bold">Очередь</h1></div>
        {!jobs.length && <p className="p-4 text-sm text-muted-foreground">Задач нет.</p>}
        {jobs.map((j) => (
          <button key={j.id} onClick={() => setSel(j.id)} className={`grid w-full grid-cols-[1fr_auto] gap-2 border-b border-border px-4 py-2.5 text-left text-sm hover:bg-accent ${sel === j.id ? "bg-accent" : ""}`}>
            <div className="min-w-0"><div className="truncate">{(j.plan as any)?.title ?? j.prompt}</div>
              <div className="font-mono text-[11px] text-muted-foreground">{stagesFor(j.route).find((s) => s.key === j.stage)?.label ?? "Готово"} · {j.workflow_version !== 2 ? "Старый провайдер" : j.route === "clip" ? "ИИ-нарезка" : "Сборка"} · {j.target_seconds} с · {j.language.toUpperCase()} · {new Date(j.created_at).toLocaleString("ru")}</div></div>
            <StatusBadge status={j.status} />
          </button>
        ))}
      </div>
      <div className="panel p-4">{job ? <JobDetails job={job} /> : <p className="text-sm text-muted-foreground">Выберите задачу.</p>}</div>
    </div>
  );
}
