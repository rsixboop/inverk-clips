import type { OverlayIntent } from "./news-overlay-plan";
export type AssetState = { intent: OverlayIntent; step: number; requestId?: string; imageUrl?: string; paths: string[]; error?: string; requests?: string[]; claimedAt?: number };
export const STATE_OPERATIONS=6;
export function stateOperation(state: AssetState) {
  const index=Math.floor(state.step/2);
  const description=[state.intent.before,state.intent.action,state.intent.after][index];
  if (!description) return null;
  if(state.step%2===1) return {model:"fal-ai/imageutils/rembg",input:{image_url:state.imageUrl}};
  const prompt=`Exactly one premium physically illustrated editorial object: ${state.intent.object}. STATE: ${description}. Isolated on solid light gray, clean complete silhouette, same front view and scale in all states, no shadows outside object, no scene, no sticker border, no UI boxes, no labels, no text or logo. Matte ceramic and machined metal, refined softbox lighting. Purpose: ${state.intent.purpose}.`;
  return {model:state.imageUrl ? "fal-ai/nano-banana/edit" : "fal-ai/nano-banana",input:{prompt,num_images:1,aspect_ratio:"1:1",output_format:"png",...(state.imageUrl?{image_urls:[state.imageUrl]}:{})}};
}
export function nextStateOperation(state: AssetState, url: string, path?: string): AssetState {
  // Keep image URL as reference for the next physical state, not rembg output.
  return {intent:state.intent,step:state.step+1,paths:path?[...state.paths,path]:state.paths,imageUrl:state.step%2===0?url:state.imageUrl ?? url,requests:state.requests ?? []};
}