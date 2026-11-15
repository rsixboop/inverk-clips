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
- Video jobs advance one stage per call in `src/server/pipeline.server.ts` under a DB lease (`lock_until`), driven by UI polling (`tickJobs`) and the signed Shotstack webhook; never run multi-minute provider work inside one request.
- Jobs have a `route`: `compose` (Tavily research → library+Pexels discovery → grounded script → Shotstack render) or `vizard` (Vizard content-aware clipping, no Shotstack). Provider adapters live in `src/lib/providers/`; paid submissions claim `render_attempt` atomically and never auto-retry ambiguous network failures.
- A managed cron (`/api/public/jobs/tick`, every 2 min) advances jobs when no tab is open; it only reaches the published app.
- All external URLs pass `src/lib/url-guard.ts` (https, public DNS, HEAD-only, size cap); YouTube/Twitch VOD links are only passed to Vizard's official API; the app never downloads them; channels are references only.
