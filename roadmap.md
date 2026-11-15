# Inverk Clips roadmap
- [x] Data model, auth, private storage, RLS
- [x] Compose route: web research, footage discovery (library + Pexels), grounded script, Shotstack render
- [x] Vizard route: content-aware clipping of YouTube / Twitch VOD / MP4 / upload
- [x] Background tick every 2 min (published app only), single-worker lease
- [ ] Replace active providers with fal.ai + Atlas Cloud + Tavily; preserve legacy history without paid replay
- [ ] Verify queue adapters, content-aware selection, vertical composition and captions with regression fixtures
- [ ] Live MP4 smoke test — blocked until FAL_KEY, ATLAS_CLOUD_API_KEY and TAVILY_API_KEY are configured
- [ ] TikTok publishing adapter — after first real render
