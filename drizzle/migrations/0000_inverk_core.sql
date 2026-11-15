
CREATE TABLE public.niches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL DEFAULT auth.uid(), name text NOT NULL, description text NOT NULL DEFAULT '', default_language text NOT NULL DEFAULT 'en', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.sources (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL DEFAULT auth.uid(), kind text NOT NULL CHECK (kind IN ('upload','direct_url','youtube','twitch','channel','research_link')), url text, storage_path text, title text NOT NULL DEFAULT '', mime text, bytes bigint, duration_s numeric, permission text NOT NULL DEFAULT 'unknown' CHECK (permission IN ('owned','licensed','permitted','unknown')), permission_note text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'ready', status_note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.social_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL DEFAULT auth.uid(), platform text NOT NULL DEFAULT 'tiktok', handle text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'not_connected', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL DEFAULT auth.uid(),
  idempotency_key text NOT NULL, mode text NOT NULL CHECK (mode IN ('niche','link','mixed')),
  prompt text NOT NULL DEFAULT '', language text NOT NULL DEFAULT 'en', target_seconds int NOT NULL DEFAULT 40 CHECK (target_seconds BETWEEN 10 AND 90),
  audio_mode text NOT NULL DEFAULT 'voiceover' CHECK (audio_mode IN ('voiceover','original')),
  review_before_render boolean NOT NULL DEFAULT false,
  niche_id uuid REFERENCES public.niches(id) ON DELETE SET NULL, source_id uuid REFERENCES public.sources(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued', stage text NOT NULL DEFAULT 'validate', failed_stage text,
  plan jsonb, script text, caption text, error text,
  render_id text, render_attempt int NOT NULL DEFAULT 0, attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), lock_until timestamptz,
  output_path text, output_mime text, output_bytes bigint, output_url_expires timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE (user_id, idempotency_key));
CREATE TABLE public.job_events (id bigserial PRIMARY KEY, job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE, user_id uuid NOT NULL DEFAULT auth.uid(), stage text NOT NULL, level text NOT NULL DEFAULT 'info', message text NOT NULL, duration_ms int, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.posting_queue (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL DEFAULT auth.uid(), job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE, account_id uuid REFERENCES public.social_accounts(id) ON DELETE SET NULL, status text NOT NULL DEFAULT 'not_connected', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(job_id, account_id));
CREATE TABLE public.provider_configs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL DEFAULT auth.uid(), provider text NOT NULL, settings jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id, provider));
CREATE INDEX jobs_user_status ON public.jobs(user_id, status);
CREATE INDEX job_events_job ON public.job_events(job_id, id);

DO $$ DECLARE t text; BEGIN
FOREACH t IN ARRAY ARRAY['niches','sources','social_accounts','jobs','job_events','posting_queue','provider_configs'] LOOP
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
  EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY "own rows" ON public.%I FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())', t);
END LOOP; END $$;
GRANT USAGE ON SEQUENCE public.job_events_id_seq TO authenticated, service_role;

CREATE POLICY "own footage/outputs read" ON storage.objects FOR SELECT TO authenticated USING (bucket_id IN ('footage','outputs') AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "own footage/outputs insert" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id IN ('footage','outputs') AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "own footage/outputs update" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id IN ('footage','outputs') AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "own footage/outputs delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id IN ('footage','outputs') AND (storage.foldername(name))[1] = auth.uid()::text);
