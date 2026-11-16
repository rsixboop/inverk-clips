<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

## Inverk Clips architecture
- Video jobs advance one stage per call in `src/server/pipeline.server.ts` under a fenced lease (`lease_token`): every job write requires the token and a live status, and cancel/pause clear the token, so stale or cancelled work is discarded. Driven by UI polling (`tickJobs`, one stage/request), cron and the signed webhook.
- Internal job/source/event fields are written only by server code through the service client with explicit `user_id` scoping (column-level grants keep users to script/caption and source title/rights); keeps RLS clients from forging plan/provider state.
- Version jobs explicitly: workflow_version=2 uses compose or clip routes and per-operation plan.provider_tasks with durable fal/Atlas IDs and submission barriers; legacy version 1 is read-only history without paid replay, preserving output files. This prevents accidental migration charges.
- Each queued provider operation submits or polls in a bounded request; completed results are persisted before the next stage and unknown outcomes require explicit confirmed replay, preventing duplicate charges.
- fal-ai/ffmpeg-api/* is access-denied (403) for this fal account, so no route may depend on it; `submitTask` preflights every endpoint of the job's route (`ROUTE_ENDPOINTS`, empty-body probe, bounded cache) and blocks before any paid call when one is denied. Compose/clip still use ffmpeg-api and are therefore blocked until moved to the story renderer path.
- Compose uses permitted library footage or explicitly requested non-documentary illustrations; clip selects bounded transcript moments with available boundary-frame analysis, then verified fal processing operations. Web research is never treated as licensed media.
- A managed cron (`/api/public/jobs/tick`, every minute) advances jobs when no tab is open: `src/server.ts` acknowledges it and drains due jobs in `ctx.waitUntil` (~30s cap, `src/server/drain.server.ts`); stages whose AI call outlasts that (story_plan) are foreground-only via tickJobs; it only reaches the published app, so pipeline changes need a publish.
- Story route (`route=story`, `src/server/story.server.ts` + pure rules in `story-plan.ts`): plan candidates → deterministic plan validator/repair before paid calls → narrator TTS measured first → reference-grounded frames and image-to-video shots with vision QC and one bounded retry each → in-Worker narrator-first mix (`src/lib/wav.ts`, because fal compose has no gain control) → end frames via workflow-utilities/extract-nth-frame (duration read in-Worker) → each shot scaled by workflow-utilities/scale-video → in-Worker remux (`src/lib/mp4-mux.ts`, H.264 samples + PCM, no re-encode) → shared scale (PCM→AAC)/captions/finalize; per-job `plan.budget_usd` is enforced at every paid submit barrier. Calibration is versioned in `STORY_CALIBRATION`; viewer feedback is stored per user in `provider_configs` (provider `story_feedback`) and fed into new plans.
- All external URLs pass `src/lib/url-guard.ts` (https, public DNS, HEAD-only, size cap); provider outputs are downloaded via `src/lib/output-fetch.ts` (host allowlist, per-hop checks, streamed cap) and verified by `src/lib/mp4-inspect.ts`; YouTube/Twitch and channels remain reference-only until a documented permitted ingestion method is verified; users supply owned/licensed files instead.
- Provider errors are classified in `src/lib/providers/http.ts` (validation/no_media/auth/credits/rate/network) with sanitized details stored in plan.provider_errors; a fal `no_media_generated` result marks the task failed and uses the asset's single retry under a new key with a compact prompt, so the user sees the real cause instead of a balance hint.
