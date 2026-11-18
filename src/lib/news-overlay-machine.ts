import type { OverlayIntent } from "./news-overlay-plan";
/** v2 motion assets: still → cutout → fal image-to-video (object's own motion) → fal video matting (alpha WebM). */
export type AssetState = { intent: OverlayIntent; step: number; version?: 2; requestId?: string; imageUrl?: string | undefined; videoUrl?: string | undefined; paths: string[]; error?: string; requests?: string[]; claimedAt?: number };
export const MOTION_OPERATIONS=4;
export const MODELS={image:"fal-ai/nano-banana",rembg:"fal-ai/imageutils/rembg",i2v:"fal-ai/bytedance/seedance/v1/lite/image-to-video",matte:"fal-ai/birefnet/v2/video"} as const;
/** Legacy 3-still assets (step 6) or v2 motion assets (step 4: [png, webm]). */
export function assetDone(state: AssetState | undefined) {
  return !!state && ((state.step===6 && state.paths.length===3) || (state.version===2 && state.step===MOTION_OPERATIONS && state.paths.length===2));
}
export function stateOperation(state: AssetState) {
  const i=state.intent;
  switch(state.step) {
    case 0: return {model:MODELS.image,input:{prompt:`Create a clean editorial illustration of one object: ${i.object}. Show this state: ${i.before}. Entire object visible and centered with generous empty margin, isolated on a plain flat light gray background. Natural materials, soft studio light. No words, logos, border, hands or surrounding scenery.`,num_images:1,aspect_ratio:"1:1",output_format:"png"}};
    case 1: return {model:MODELS.rembg,input:{image_url:state.imageUrl}};
    case 2: return {model:MODELS.i2v,input:{image_url:state.imageUrl,prompt:`The object itself performs this change: ${i.action}. It ends as: ${i.after}. Locked-off camera, the object stays centered and fully in frame, the plain light gray background stays empty and unchanged. No hands, no new objects, no text, no scene cuts.`,duration:"3",resolution:"480p",aspect_ratio:"1:1",camera_fixed:true}};
    case 3: return {model:MODELS.matte,input:{video_url:state.videoUrl,video_output_type:"VP9 (.webm)",model:"General Use (Light)",operating_resolution:"1024x1024",refine_foreground:true}};
    default: return null;
  }
}
/** Output URL for the current step's fal result. */
export function stepOutputUrl(step: number, result: Record<string, any>): unknown {
  return step===0 ? result["images"]?.[0]?.url : step===1 ? result["image"]?.url : result["video"]?.url;
}
export function nextStateOperation(state: AssetState, url: string, path?: string): AssetState {
  return {intent:state.intent,version:2,step:state.step+1,paths:path?[...state.paths,path]:state.paths,
    imageUrl:state.step===0?url:state.imageUrl,videoUrl:state.step===2?url:state.videoUrl,requests:state.requests ?? []};
}
