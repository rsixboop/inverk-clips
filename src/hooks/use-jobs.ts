import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { tickJobs } from "@/lib/jobs.functions";
import { ACTIVE } from "@/lib/job-meta";
import type { Database } from "@/integrations/supabase/types";

export type Job = Database["public"]["Tables"]["jobs"]["Row"];
export type JobEvent = Database["public"]["Tables"]["job_events"]["Row"];
export type Source = Database["public"]["Tables"]["sources"]["Row"];

export function useJobs(enabled: boolean, drive = false) {
  const q = useQuery({
    queryKey: ["jobs"], enabled,
    queryFn: async () => {
      const { data, error } = await supabase.from("jobs").select("*").order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      return (data as Job[]).map(job => job.status === "completed" ? { ...job, status: "succeeded" } : job);
    },
  });
  // Drive the pipeline while something is active: ~5s, back off on error, stop when idle.
  const tick = useServerFn(tickJobs);
  const qc = useQueryClient();
  const delay = useRef(5000);
  const hasActive = (q.data ?? []).some((j) => ACTIVE.includes(j.status));
  useEffect(() => {
    if (!drive || !enabled || !hasActive) return;
    let stop = false; let t: ReturnType<typeof setTimeout>;
    const loop = async () => {
      try { await tick(); delay.current = 5000; } catch { delay.current = Math.min(60000, delay.current * 2); }
      if (stop) return;
      qc.invalidateQueries({ queryKey: ["jobs"] }); qc.invalidateQueries({ queryKey: ["events"] });
      t = setTimeout(loop, delay.current);
    };
    t = setTimeout(loop, 500);
    return () => { stop = true; clearTimeout(t); };
  }, [drive, enabled, hasActive, tick, qc]);
  return q;
}

export function useEvents(jobId: string | null) {
  return useQuery({
    queryKey: ["events", jobId], enabled: !!jobId,
    queryFn: async () => {
      const { data } = await supabase.from("job_events").select("*").eq("job_id", jobId!).order("id", { ascending: false }).limit(40);
      return (data ?? []) as JobEvent[];
    },
  });
}

export function useSources(enabled: boolean) {
  return useQuery({
    queryKey: ["sources"], enabled,
    queryFn: async () => {
      const { data } = await supabase.from("sources").select("*").order("created_at", { ascending: false });
      return (data ?? []) as Source[];
    },
  });
}
