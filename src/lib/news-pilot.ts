// "GTA VI: 30 FPS?" pilot. Every claim quotes the official Rockstar Newswire article; no invented scenes.
import type { OverlayCue } from "./news-overlays";
import type { OverlayIntent, SpeechWord } from "./news-overlay-plan";
export const NEWS_SOURCE = "https://www.rockstargames.com/newswire/article/89834o94713o21/pre-load-grand-theft-auto-vi-now";
export const MEDIA_LIBRARY = "https://www.rockstargames.com/VI/media";
export type Shot = { text: string; seconds: number; material: string; caption?: string; fact?: string; brief?: string; role?: "evidence" | "illustration"; overlay_cues?: OverlayCue[]; overlay_intents?: OverlayIntent[]; speech_words?: SpeechWord[] };
export const PILOT: Shot[] = [
  { text: "GTA VI at 30 FPS — even on PS5 Pro?", seconds: 4, material: "Official GTA VI key art or a trailer still (Rockstar media library)" },
  { text: "Rockstar confirmed it: GTA VI targets thirty frames per second on consoles.", seconds: 6, material: "Official screenshot of Leonida (wide city or coast view)" },
  { text: "PS5 Pro gets sharper visuals and ray-traced shadows — but no sixty-FPS promise.", seconds: 6, material: "Official screenshot with strong sunlight and shadows" },
  { text: "Would you trade sixty FPS for those visuals?", seconds: 5, material: "Official logo / key art, or a screenshot of the Newswire article" },
];
export const totalSeconds = (s: Shot[]) => s.reduce((a, x) => a + x.seconds, 0);
export const pilotValid = (s: Shot[]) => s.length === 4 && totalSeconds(s) >= 18 && totalSeconds(s) <= 23;
