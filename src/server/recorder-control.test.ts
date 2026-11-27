import { beforeEach, describe, expect, it, vi } from "vitest";
const fake=vi.hoisted(()=>({calls:[] as {method:string,args:unknown[]}[],exists:true}));
vi.mock("@/integrations/supabase/client.server",()=>({supabaseAdmin:{from:(table:string)=>{
  fake.calls.push({method:"from",args:[table]});
  const q:Record<string,unknown>={};
  for(const method of ["upsert","update","eq","is","select"]){q[method]=(...args:unknown[])=>{fake.calls.push({method,args});return q;};}
  q['maybeSingle']=async()=>({data:fake.exists?{id:"a"}:null,error:null});
  q['then']=(resolve:(r:unknown)=>unknown)=>resolve({data:[],error:null});
  return q;
}}}));
import { recorderOperation } from "./recorder-control.server";
const id="11111111-1111-4111-8111-111111111111";
beforeEach(()=>{fake.calls=[];fake.exists=true;});
describe("server recorder owner controls",()=>{
  it("start scopes writes to token owner",async()=>{
    await recorderOperation("owner","recorder.start",{id});
    expect(fake.calls).toContainEqual({method:"eq",args:["user_id","owner"]});
    expect(fake.calls.find(c=>c.method==="update")?.args[0]).toMatchObject({enabled:true,observation:"unknown"});
  });
  it("foreign or missing monitor is rejected",async()=>{
    fake.exists=false;await expect(recorderOperation("other-owner","recorder.start",{id})).rejects.toThrow("Monitor missing or archived");
    expect(fake.calls).toContainEqual({method:"eq",args:["user_id","other-owner"]});
  });
  it("archive soft-stops and never deletes records",async()=>{
    await recorderOperation("owner","recorder.archive",{id});
    expect(fake.calls.find(c=>c.method==="update")?.args[0]).toMatchObject({enabled:false,status:"stopped",archived_at:expect.any(String)});
    expect(fake.calls.some(c=>c.method==="delete")).toBe(false);
  });
  it("global pause preserves individual states and fences polling",async()=>{
    await recorderOperation("owner","recorder.pause",{});
    expect(fake.calls.find(c=>c.method==="upsert")?.args[0]).toMatchObject({user_id:"owner",paused:true});
    expect(fake.calls.find(c=>c.method==="update")?.args[0]).toEqual({lease:null,lease_until:null});
  });
  it("media add requires explicit rights before any write",async()=>{
    await expect(recorderOperation("owner","recorder.add",{input:"https://www.twitch.tv/xqc",media_mode:"recorder",rights:false},id)).rejects.toThrow("rights confirmation");
    expect(fake.calls).toEqual([]);
  });
});
