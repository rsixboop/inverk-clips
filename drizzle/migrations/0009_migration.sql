alter table public.live_highlights add column if not exists trigger text not null default 'chat', add column if not exists reason text;
alter table public.live_monitors add column if not exists event_state jsonb not null default '{}'::jsonb;
grant select (trigger, reason) on public.live_highlights to authenticated;