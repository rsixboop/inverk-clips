# Welcome to your Lovable project

## Inverk Clips media migration

- Active integrations: Tavily factual research, Lovable AI planning/selection, fal.ai queued Whisper/metadata/trim/compose/scale/subtitle operations, Atlas Cloud asynchronous Gemini Flash TTS and explicitly requested illustrated stills.
- Server secrets: `FAL_KEY`, `ATLAS_CLOUD_API_KEY`, `TAVILY_API_KEY`. No secret values are accepted by the app UI or committed to source.
- Jobs at workflow version 1 retain historical output files; they cannot automatically resume or replay paid legacy requests. New jobs use version 2 and per-operation persisted IDs/barriers in `plan.provider_tasks`.
- YouTube/Twitch links are references only; no verified subscription-free permitted ingestion is implemented. Supply an owned/licensed upload or direct media URL.
- Real GTA footage must come from a permitted source. Search results are research provenance, not a downloadable-media licence. Generated stills are opt-in illustrations, never authentic game footage.
- Clip selection uses timestamped speech plus available first/last frame analysis, not full scene tracking; crop is centered. Caption language selects transcription language, not translation of original speech.
- Current verified schemas do not offer explicit FPS or audio-normalization controls in this processing chain. H.264, 1080×1920, AAC and positive duration are checked before success, but 30 FPS and loudness normalization are not guaranteed. Replacing source audio during compose requires a live test; no live provider output has been verified yet.
- Private preview advances only while open; existing two-minute scheduler reaches the published app only. Publishing/visibility and TikTok posting are unchanged.
- Regression fixtures are not live end-to-end evidence. Real playback, burned subtitles, audio mix and download checks require provider keys and a usable signed-in session.
- Official schemas: https://docs.fal.ai/model-apis/model-endpoints/queue ; https://fal.ai/models/fal-ai/whisper/api ; https://fal.ai/models/fal-ai/ffmpeg-api/compose/api ; https://fal.ai/models/fal-ai/workflow-utilities/trim-video/api ; https://fal.ai/models/fal-ai/workflow-utilities/scale-video/api ; https://fal.ai/models/fal-ai/workflow-utilities/auto-subtitle/api ; https://www.atlascloud.ai/docs/openapi-index.md ; https://www.atlascloud.ai/docs/predictions.md .

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Open your project in the [Lovable editor](https://lovable.dev) and keep building.

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: connect the project to GitHub and every change made in Lovable is committed straight to your repository.
- **Full ownership**: this code is yours. Push to your repository and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

## Built with

- TanStack Start
- TypeScript
- React
- Tailwind CSS
