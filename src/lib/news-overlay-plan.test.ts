import { describe,expect,it } from "vitest";
import { canReserveOverlay,matchSpeechPhrase,timeOverlayIntent,validateOverlayIntents, type OverlayIntent } from "./news-overlay-plan";
import { nextStateOperation,stateOperation } from "./news-overlay-machine";
const intent:OverlayIntent={purpose:"Explain a wider map",phrase:"Спочатку карта закрита потім розгортається повністю",action_phrase:"розгортається",after_phrase:"повністю",object:"folded relief map",before:"folded",action:"unfolding",after:"open",box:[.1,.5,.8,.3]};
describe("planner-led arbitrary overlay cues",()=>{
 it("accepts unrelated Ukrainian topic and exact spoken phrase",()=>{
  expect(validateOverlayIntents([intent],intent.phrase).intents).toHaveLength(1);
  const words=intent.phrase.split(" ").map((word,i)=>({word,start:i*.5,end:i*.5+.4}));
  expect(timeOverlayIntent(intent,words,5)).toMatchObject({start:0,action:2,after:2.5,end:3.05});
 });
 it("keeps no-cue empty without topic regex fallback",()=>{expect(validateOverlayIntents([],"download preload").intents).toEqual([]);});
 it("skips mismatched or ambiguous phrases",()=>{
  expect(validateOverlayIntents([intent],"different narration").intents).toEqual([]);
  expect(matchSpeechPhrase("map",[{word:"map",start:0,end:1},{word:"map",start:2,end:3}])).toBeUndefined();
 });
 it("caps new reservations at exactly one dollar",()=>{
  expect(canReserveOverlay(.7,.3)).toBe(true);expect(canReserveOverlay(.75,.3)).toBe(false);
 });
 it("advances six durable operations without forgetting the reference",()=>{
  let s={intent,step:0,paths:[] as string[]};
  expect(stateOperation(s)?.model).toBe("fal-ai/nano-banana");
  const first=nextStateOperation(s,"https://fal.media/original.png");
  expect(stateOperation(first)?.model).toBe("fal-ai/imageutils/rembg");
  const second=nextStateOperation(first,"https://fal.media/cutout.png","saved.png");
  expect(second.imageUrl).toBe("https://fal.media/original.png");
  expect(stateOperation(second)?.model).toBe("fal-ai/nano-banana/edit");
 });
});