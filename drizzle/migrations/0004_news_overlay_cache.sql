CREATE TABLE public.news_overlay_batches (user_id uuid NOT NULL, cache_key text NOT NULL, reserved_usd numeric NOT NULL DEFAULT 0, PRIMARY KEY(user_id,cache_key));
GRANT SELECT ON public.news_overlay_batches TO authenticated;
GRANT ALL ON public.news_overlay_batches TO service_role;
ALTER TABLE public.news_overlay_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_overlay_batches ON public.news_overlay_batches FOR SELECT TO authenticated USING (auth.uid()=user_id);
CREATE TABLE public.news_overlay_assets (user_id uuid NOT NULL, asset_key text NOT NULL, batch_key text NOT NULL, state jsonb NOT NULL DEFAULT '{}', phase text NOT NULL DEFAULT 'ready', claim uuid, PRIMARY KEY(user_id,asset_key));
GRANT SELECT ON public.news_overlay_assets TO authenticated;
GRANT ALL ON public.news_overlay_assets TO service_role;
ALTER TABLE public.news_overlay_assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_overlay_assets ON public.news_overlay_assets FOR SELECT TO authenticated USING (auth.uid()=user_id);
CREATE FUNCTION public.reserve_news_overlay(p_user uuid,p_batch text,p_asset text,p_state jsonb,p_cost numeric) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE amount numeric;
BEGIN
 IF p_cost < 0 OR p_cost > 1 THEN RAISE EXCEPTION 'Invalid reservation'; END IF;
 INSERT INTO public.news_overlay_batches(user_id,cache_key) VALUES(p_user,p_batch) ON CONFLICT DO NOTHING;
 SELECT reserved_usd INTO amount FROM public.news_overlay_batches WHERE user_id=p_user AND cache_key=p_batch FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.news_overlay_assets WHERE user_id=p_user AND asset_key=p_asset) THEN RETURN true; END IF;
 IF amount+p_cost>1 THEN RETURN false; END IF;
 INSERT INTO public.news_overlay_assets(user_id,asset_key,batch_key,state) VALUES(p_user,p_asset,p_batch,p_state);
 UPDATE public.news_overlay_batches SET reserved_usd=reserved_usd+p_cost WHERE user_id=p_user AND cache_key=p_batch;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.reserve_news_overlay(uuid,text,text,jsonb,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_news_overlay(uuid,text,text,jsonb,numeric) TO service_role;