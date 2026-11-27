ALTER TABLE public.live_monitors ADD COLUMN confirmed_live_at timestamptz, ADD COLUMN latest_file jsonb;
UPDATE public.live_monitors m SET latest_file=jsonb_build_object('id',h.id,'job_id',h.job_id,'output_path',h.output_path,'updated_at',h.updated_at) FROM (SELECT DISTINCT ON(monitor_id) monitor_id,id,job_id,output_path,updated_at FROM public.live_highlights WHERE status='done' AND output_path IS NOT NULL ORDER BY monitor_id,updated_at DESC) h WHERE h.monitor_id=m.id;
ALTER POLICY own_recorder_controls ON public.recorder_controls USING (user_id=(select auth.uid()));
ALTER POLICY own_live_streams ON public.live_streams USING (user_id=(select auth.uid()));
ALTER POLICY own_clip_analysis ON public.clip_analysis USING (user_id=(select auth.uid()));
CREATE INDEX clip_analysis_owner_created ON public.clip_analysis(user_id,created_at DESC);
CREATE INDEX clip_analysis_job ON public.clip_analysis(job_id);
CREATE INDEX live_streams_monitor ON public.live_streams(monitor_id);