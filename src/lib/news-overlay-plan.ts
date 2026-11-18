// Planner describes meaning, never asset URLs or guessed audio timestamps.
export type OverlayIntent = {
  purpose: string; phrase: string; action_phrase: string; after_phrase: string;
  object: string; before: string; action: string; after: string;
  cached_asset_key?: string; box: [number,number,number,number];
};
export type SpeechWord = { word: string; start: number; end: number };
const textKey = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
export function validateOverlayIntents(input: unknown, narration: string): { intents: OverlayIntent[]; skipped: string[] } {
  if (input == null) return {intents:[],skipped:[]};
  if (!Array.isArray(input)) return {intents:[],skipped:["Непригодный список объектов пропущен"]};
  const intents: OverlayIntent[]=[]; const skipped: string[]=[];
  for (const raw of input) {
    const c=raw as Partial<OverlayIntent> | null;
    const fields=["purpose","phrase","action_phrase","after_phrase","object","before","action","after"] as const;
    if (!c || fields.some(k=>typeof c[k]!=="string" || !c[k]?.trim() || (c[k]?.length ?? 0)>600)) {skipped.push("Объект без цели, фразы или состояния пропущен");continue;}
    const phrase=c.phrase ?? "", action=c.action_phrase ?? "", after=c.after_phrase ?? "";
    const n=textKey(narration), p=textKey(phrase), a=textKey(action), r=textKey(after);
    if (!p || !a || !r || !n.includes(p) || !p.includes(a) || !p.includes(r) || p.indexOf(a)>=p.indexOf(r)) {skipped.push("Фраза или порядок действия не совпадает с озвучкой — объект пропущен");continue;}
    const b=c.box;
    if (!Array.isArray(b) || b.length!==4 || !b.every(v=>Number.isFinite(v)&&v>=0&&v<=1) || b[2]<=0 || b[3]<=0 || b[0]+b[2]>1 || b[1]+b[3]>1) {skipped.push("Объект выходит за кадр — пропущен");continue;}
    intents.push(c as OverlayIntent);
  }
  return {intents,skipped};
}
// A unique contiguous word match is required; repeated/uncertain phrases skip.
export function matchSpeechPhrase(phrase: string, words: SpeechWord[]) {
  const target=textKey(phrase).split(" ").filter(Boolean);
  const normalized=words.flatMap(w=>textKey(w.word).split(" ").filter(Boolean).map(word=>({...w,word})));
  const hits: {start:number;end:number}[]=[];
  for(let i=0;i<=normalized.length-target.length;i++) {
    if (!target.every((w,k)=>normalized[i+k]?.word===w)) continue;
    const first=normalized[i],last=normalized[i+target.length-1];
    if(first && last && Number.isFinite(first.start) && Number.isFinite(last.end) && last.end>first.start) hits.push({start:first.start,end:last.end});
  }
  return hits.length===1 ? hits[0] : undefined;
}
export function timeOverlayIntent(intent: OverlayIntent, words: SpeechWord[], duration: number) {
  const phrase=matchSpeechPhrase(intent.phrase,words), action=matchSpeechPhrase(intent.action_phrase,words), after=matchSpeechPhrase(intent.after_phrase,words);
  if(!phrase || !action || !after) return null;
  const start=phrase.start, act=action.start, done=after.start, end=Math.min(duration,phrase.end+0.15);
  if(!(0<=start && start<act && act<done && done<end)) return null;
  return {purpose:intent.purpose,speech:intent.phrase,start,action:act,after:done,end,box:intent.box};
}
export const OVERLAY_ASSET_RESERVATION_USD=0.30;
export const OVERLAY_ALIGN_RESERVATION_USD=0.05;
export const OVERLAY_BATCH_CAP_USD=1;
export function canReserveOverlay(reserved:number,cost:number) { return cost>=0 && reserved+cost<=OVERLAY_BATCH_CAP_USD; }
export const builtinOverlayAssets = [{key:"builtin:download-vault",object:"a mechanical game download vault",before:"empty reservoir with raised shackle",action:"full reservoir with raised shackle",after:"full reservoir with closed shackle"}];