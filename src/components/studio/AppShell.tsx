import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { Clapperboard, ListOrdered, Library, Link2, Settings, LogOut } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { useJobs } from "@/hooks/use-jobs";

const NAV = [
  { to: "/", label: "Студия", icon: Clapperboard },
  { to: "/queue", label: "Очередь", icon: ListOrdered },
  { to: "/library", label: "Библиотека", icon: Library },
  { to: "/sources", label: "Источники", icon: Link2 },
  { to: "/settings", label: "Настройки", icon: Settings },
] as const;

export function AppShell({ children }: { children: (userId: string) => ReactNode }) {
  const { user, loading } = useAuth();
  const nav = useNavigate();
  useEffect(() => { if (!loading && !user) nav({ to: "/auth" }); }, [loading, user, nav]);
  useJobs(!!user, true); // keeps the pipeline ticking on every page while jobs are active
  if (loading || !user) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Загрузка…</div>;
  return (
    <div className="flex min-h-screen flex-col bg-background md:flex-row">
      <aside className="flex shrink-0 items-center gap-1 border-b border-sidebar-border bg-sidebar px-3 py-2 md:w-52 md:flex-col md:items-stretch md:border-b-0 md:border-r md:py-5">
        <div className="mb-0 mr-3 px-2 font-display text-sm font-bold text-sidebar-foreground md:mb-6 md:mr-0">
          INVERK<span className="text-primary">·</span>CLIPS
        </div>
        <nav className="flex flex-1 gap-1 overflow-x-auto md:flex-col">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} activeOptions={{ exact: true }}
              className="flex items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 py-2 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
              activeProps={{ className: "bg-sidebar-accent text-primary" }}>
              <n.icon className="h-4 w-4" /> <span className="hidden sm:inline">{n.label}</span>
            </Link>
          ))}
        </nav>
        <button onClick={() => supabase.auth.signOut()} className="flex items-center gap-2 rounded-md px-2.5 py-2 text-xs text-muted-foreground hover:text-foreground">
          <LogOut className="h-4 w-4" /> <span className="hidden md:inline truncate">{user.email}</span>
        </button>
      </aside>
      <main className="min-w-0 flex-1 p-3 md:p-5">{children(user.id)}</main>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone: Record<string, string> = {
    succeeded: "bg-primary/15 text-primary", running: "bg-info/15 text-info", queued: "bg-muted text-muted-foreground",
    review: "bg-warning/15 text-warning", paused: "bg-warning/15 text-warning", blocked: "bg-warning/15 text-warning",
    failed: "bg-destructive/15 text-destructive", cancelled: "bg-muted text-muted-foreground",
  };
  const labels: Record<string, string> = { queued: "В очереди", running: "В работе", review: "Ждёт проверки", paused: "Пауза", blocked: "Заблокировано", failed: "Ошибка", cancelled: "Отменено", succeeded: "Готово" };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium ${tone[status] ?? "bg-muted"}`}>
      {status === "running" && <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-info" />}
      {labels[status] ?? status}
    </span>
  );
}
