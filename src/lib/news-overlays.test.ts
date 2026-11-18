import { describe, expect, it } from "vitest";
import { overlayState, validateOverlayCues } from "./news-overlays";
const cue = { purpose:"download is not early access", speech:"not early access", start:1, action:2, after:4, end:5,
  before:"/overlay-library/test/before.png", active:"/overlay-library/test/active.png", result:"/overlay-library/test/result.png", box:[0,0.8,1,0.2] };
describe("optional narration cues",()=>{
  it("accepts zero cues without requiring four",()=>{expect(validateOverlayCues([],6)).toEqual([]);expect(validateOverlayCues(undefined,6)).toEqual([]);});
  it("accepts exactly one and produces timed state changes",()=>{
    const [c]=validateOverlayCues([cue],6); if(!c) throw new Error("missing cue");
    expect(overlayState(c,0)).toBeNull();expect(overlayState(c,1.5)).toEqual({name:"before",progress:0});
    expect(overlayState(c,3)).toEqual({name:"active",progress:0.5});expect(overlayState(c,4.1)?.name).toBe("result");expect(overlayState(c,5)).toBeNull();
  });
  it("rejects unsynchronized or non-library objects",()=>{
    expect(()=>validateOverlayCues([{...cue,after:1}],6)).toThrow();
    expect(()=>validateOverlayCues([{...cue,before:"https://example.com/a.png"}],6)).toThrow();
  });
});