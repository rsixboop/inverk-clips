ALTER TABLE public.live_monitors ADD COLUMN IF NOT EXISTS recorder_state jsonb;
GRANT SELECT (recorder_state) ON public.live_monitors TO authenticated;