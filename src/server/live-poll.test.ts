import { afterEach, describe, expect, it, vi } from "vitest";
import { youtubeStep, twitchStep } from "./live.server";
const monitor={id:"m",user_id:"u",platform:"youtube",input:"https://www.youtube.com/watch?v=ng8DPz5LYR0",channel_id:null,channel_title:null,live_video_id:null,live_chat_id:null,status:"resolving",page_token:null,stream_started_at:null,stats:{},media_mode:"recorder",messages_seen:0,poll_failures:0,observation:"unknown"};
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
describe("platform observation",()=>{
  it("live without chat remains live and capture eligible",async()=>{
    vi.stubEnv("YOUTUBE_API_KEY","fixture");vi.stubGlobal("fetch",vi.fn(async()=>Response.json({items:[{snippet:{channelId:"channel",channelTitle:"fixture"},liveStreamingDetails:{actualStartTime:"2026-11-27T21:00:00Z"}}]})));
    const r=await youtubeStep(monitor);expect(r.patch['status']).toBe("live");expect(r.patch['live_chat_id']).toBeNull();
  });
  it("confirmed end is offline",async()=>{
    vi.stubEnv("YOUTUBE_API_KEY","fixture");vi.stubGlobal("fetch",vi.fn(async()=>Response.json({items:[{snippet:{channelId:"channel"},liveStreamingDetails:{actualStartTime:"2026-11-27T21:00:00Z",actualEndTime:"2026-11-27T22:00:00Z"}}]})));
    expect((await youtubeStep(monitor)).patch['status']).toBe("offline");
  });
  it("API failure is not an offline observation",async()=>{
    vi.stubEnv("YOUTUBE_API_KEY","fixture");vi.stubGlobal("fetch",vi.fn(async()=>Response.json({error:{errors:[{reason:"quotaExceeded"}]}},{status:403})));
    await expect(youtubeStep(monitor)).rejects.toMatchObject({kind:"retry"});
  });
  it("disabled chat is rechecked against actual stream rather than declared offline",async()=>{
    vi.stubEnv("YOUTUBE_API_KEY","fixture");vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(Response.json({error:{errors:[{reason:"liveChatDisabled"}]}},{status:403})).mockResolvedValueOnce(Response.json({items:[{snippet:{channelId:"c"},liveStreamingDetails:{actualStartTime:"2026-11-27T21:00:00Z"}}]})));
    expect((await youtubeStep({...monitor,live_chat_id:"chat"})).patch['status']).toBe("live");
  });
  it("anonymous IRC cannot confirm a Twitch live broadcast",async()=>{
    vi.stubEnv("TWITCH_API_KEY","");
    class Socket { close(){} send(){} addEventListener(name:string,fn:(x:{data:string})=>void){if(name==="open")queueMicrotask(()=>fn({data:""}));if(name==="message")queueMicrotask(()=>fn({data:"server JOIN #xqc\r\n"}));} }
    vi.stubGlobal("WebSocket",Socket);
    const r=await twitchStep({...monitor,platform:"twitch",input:"https://www.twitch.tv/xqc"},5);
    expect(r.patch['observation']).toBe("unknown");expect(r.patch['status']).not.toBe("live");
  });
});
