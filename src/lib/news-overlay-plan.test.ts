import { describe,expect,it } from "vitest";
import { canReserveOverlay,OVERLAY_ALIGN_RESERVATION_USD,OVERLAY_ASSET_RESERVATION_USD,matchSpeechPhrase,timeOverlayIntent,validateOverlayIntents, type OverlayIntent } from "./news-overlay-plan";
import { assetDone,nextStateOperation,stateOperation } from "./news-overlay-machine";
const intent:OverlayIntent={purpose:"Explain a wider map",phrase:"Спочатку карта закрита потім розгортається повністю",action_phrase:"розгортається",after_phrase:"повністю",object:"folded relief map",before:"folded",action:"unfolding",after:"open",box:[.1,.5,.8,.3]};
describe("planner-led arbitrary overlay cues",()=>{
 it("accepts unrelated Ukrainian topic and exact spoken phrase",()=>{
  expect(validateOverlayIntents([intent],intent.phrase).intents).toHaveLength(1);
  const words=intent.phrase.split(" ").map((word,i)=>({word,start:i*.5,end:i*.5+.4}));
  expect(timeOverlayIntent(intent,words,5)).toMatchObject({start:0,action:2,after:2.5,end:3.05});
 });
 it("clamps a phrase that starts before the proportional cut and tolerates a re-transcribed lead-in",()=>{
  const words=["vinyl","collectors","pre","-orders","include","a","limited","clear","edition"].map((word,i)=>({word,start:i*.5-1,end:i*.5-.6}));
  const t=timeOverlayIntent({...intent,phrase:"For vinyl collectors, pre-orders include a limited clear edition",action_phrase:"include",after_phrase:"clear edition"},words,6);
  expect(t).toMatchObject({start:0.4,action:1,after:2.5});
 });
 it("keeps no-cue empty without topic regex fallback",()=>{expect(validateOverlayIntents([],"download preload").intents).toEqual([]);});
 it("skips mismatched or ambiguous phrases",()=>{
  expect(validateOverlayIntents([intent],"different narration").intents).toEqual([]);
  expect(matchSpeechPhrase("map",[{word:"map",start:0,end:1},{word:"map",start:2,end:3}])).toBeUndefined();
 });
 it("caps new reservations at exactly one dollar",()=>{
  expect(canReserveOverlay(.7,.3)).toBe(true);expect(canReserveOverlay(.75,.3)).toBe(false);
 });
 it("advances four durable motion operations: still, cutout, fal image-to-video, fal alpha matting",()=>{
  let s:any={intent,step:0,paths:[] as string[]};
  expect(stateOperation(s)?.model).toBe("fal-ai/nano-banana");
  s=nextStateOperation(s,"https://fal.media/still.png");
  expect(stateOperation(s)?.input).toMatchObject({image_url:"https://fal.media/still.png"});
  s=nextStateOperation(s,"https://fal.media/cut.png","a.png");
  const i2v=stateOperation(s);expect(i2v?.model).toBe("fal-ai/bytedance/seedance/v1/lite/image-to-video");
  expect(i2v?.input).toMatchObject({image_url:"https://fal.media/still.png",duration:"3",resolution:"480p"});
  s=nextStateOperation(s,"https://fal.media/clip.mp4");
  expect(stateOperation(s)?.input).toMatchObject({video_url:"https://fal.media/clip.mp4",video_output_type:"VP9 (.webm)"});
  s=nextStateOperation(s,"https://fal.media/alpha.webm","a.webm");
  expect(assetDone(s)).toBe(true);expect(stateOperation(s)).toBeNull();
 });
 it("reserves a motion asset plus speech alignment within the one-dollar cap",()=>{
  expect(canReserveOverlay(OVERLAY_ALIGN_RESERVATION_USD,OVERLAY_ASSET_RESERVATION_USD)).toBe(true);
  expect(canReserveOverlay(OVERLAY_ALIGN_RESERVATION_USD+OVERLAY_ASSET_RESERVATION_USD,OVERLAY_ASSET_RESERVATION_USD)).toBe(false);
 });
});
