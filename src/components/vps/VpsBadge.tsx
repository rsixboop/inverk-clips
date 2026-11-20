import { Link } from "@tanstack/react-router";
import { agentState, failedServices, type ServiceInfo } from "@/lib/vps-ops";
import { useVpsAgent } from "./useVps";

const L = { online: "VPS онлайн", stale: "VPS нет связи", never: "VPS не подключён", revoked: "VPS отозван" } as const;
const T = { online: "bg-primary/15 text-primary", stale: "bg-warning/15 text-warning", never: "bg-muted text-muted-foreground", revoked: "bg-muted text-muted-foreground" } as const;

export function VpsBadge() {
  const a = useVpsAgent().data;
  const s = agentState(a);
  const failed = a ? failedServices(a.services as Record<string, ServiceInfo>) : [];
  return (
    <Link to="/control" className="flex flex-wrap items-center gap-1 px-2 py-1 text-[11px]">
      <span className={`rounded px-1.5 py-0.5 font-medium ${T[s]}`}>{L[s]}</span>
      {failed.length > 0 && <span className="rounded bg-destructive/15 px-1.5 py-0.5 font-medium text-destructive">сбой служб: {failed.length}</span>}
    </Link>
  );
}
