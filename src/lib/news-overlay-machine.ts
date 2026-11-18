import type { OverlayIntent } from "./news-overlay-plan";
export type AssetState = { intent: OverlayIntent; step: number; requestId?: string; imageUrl?: string; paths: string[]; error?: string; requests?: string[]; claimedAt?: number };
export const STATE_OPERATIONS=6;
export function stateOperation(state: AssetState) {
  const index=Math.floor(state.step/2);
  const description=[state.intent.before,state.intent.action,state.intent.after][index];
  if (!description) return null;
  if(state.step%2===1) return {model:"fal-ai/imageutils/rembg",input:{image_url:state.imageUrl}};
  const prompt=`Create a clean editorial illustration of one object: ${state.intent.object}. Show this state: ${description}. Entire object visible, isolated on a plain light gray background. Use the object's natural materials. Keep the same viewpoint and scale as the reference if supplied. No words, logos, border or surrounding scenery.`;
  return {model:state.imageUrl ? "fal-ai/nano-banana/edit" : "fal-ai/nano-banana",input:{prompt,num_images:1,aspect_ratio:"1:1",output_format:"png",...(state.imageUrl?{image_urls:[state.imageUrl]}:{})}};
}
export function nextStateOperation(state: AssetState, url: string, path?: string): AssetState {
  // Keep image URL as reference for the next physical state, not rembg output.
  return {intent:state.intent,step:state.step+1,paths:path?[...state.paths,path]:state.paths,imageUrl:state.step%2===0?url:state.imageUrl ?? url,requests:state.requests ?? []};
}