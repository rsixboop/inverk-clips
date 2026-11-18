import {describe,expect,it,vi} from "vitest";
import {resolveOverlayAsset} from "./news-overlay.server";
vi.mock("./providers/fal",()=>({falConfigured:()=>true,falSubmit:vi.fn(),falPoll:vi.fn(),providerMedia:(u:string)=>u}));
import {falSubmit} from "./providers/fal";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {Database} from "@/integrations/supabase/types";
const intent={purpose:"map expands",phrase:"First the map unfolds fully",action_phrase:"unfolds",after_phrase:"fully",object:"relief map",before:"folded",action:"unfolding",after:"open",box:[0,.5,1,.3]};
function fakeDB(row:unknown) {
 const builder={select:()=>builder,eq:()=>builder,maybeSingle:async()=>({data:row,error:null})};
 return {from:()=>builder,storage:{from:()=>({createSignedUrl:async(path:string)=>({data:{signedUrl:"https://test/object/sign/outputs/"+path},error:null})})}} as unknown as SupabaseClient<Database>;
}
describe("durable overlay cache barriers",()=>{
 it("reuses ready states without paid submission",async()=>{
  const r=await resolveOverlayAsset(fakeDB({phase:"ready",state:{step:6,paths:["a","b","c"],intent}}),"user","batch",intent.phrase,intent);
  expect(r.status).toBe("done");expect(falSubmit).not.toHaveBeenCalled();
 });
 it("never replays an unknown paid submission",async()=>{
  const r=await resolveOverlayAsset(fakeDB({phase:"submitting",state:{step:0,paths:[],intent}}),"user","batch",intent.phrase,intent);
  expect(r.status).toBe("skipped");expect(falSubmit).not.toHaveBeenCalled();
 });
});