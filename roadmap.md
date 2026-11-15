# Inverk Clips roadmap
- [x] Data model, auth, private storage, RLS
- [x] Compose: grounded Tavily research, permitted library media, queued Atlas TTS and fal assembly
- [x] Clip: uploaded/direct media, timed transcription, candidate moments and queued vertical processing
- [x] Background tick every 2 min (published app only), single-worker lease
- [x] Replace active providers with fal.ai + Atlas Cloud + Tavily; preserve legacy history without paid replay
- [x] Verify queue adapters, content-aware selection, vertical composition and captions with regression fixtures
- [ ] Live MP4 smoke test — blocked until FAL_KEY, ATLAS_CLOUD_API_KEY and TAVILY_API_KEY are configured
- [ ] Signed-in UI and live playback/download checks — blocked: no test-user approval or existing account for requester
