CREATE TABLE public.live_monitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('youtube','twitch')), input text NOT NULL,
  channel_id text, channel_title text, live_video_id text, live_chat_id text,
  status text NOT NULL DEFAULT 'resolving', status_detail text,
  media_mode text NOT NULL DEFAULT 'timestamp_only' CHECK (media_mode IN ('timestamp_only','recorder','recording_url')),
  recording_url text, rights_confirmed boolean NOT NULL DEFAULT false,
  page_token text, next_poll_at timestamptz NOT NULL DEFAULT now(), last_poll_at timestamptz,
  stream_started_at timestamptz, stats jsonb NOT NULL DEFAULT '{}', lease uuid, lease_until timestamptz,
  messages_seen bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), stopped_at timestamptz);
GRANT SELECT, DELETE ON public.live_monitors TO authenticated;
GRANT ALL ON public.live_monitors TO service_role;
ALTER TABLE public.live_monitors ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_live_monitors_read ON public.live_monitors FOR SELECT TO authenticated USING (auth.uid()=user_id);
CREATE POLICY own_live_monitors_delete ON public.live_monitors FOR DELETE TO authenticated USING (auth.uid()=user_id);

CREATE TABLE public.live_highlights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), monitor_id uuid NOT NULL REFERENCES public.live_monitors(id) ON DELETE CASCADE,
  user_id uuid NOT NULL, start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, peak_at timestamptz NOT NULL,
  offset_s numeric, score numeric NOT NULL, chatters int NOT NULL, emotes int NOT NULL,
  status text NOT NULL DEFAULT 'timestamp_only', detail text, attempts int NOT NULL DEFAULT 0,
  claim uuid, claim_until timestamptz, job_id uuid, output_path text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (monitor_id, start_at));
GRANT SELECT ON public.live_highlights TO authenticated;
GRANT ALL ON public.live_highlights TO service_role;
ALTER TABLE public.live_highlights ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_live_highlights ON public.live_highlights FOR SELECT TO authenticated USING (auth.uid()=user_id);

CREATE TABLE public.live_workers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, token_hash text NOT NULL UNIQUE,
  label text NOT NULL DEFAULT 'recorder', last_seen_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT, DELETE ON public.live_workers TO authenticated;
GRANT ALL ON public.live_workers TO service_role;
ALTER TABLE public.live_workers ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_live_workers ON public.live_workers FOR SELECT TO authenticated USING (auth.uid()=user_id);
CREATE POLICY own_live_workers_del ON public.live_workers FOR DELETE TO authenticated USING (auth.uid()=user_id);
CREATE INDEX live_monitors_due ON public.live_monitors(next_poll_at) WHERE status NOT IN ('stopped');