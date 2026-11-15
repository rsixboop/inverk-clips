ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS lease_token uuid, ADD COLUMN IF NOT EXISTS submit_state text, ADD COLUMN IF NOT EXISTS deadline_at timestamptz NOT NULL DEFAULT (now() + interval '3 hours');

REVOKE INSERT, UPDATE ON public.jobs FROM authenticated;
GRANT INSERT (user_id, idempotency_key, mode, prompt, language, target_seconds, audio_mode, review_before_render, approve_sources, route, niche_id, source_id) ON public.jobs TO authenticated;
GRANT UPDATE (script, caption) ON public.jobs TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON public.job_events FROM authenticated;

REVOKE INSERT, UPDATE ON public.sources FROM authenticated;
GRANT INSERT (user_id, kind, storage_path, title, mime, bytes, permission, permission_note) ON public.sources TO authenticated;
GRANT UPDATE (title, permission, permission_note) ON public.sources TO authenticated;
DROP POLICY IF EXISTS "own rows" ON public.sources;
CREATE POLICY "own select" ON public.sources FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "own delete" ON public.sources FOR DELETE TO authenticated USING (user_id = auth.uid());
CREATE POLICY "own update" ON public.sources FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "own upload insert" ON public.sources FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid() AND kind = 'upload' AND storage_path LIKE auth.uid()::text || '/%');

DROP POLICY IF EXISTS "own footage/outputs insert" ON storage.objects;
DROP POLICY IF EXISTS "own footage/outputs update" ON storage.objects;
DROP POLICY IF EXISTS "own footage/outputs delete" ON storage.objects;
CREATE POLICY "own footage insert" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'footage' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "own footage delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'footage' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE OR REPLACE FUNCTION public.jobs_check_ownership() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.source_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sources WHERE id = NEW.source_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'source does not belong to job owner';
  END IF;
  IF NEW.niche_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.niches WHERE id = NEW.niche_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'niche does not belong to job owner';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS jobs_check_ownership ON public.jobs;
CREATE TRIGGER jobs_check_ownership BEFORE INSERT OR UPDATE OF source_id, niche_id, user_id ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.jobs_check_ownership();
REVOKE EXECUTE ON FUNCTION public.jobs_check_ownership() FROM PUBLIC, anon, authenticated;