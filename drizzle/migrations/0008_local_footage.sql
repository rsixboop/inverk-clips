CREATE TABLE public.local_footage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  channel text NOT NULL,
  rel_path text NOT NULL,
  session text NOT NULL,
  file_name text NOT NULL,
  size_bytes bigint,
  duration_s numeric,
  start_at timestamptz,
  aligned boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  detail text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, rel_path)
);
GRANT SELECT ON public.local_footage TO authenticated;
GRANT ALL ON public.local_footage TO service_role;
ALTER TABLE public.local_footage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own footage readable" ON public.local_footage FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE TABLE public.local_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  channel text NOT NULL,
  status text NOT NULL,
  segments jsonb NOT NULL,
  window_info jsonb NOT NULL DEFAULT '{}'::jsonb,
  score numeric,
  reason text,
  captions jsonb,
  caption_note text,
  whisper_request text,
  output_path text,
  job_id uuid,
  review text,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.local_candidates TO authenticated;
GRANT UPDATE (review) ON public.local_candidates TO authenticated;
GRANT ALL ON public.local_candidates TO service_role;
ALTER TABLE public.local_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own candidates readable" ON public.local_candidates FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "own candidates review" ON public.local_candidates FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid() AND review IN ('ok','next','reject'));
CREATE INDEX ON public.local_footage (user_id, channel);
CREATE INDEX ON public.local_candidates (user_id, created_at DESC);