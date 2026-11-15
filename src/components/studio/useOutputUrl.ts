import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getOutputUrl } from "@/lib/jobs.functions";

export function useOutputUrl(jobId: string | null, download: boolean) {
  const fn = useServerFn(getOutputUrl);
  return useQuery({ queryKey: ["out", jobId, download], enabled: !!jobId, staleTime: 50 * 60e3, queryFn: async () => {
    if (!jobId) return null;
    return (await fn({ data: { jobId, download } })).url;
  } }).data ?? null;
}
