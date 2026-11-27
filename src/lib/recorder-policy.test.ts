import { describe, it, expect } from "vitest";
import { captureEligible, pollBackoff, recorderHealth } from "./recorder-policy";
const now = Date.parse("2026-11-27T21:48:00Z");
const m = {enabled:true,archived_at:null,rights_confirmed:true,media_mode:"recorder",observation:"live",observed_at:new Date(now).toISOString()};
describe("recorder reliability",()=>{
  it("never captures unknown or offline based on IRC",()=>{expect(captureEligible({...m,observation:"unknown"},false,now)).toBe(false);expect(captureEligible({...m,observation:"offline"},false,now)).toBe(false);expect(captureEligible(m,false,now)).toBe(true);});
  it("global pause preserves individual enabled state",()=>{expect(captureEligible(m,true,now)).toBe(false);expect(m.enabled).toBe(true);expect(captureEligible({...m,enabled:false},false,now)).toBe(false);});
  it("archive blocks auto capture",()=>{expect(captureEligible({...m,archived_at:new Date(now).toISOString()},false,now)).toBe(false);});
  it("requires rights and fresh platform evidence",()=>{expect(captureEligible({...m,rights_confirmed:false},false,now)).toBe(false);expect(captureEligible(m,false,now+300001)).toBe(false);});
  it("never reports November 20 buffer ready on November 27",()=>{expect(recorderHealth({at:"2026-11-20T13:50:36Z",ready:true,buffer_s:890},now)).toEqual({heartbeat:"stale",ready:false,buffer_s:null});});
  it("backs off API failure without declaring offline",()=>{expect(pollBackoff(1)).toBe(30000);expect(pollBackoff(6)).toBe(900000);});
});
