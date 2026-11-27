# Recorder reliability update — 27 November 2026

## Implemented

- Reused the existing enabled-channel polling and minute scheduler; no additional scheduled job. YouTube live status no longer depends on chat being enabled. Ended video URLs can resolve the channel's next broadcast. Twitch IRC messages no longer prove that a broadcast is live: a missing/failed Helix observation is unknown, not offline.
- Added independent enabled/archive state, platform observation/error/time, last confirmed live time, owner-wide pause/resume, and transactional deduplicated stream history. API failures back off; only confirmed offline observations end streams.
- Added server-executed owner-scoped Phil operations: `recorder.list`, `status`, `add`, `start`, `stop`, `archive`, `pause`, `resume`, `streams`, `clips`, `analysis` (each with `recorder.` prefix). Writes require UUID `request_key`; replay returns the stored outcome. List cursors are exclusive UUID IDs, limits 1–50. Clips support `source: live|local`.
- Recorder 2.5 separates monitoring/heartbeat and final-file analysis from rendering. Failed monitor API reads keep existing capture alive; unknown observations never start a new capture. Eligible capture requires an enabled, unarchived recorder monitor, explicit recording rights and recent confirmed live evidence. Global pause preserves each monitor's enabled state.
- Heartbeat diagnostics include capture state, latest segment time, reconnect time and safe error stage. Stale heartbeat never reports the historical buffer as ready. Latest successfully verified file is stored independently.
- Newly finalized recorder/tab/folder MP4s enqueue analysis once per job/output. The recorder downloads that exact private file, extracts mono WAV and eight timed JPEG frames with FFmpeg; the existing scheduler advances bounded fal Whisper transcription and the existing visual-description model. Timestamped words, description, provider ID, state/errors and analysis time persist. Mixed speech remains speaker-unknown unless visible subtitles corroborate attribution. No old-clip bulk backfill or generation, and no automatic replay of ambiguous paid submissions.
- Expired recorder claims can retry within existing attempt limits; exhausted claims fail without removing their records.

## Actual production evidence and limits

- Existing managed trigger `inverk-jobs-tick`: active, `* * * * *`, POST `/api/public/jobs/tick`, body `{}`. This is the existing 1,440 invocations/day, not a new schedule. Published `src/server.ts` authenticates and uses background continuation for job/live/analysis drains; the short development fallback does not launch slow analysis inference.
- VPS agent reported version **1.1**, fresh heartbeat **2026-11-27 21:52:21 UTC**, and `inverk-recorder.service` active/running. That is independent of the recorder API: last worker heartbeat **2026-11-20 13:55:56 UTC**, per-channel status **13:50:36 UTC**. Historical xQc error was Streamlink “No playable streams found”; it does not establish why all worker heartbeats stopped. Exact VPS hang/config cause requires local unit/log inspection and was not verified here.
- Current published polling still uses the previously deployed code until the app update is published; new observation columns initially remain unknown rather than being backfilled from unverified IRC status.
- No VPS files/services were changed remotely. No clip was published, no records were erased, no paid inference was run, and no new production analysis result is claimed.
- Authenticated end-to-end tests were skipped at your request; no temporary test account was created.

## External prerequisites and deployment

1. Publish the app update so the existing scheduled trigger executes the new polling and analysis code.
2. On the VPS, inspect the existing recorder unit's Python script path, user and config locally; do not share tokens or environment contents. Download `/recorder/recorder.py` from the published app, validate it with Python, replace only that existing recorder script and restart the recorder service. Preserve the existing URL/config/token and other studio/Buffer services. The separate `/vps/update.sh` updates the VPS agent only, **not** this recorder.
3. Recorder needs Python 3, Streamlink, FFmpeg, a valid `lrw_` recorder token and access to the configured owned/licensed streams. Noninteractive missing configuration now exits with a clear configuration error instead of waiting invisibly for input. VPS `vpa_` pairing is not a recorder credential.
4. YouTube requires the existing `YOUTUBE_API_KEY`; its API was polling the existing monitor. Confirmed Twitch auto-capture additionally requires the existing Twitch Helix connection (`TWITCH_API_KEY`/gateway setup); anonymous chat alone is deliberately unknown. No new integration was added.
5. Automated speech needs the existing `FAL_KEY`/balance; visuals need the existing Lovable AI access. Analysis is capped to files ≤180 seconds /120 MB, eight frames and one provider operation per scheduled tick; these calls can incur existing provider/AI charges after deployment.
6. Verify fresh **recorder 2.5** heartbeats, actual growing buffer/segment time, confirmed platform observation and a new verified MP4's persisted analysis. An active systemd service alone is insufficient.

## Changed source files

- `src/server/live.server.ts`, `live-worker.server.ts`, `local-folder.server.ts`, `src/server.ts`
- `src/server/recorder-control.server.ts`, `clip-analysis.server.ts`, `clip-description.server.ts`
- `src/lib/live.functions.ts`, `phil-api.server.ts`, `phil-operations.ts`, `recorder-policy.ts`
- `public/recorder/recorder.py`, `src/components/studio/LivePanel.tsx`
- Tests: `src/lib/recorder-policy.test.ts`, `src/server/live-poll.test.ts`, `recorder-control.test.ts`, `scripts/live-recorder/test_reliability.py`
- Database changes: `drizzle/migrations/0011_recorder_reliability.sql`, `0012_recorder_observation_guards.sql`, `0013_atomic_stream_observations.sql`; generated journal/snapshots and Cloud types.
- Task/architecture notes: `roadmap.md`, `src/server/AGENTS.md`, this report.

## Verification

- 169 application tests passed, including API live/offline/failure/chat-disabled fixtures, owner scoping, soft archive, rights and global pause.
- Recorder suite: 23 tests run, 22 passed and one environment-dependent test skipped; folder suite: four passed.
- Four new reliability fixtures passed, including real moving MP4 → WAV/eight timestamped frames and preservation of capture on monitor API failure; two claim-contract tests passed again.
- Live HTTP requests without credentials to Phil recorder status, recorder monitor listing and analysis claiming returned 401.
- Database additions and transactional observation function applied; existing records retained. No fresh production MP4/analysis or deployed Windows/VPS behavior was asserted.
