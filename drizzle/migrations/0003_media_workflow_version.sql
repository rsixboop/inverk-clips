ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS workflow_version integer NOT NULL DEFAULT 1;
COMMENT ON COLUMN public.jobs.workflow_version IS '1: legacy provider history, never replay; 2: fal.ai and Atlas Cloud durable pipeline';
COMMENT ON COLUMN public.jobs.render_id IS 'Legacy render ID or last reconciliation ID; current requests are stored in plan.provider_tasks';