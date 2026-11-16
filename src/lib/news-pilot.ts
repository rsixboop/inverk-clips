// "GTA VI: 30 FPS?" pilot. Every claim quotes the official Rockstar Newswire article; no invented scenes.
export const NEWS_SOURCE = "https://www.rockstargames.com/newswire/article/89834o94713o21/pre-load-grand-theft-auto-vi-now";
export const MEDIA_LIBRARY = "https://www.rockstargames.com/VI/media";
export type Shot = { text: string; seconds: number; material: string };
export const PILOT: Shot[] = [
  { text: "GTA VI: 30 frames per second?", seconds: 4, material: "Official GTA VI key art or a trailer still (Rockstar media library)" },
  { text: "Rockstar says GTA VI targets 30 frames per second on current consoles.", seconds: 6, material: "Official screenshot of Leonida (wide city or coast view)" },
  { text: "On PS5 Pro: sharper image with PSSR, plus ray-traced shadows.", seconds: 6, material: "Official screenshot with strong sunlight and shadows" },
  { text: "Source: Rockstar Newswire. Pre-load is live now.", seconds: 5, material: "Official logo / key art, or a screenshot of the Newswire article" },
];
export const totalSeconds = (s: Shot[]) => s.reduce((a, x) => a + x.seconds, 0);
export const pilotValid = (s: Shot[]) => s.length === 4 && totalSeconds(s) >= 18 && totalSeconds(s) <= 23;
