export const categories = ["teamfight", "solo_kill", "gameplay", "dialogue", "reaction", "story", "other"] as const;
export type ClipCategory = typeof categories[number];
export type ClipCard = {category: ClipCategory; topic: string; candidate: boolean; summary: string};

export function clipCard(description: string | null, state: string): ClipCard {
  const text = (description ?? "").trim();
  // The header is generated in the same call as the visual analysis. Old MP4s keep their existing descriptions.
  const header = /^CLIP\|(teamfight|solo_kill|gameplay|dialogue|reaction|story|other)\|(candidate|review)\|([^|\r\n]{1,100})\r?\n([\s\S]+)$/.exec(text);
  if (!header) return {category:"other", topic:"Без разметки", candidate:false, summary:text};
  return {category:header[1] as ClipCategory, topic:header[3]!.trim(),
    candidate:state === "done" && header[2] === "candidate" && !!header[4]!.trim(), summary:header[4]!.trim()};
}
