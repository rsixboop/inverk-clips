#!/usr/bin/env python3
"""Voice-led GTA VI news with real Rockstar images + transparent AI overlays.

Auto: per-line TTS -> semantically selected RGBA cutout via fal and reusable
overlay library -> script-defined motion -> alpha composite over licensed
original source images -> music mix -> verified MP4.
No AI video ever replaces a source scene.
"""
from __future__ import annotations
import hashlib, json, math, os, subprocess, sys, wave
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from auto_assets import ROOT, HERE, queue, download, save
from overlay_assets import ensure_overlays
from semantic_overlays import validate_cues, load_states, composite
SR, FPS, W, H = 48000, 30, 720, 1280
MAX_SCENES, ALLOWED_ANIMATIONS = 8, {"slide_in","rise","float","pop","sway","sweep"}

def run(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)

def to_pcm(src: Path) -> bytes:
    return run(["ffmpeg","-nostdin","-v","error","-i",str(src),"-f","s16le",
                "-ar",str(SR),"-ac","1","-"],capture_output=True).stdout

def write_wav(path: Path, content: bytes):
    with wave.open(str(path),"wb") as w:
        w.setframerate(SR);w.setnchannels(1);w.setsampwidth(2);w.writeframes(content)

def voice_and_times(episode: dict, work: Path):
    parts, lengths = [], []
    for i, scene in enumerate(episode["scenes"]):
        text = scene["narration"]
        f = work / f"voice_{i:02}.wav"
        if not f.exists():
            payload={"prompt":text,"voice":episode.get("voice","am_fenrir"),"speed":1.12}
            key=hashlib.sha256((episode["id"]+str(i)+text).encode()).hexdigest()[:18]
            r=queue("fal-ai/kokoro/american-english", payload, key+"-overlay-news-tts")
            if not r.get("audio",{}).get("url"): raise RuntimeError("missing TTS audio URL")
            download(r["audio"]["url"],f)
        pcm=to_pcm(f)
        length=len(pcm)/(2*SR)
        if not 1.3 < length < 5.8: raise RuntimeError(f"narration {i} length {length:.2f} needs review")
        parts.append(pcm);lengths.append(length)
        print("NARRATION",i,round(length,2),text,flush=True)
    # Render narration exactly, not inferred text-syllable timings.
    pauses=[0.28 if i<len(parts)-1 else 0.45 for i in range(len(parts))]
    shots=[length+p for length,p in zip(lengths,pauses)]
    starts=[];packed=bytearray()
    for pcm,seconds in zip(parts,shots):
        starts.append(len(packed)/(2*SR))
        packed.extend(pcm)
        packed.extend(bytes(max(0,round(seconds*SR)-len(pcm)//2)*2))
    write_wav(work/"narrator.wav",bytes(packed))
    return shots,starts,len(packed)/(2*SR)

def validate_episode(episode):
    if episode.get("mode")!="overlay":raise ValueError("This renderer requires mode=overlay")
    if not episode.get("source_url","").startswith("https://www.rockstargames.com/VI/"):
        raise ValueError("This episode requires official GTA VI source")
    scenes=episode["scenes"]
    if not 1<=len(scenes)<=MAX_SCENES:raise ValueError("1–8 narration scenes required")
    overlay_count=0
    for s in scenes:
        name=s["background"]
        if name not in ("vc16","vc14","vc11","vc02","vc01","lk01","gr02","pg06","mk02","am01","vc04","vc20"):
            raise ValueError("background not in verified local Rockstar media")
        if not (ROOT/"public/gta6-media"/(name+".jpg")).exists():
            raise FileNotFoundError(name)
        ov=s.get("overlay")
        if ov:
            overlay_count+=1
            if ov.get("animation") not in ALLOWED_ANIMATIONS:raise ValueError("unsupported motion")
            if not isinstance(ov.get("anchor"),list) or len(ov["anchor"])!=2 or not all(0.1<=v<=0.9 for v in ov["anchor"]):
                raise ValueError("overlay anchor must be normalized (0.1..0.9)")
            if not 0.24<=float(ov.get("width",0.40))<=0.5:raise ValueError("overlay size")
    # Objects are optional; narration decides whether any are useful.

def source_canvas(image: Image.Image, phase: float) -> Image.Image:
    # Only background screenshot gets the slow cinematic Ken Burns crop.
    iw, ih=image.size
    dx=max(0,iw-W);dy=max(0,ih-H)
    x=round(dx*(0.42 + 0.12*(phase-0.5)))
    y=round(dy*(0.48 - 0.08*(phase-0.5)))
    return image.crop((x,y,x+W,y+H))

def prepare_bgs(episode:dict):
    result={}
    for s in episode["scenes"]:
        key=s["background"]
        if key in result:continue
        with Image.open(ROOT/"public/gta6-media"/(key+".jpg")) as image:
            im=image.convert("RGB")
            scale=max(810/im.width,1440/im.height)
            result[key]=im.resize((math.ceil(im.width*scale),math.ceil(im.height*scale)),Image.Resampling.LANCZOS)
    return result

def easing(p:float)->float:
    return 1-(1-p)**3

def move_params(kind:str, progress:float):
    # A scenario supplies motion vocabulary; code never draws the asset itself.
    u=min(1,max(0,progress))
    intro=easing(min(1,u/0.19))
    outro=min(1,max(0,(1-u)/0.13))
    opacity=min(intro,outro)
    xoff=yoff=0.0; scale=1.0; angle=0.0
    if kind=="slide_in":
        xoff=110*(1-intro);yoff=8*math.sin(u*2*math.pi)
    elif kind=="rise":
        yoff=120*(1-intro)-8*math.sin(u*2*math.pi)
    elif kind=="float":
        scale=0.78+0.22*intro; yoff=12*math.sin(u*3*math.pi)
    elif kind=="pop":
        scale=(0.65+0.35*intro)*(1+0.023*math.sin(u*5*math.pi))
    elif kind=="sway":
        angle=4*math.sin(u*4*math.pi); yoff=11*math.sin(u*2*math.pi)
    elif kind=="sweep":
        xoff=-110*(1-intro);angle=-4*(1-intro)
    return opacity,scale,angle,xoff,yoff

def draw_overlay(bg:Image.Image, cutout:Image.Image, overlay:dict, p:float):
    opacity,scale,angle,xoff,yoff=move_params(overlay["animation"],p)
    if opacity<0.02:return bg
    maxw=round(W*float(overlay.get("width",0.39))*scale)
    maxh=round(H*0.32*scale)
    aw,ah=cutout.size
    fac=min(maxw/aw,maxh/ah)
    sz=(max(1,round(aw*fac)),max(1,round(ah*fac)))
    img=cutout.resize(sz,Image.Resampling.BICUBIC)
    if abs(angle)>0.25:img=img.rotate(angle,Image.Resampling.BICUBIC,expand=True)
    alpha=img.getchannel("A").point(lambda x:round(x*opacity))
    img.putalpha(alpha)
    x=round(W*overlay["anchor"][0]-img.width/2+xoff)
    y=round(H*overlay["anchor"][1]-img.height/2+yoff)
    bg.paste(img,(x,y),img)
    return bg

def make_episode(path: str):
    ep=json.loads(Path(path).read_text())
    validate_episode(ep)
    work=HERE/"episode-state"/ep["id"];work.mkdir(parents=True,exist_ok=True)
    durations,starts,total=voice_and_times(ep,work)
    cues=validate_cues(ep.get("overlay_cues",[]),total)
    for cue in cues:
        if cue["speech"] not in " ".join(s["narration"] for s in ep["scenes"]):
            raise ValueError("Cue speech anchor absent from narration")
    states=load_states(cues,ROOT/"public")
    requests=[s["overlay"] for s in ep["scenes"] if s.get("overlay")]
    assets,estimated=ensure_overlays(requests,ep.get("style","vice-neon"),
                        ep["id"],float(ep.get("max_asset_spend_usd",3.0)))
    # Stable per-narration association. No full-frame AI video is ever used here.
    asset_iter=iter(assets);mapped=[]
    for s in ep["scenes"]:
        mapped.append(next(asset_iter) if s.get("overlay") else None)
    imgs={}
    for a in assets:
        with Image.open(ROOT/a["path"]) as im:
            if im.mode!="RGBA" or im.getextrema()[3][0]==255:
                raise ValueError(f"{a['id']} has no transparency")
            imgs[a["id"]]=im.copy()
    backgrounds=prepare_bgs(ep)
    out=ROOT/ep["output"];out.parent.mkdir(parents=True,exist_ok=True)
    cmd=["ffmpeg","-y","-nostdin","-v","error","-f","rawvideo","-pix_fmt","rgb24",
         "-s",f"{W}x{H}","-r",str(FPS),"-i","-","-i",str(work/"narrator.wav"),
         "-stream_loop","-1","-i",str(HERE/"size212/original_music.wav"),
         "-filter_complex",
         "[1:a]highpass=f=75,acompressor=threshold=0.11:ratio=2:attack=10:release=130[voice];"
         "[2:a]volume=0.24,lowpass=f=5400[music];"
         "[voice][music]amix=inputs=2:duration=first:weights='1 0.45':normalize=0,"
         "loudnorm=I=-16:TP=-1.5:LRA=9[a]",
         "-map","0:v","-map","[a]","-c:v","libx264","-preset","veryfast","-crf","25",
         "-maxrate","2200k","-bufsize","3200k","-pix_fmt","yuv420p",
         "-c:a","aac","-b:a","128k","-movflags","+faststart",
         "-t",f"{total:.5f}",str(out)]
    proc=subprocess.Popen(cmd,stdin=subprocess.PIPE)
    endpoints=[round(sum(durations[:i+1])*FPS) for i in range(len(durations))]
    n_frames=round(total*FPS)
    seen=[0]*len(ep["scenes"])
    for frame in range(n_frames):
        shot=next((i for i,end in enumerate(endpoints) if frame<end),len(endpoints)-1)
        s=ep["scenes"][shot];start=0 if shot==0 else endpoints[shot-1]
        n=endpoints[shot]-start;local=frame-start
        progress=local/max(1,n)
        bg=source_canvas(backgrounds[s["background"]],progress)
        asset=mapped[shot]
        if asset:
            bg=draw_overlay(bg,imgs[asset["id"]],s["overlay"],progress)
            if .20<progress<.85:seen[shot]+=1
        bg=composite(bg,cues,states,frame/FPS)
        try:proc.stdin.write(bg.tobytes())
        except BrokenPipeError:raise RuntimeError("ffmpeg overlay compositor exited early")
        if frame%(FPS*5)==0:print("COMPOSITED",round(frame/FPS,1),"/",round(total,1),flush=True)
    proc.stdin.close()
    if proc.wait()!=0:raise RuntimeError("FFmpeg export failed")
    used=[i for i,n in enumerate(seen) if n>12]
    if any(mapped[i] and seen[i]==0 for i in range(len(mapped))):raise RuntimeError("Requested overlay was never visible")
    probe=json.loads(run(["ffprobe","-v","error","-show_format","-of","json",str(out)],
                          capture_output=True,text=True).stdout)
    actual=float(probe["format"]["duration"])
    if abs(actual-total)>0.3:raise RuntimeError("Audio/video duration mismatch")
    if out.stat().st_size>=9_000_000:raise RuntimeError("Final video exceeds Git size limit")
    run(["ffmpeg","-v","error","-i",str(out),"-f","null","-"],capture_output=True)
    manifest={"episode":ep["id"],"mode":"true_transparent_overlay","source":ep["source_url"],
              "overlay_cues":cues,
              "output":str(out.relative_to(ROOT)),"duration":round(total,2),
              "estimated_asset_spend_usd":estimated,
              "scenes":[{"narration":s["narration"],"background":s["background"],
                        "start":round(t,2),"seconds":round(d,2),
                        "asset_id":mapped[i]["id"] if mapped[i] else None,
                        "overlay_path":mapped[i]["path"] if mapped[i] else None,
                        "overlay_frames":seen[i],"motion":s.get("overlay",{}).get("animation")}
                        for i,(s,t,d) in enumerate(zip(ep["scenes"],starts,durations))]}
    save(work/"manifest.json",manifest)
    print("READY",manifest["output"],"bytes",out.stat().st_size,"overlays",len(used),
          "duration",round(actual,2),"estimated_spend",estimated,flush=True)
    return manifest

if __name__=="__main__":
    if len(sys.argv)!=2:raise SystemExit("Usage: render_overlay_news.py episode.json")
    make_episode(sys.argv[1])
