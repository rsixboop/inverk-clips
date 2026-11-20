import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export function useVpsAgent() {
  return useQuery({ queryKey: ["vps-agent"], refetchInterval: 15000, queryFn: async () => {
    const { data } = await supabase.from("vps_agents").select("id,name,paired_at,last_seen_at,last_server_ts,agent_version,services,info,revoked_at").is("revoked_at", null).order("paired_at", { ascending: false }).limit(1);
    return data?.[0] ?? null;
  } });
}
