CREATE OR REPLACE FUNCTION public.record_stream_observation(p_monitor uuid,p_at timestamptz) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE m public.live_monitors%ROWTYPE; k text; s timestamptz;
BEGIN
 SELECT * INTO m FROM public.live_monitors WHERE id=p_monitor FOR UPDATE;
 IF NOT FOUND OR NOT m.enabled OR m.archived_at IS NOT NULL OR m.observed_at IS DISTINCT FROM p_at OR EXISTS(SELECT 1 FROM public.recorder_controls WHERE user_id=m.user_id AND paused) THEN RETURN; END IF;
 IF m.observation='offline' THEN
   UPDATE public.live_streams SET ended_at=p_at,last_observed_at=p_at WHERE monitor_id=m.id AND user_id=m.user_id AND ended_at IS NULL;
 ELSIF m.observation='live' THEN
   s=coalesce(m.stream_started_at,p_at); k=coalesce(m.live_video_id,s::text);
   UPDATE public.live_streams SET ended_at=p_at WHERE monitor_id=m.id AND user_id=m.user_id AND stream_key<>k AND ended_at IS NULL;
   INSERT INTO public.live_streams(user_id,monitor_id,stream_key,started_at,last_observed_at) VALUES(m.user_id,m.id,k,s,p_at) ON CONFLICT(monitor_id,stream_key) DO UPDATE SET last_observed_at=excluded.last_observed_at;
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.record_stream_observation(uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_stream_observation(uuid,timestamptz) TO service_role;