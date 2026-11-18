CREATE TABLE public.live_scene_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), monitor_id uuid NOT NULL REFERENCES public.live_monitors(id) ON DELETE CASCADE,
  user_id uuid NOT NULL, frame_at timestamptz NOT NULL, game text, activity text NOT NULL CHECK (activity IN ('gameplay','menu','chatting','unknown','unavailable')),
  confidence numeric, note text, switched_from text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (monitor_id, frame_at));
GRANT SELECT ON public.live_scene_checks TO authenticated;
GRANT ALL ON public.live_scene_checks TO service_role;
ALTER TABLE public.live_scene_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_scene_checks ON public.live_scene_checks FOR SELECT TO authenticated USING (auth.uid()=user_id);