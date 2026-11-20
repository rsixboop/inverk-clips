CREATE TABLE public.vps_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, name text NOT NULL DEFAULT 'vps',
  token_hash text NOT NULL UNIQUE, paired_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz,
  last_server_ts timestamptz, agent_version text, services jsonb NOT NULL DEFAULT '{}'::jsonb, info jsonb NOT NULL DEFAULT '{}'::jsonb, revoked_at timestamptz);
CREATE TABLE public.vps_pairings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, code_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.vps_mirror (
  agent_id uuid NOT NULL REFERENCES public.vps_agents(id) ON DELETE CASCADE, user_id uuid NOT NULL, kind text NOT NULL, row_key text NOT NULL,
  data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (agent_id, kind, row_key));
CREATE TABLE public.vps_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, agent_id uuid NOT NULL REFERENCES public.vps_agents(id) ON DELETE CASCADE,
  op text NOT NULL, args jsonb NOT NULL DEFAULT '{}'::jsonb, idem_key text NOT NULL, status text NOT NULL DEFAULT 'pending',
  result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, done_at timestamptz,
  UNIQUE (user_id, idem_key));
CREATE INDEX vps_commands_agent_idx ON public.vps_commands(agent_id, status, created_at);
GRANT SELECT ON public.vps_agents, public.vps_mirror, public.vps_commands TO authenticated;
GRANT ALL ON public.vps_agents, public.vps_pairings, public.vps_mirror, public.vps_commands TO service_role;
ALTER TABLE public.vps_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vps_pairings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vps_mirror ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vps_commands ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own agents" ON public.vps_agents FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "own mirror" ON public.vps_mirror FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "own commands" ON public.vps_commands FOR SELECT TO authenticated USING (user_id = auth.uid());
REVOKE SELECT ON public.vps_agents FROM authenticated;
GRANT SELECT (id, user_id, name, paired_at, last_seen_at, last_server_ts, agent_version, services, info, revoked_at) ON public.vps_agents TO authenticated;