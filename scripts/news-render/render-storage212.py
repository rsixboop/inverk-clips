#!/usr/bin/env python3
"""One-off news short, NOT a new pipeline: verified Rockstar pre-load size.
Narration is generated per sentence; caption boundaries use measured audio
samples, never guessed timestamps. Source artwork stays illustrative."""
import json, math, os, subprocess, time, urllib.request, wave
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "scripts/news-render/size212"
BASE.mkdir(parents=True, exist_ok=True)
OUT = ROOT / "public/gta6_212gb_news.mp4"
W,H,FPS,SR = 720,1280,30,48000
VOICE = "am_fenrir"
LINES = [
 "Two hundred and twelve gigabytes. That's how much space GTA Six could need.",
 "And that's not a leak. Rockstar confirmed it for preloading.",
 "Preloads are already live on PlayStation Five and Xbox Series X and S.",
 "But downloading early doesn't mean playing early.",
 "GTA Six unlocks November nineteenth, at midnight local time.",
 "So be honest. What game are you deleting to make room?"
]
# Visual story beats, not subtitles that spoil the next spoken idea.
# Every background is chosen for the topic; explanatory UI appears at the moment
# it is discussed. Variable cut points keep the montage from feeling mechanical.
IMGS = [
 ["vc16", "vc14", "vc04"],  # storage space
 ["vc11", "jl06"],          # Rockstar's statement
 ["vc02", "vc07", "vc01"],  # downloading
 ["jl13", "vc20"],          # early download is NOT early access
 ["vc11", "lk01", "vc04"],  # date/release
 ["vc02", "vc16"],          # game-library deletion
]
CUTS = [[0.28,0.68],[0.47],[0.29,0.69],[0.56],[0.36,0.73],[0.48]]
LIME=(197,244,65); WHITE=(246,246,241)
FONTFILE = subprocess.run(["fc-match","-f","%{file}","DejaVu Sans:style=Bold"],text=True,capture_output=True,check=True).stdout.strip()
def font(sz): return ImageFont.truetype(FONTFILE,sz)
def run(args, **kw): return subprocess.run(args, check=True, **kw)
def jget(url, headers=None, data=None):
    req=urllib.request.Request(url,headers=headers or {},data=data)
    with urllib.request.urlopen(req, timeout=40) as r: return json.loads(r.read().decode())
def save_json(path, data):
    tmp=path.with_suffix(path.suffix+".tmp")
    tmp.write_text(json.dumps(data,indent=2))
    tmp.replace(path)
def tts_segment(idx, text):
    path=BASE / f"line-{idx+1:02}.wav"
    if path.exists() and path.stat().st_size>1000: return path
    key=os.environ.get("FAL_KEY")
    if not key: raise RuntimeError("FAL_KEY unavailable: cannot create a new, synced narrator")
    flag=BASE/f"request-{idx+1:02}.json"
    state=json.loads(flag.read_text()) if flag.exists() else {}
    if state.get("status")=="submitting": raise RuntimeError(f"Ambiguous paid TTS submission for line {idx+1}; no automatic duplicate")
    headers={"Authorization":"Key "+key,"Content-Type":"application/json"}
    endpoint="fal-ai/kokoro/american-english"
    if not state.get("id"):
        save_json(flag,{"status":"submitting","text":text})
        body=json.dumps({"prompt":text,"voice":VOICE,"speed":1.07}).encode()
        out=jget("https://queue.fal.run/"+endpoint,headers,body)
        request_id=out.get("request_id")
        if not request_id: raise RuntimeError("TTS request ID missing; no retry allowed")
        state={"id":request_id,"status":"submitted"}
        save_json(flag,state)
    reqid=state["id"]
    base=f"https://queue.fal.run/fal-ai/kokoro/requests/{reqid}"
    for attempt in range(100):
        status=jget(base+"/status",headers)
        st=status.get("status")
        if st=="COMPLETED":
            result=jget(base,headers)
            url=result.get("audio",{}).get("url","")
            if not url.startswith("https://") or "fal.media/" not in url: raise RuntimeError("Unexpected TTS media URL")
            urllib.request.urlretrieve(url,path)
            save_json(flag,{"id":reqid,"status":"done"})
            return path
        if st not in ("IN_QUEUE","IN_PROGRESS"): raise RuntimeError(f"TTS line {idx+1}: {st}")
        time.sleep(2)
    raise RuntimeError(f"TTS line {idx+1} has not finished; request {reqid} is saved")

def pcm(path):
    return run(["ffmpeg","-nostdin","-v","error","-i",str(path),"-ar",str(SR),"-ac","1","-f","s16le","-"],
               capture_output=True).stdout
def write_wav(path, payload, rate=SR):
    with wave.open(str(path),"wb") as f:
        f.setnchannels(1);f.setsampwidth(2);f.setframerate(rate);f.writeframes(payload)

def make_music(duration):
    # Original neon-crime underscore, no GTA music/samples: minor chords,
    # eighth-note arp, pulsing sub-bass, kick/snare and a gentle CTA accent.
    from array import array
    rate=24000
    out=array("h")
    bpm=98; beat=60/bpm
    chords=[
        (98.0,(196.0,233.08,293.66)),
        (77.78,(155.56,196.0,233.08)),
        (116.54,(233.08,293.66,349.23)),
        (87.31,(174.61,220.0,261.63))
    ]
    for i in range(int(duration*rate)):
        t=i/rate
        root,notes=chords[int(t/(beat*4))%4]
        pad=0.24*sum(math.sin(2*math.pi*f*t+0.04*math.sin(2*math.pi*0.17*t)) for f in notes)/3
        eighth=t%(beat/2)
        arp_note=notes[(int(t/(beat/2))%6)//2]
        arp=0.11*math.exp(-eighth*7.5)*math.sin(2*math.pi*arp_note*2*t)
        phase=t%beat
        bass=0.19*(0.2+0.8*math.exp(-phase*5))*math.sin(2*math.pi*root*t)
        kick=0.26*math.exp(-phase*27)*math.sin(2*math.pi*(64-25*min(1,phase*10))*phase)
        snare_phase=(t-beat/2)%beat
        snare=0.038*math.exp(-snare_phase*30)*math.sin(2*math.pi*1800*t)*math.sin(2*math.pi*1073*t)
        fade=min(1,t/0.5,max(0,(duration-t)/0.8))
        out.append(round(max(-0.9,min(0.9,fade*(pad+arp+bass+kick+snare)))*32767))
    write_wav(BASE/"original_music.wav",out.tobytes(),rate)

def source_img(key):
    fp=ROOT/"public/gta6-media"/(key+".jpg")
    if not fp.exists(): raise RuntimeError(f"Missing official Rockstar illustration {fp}")
    return Image.open(fp).convert("RGB")

def prepared_image(key):
    src=source_img(key)
    # Crop to portrait with safe overscan and one-time resize (smooth motion in shot).
    scale=max((W*1.17)/src.width,(H*1.17)/src.height)
    return src.resize((math.ceil(src.width*scale),math.ceil(src.height*scale)),Image.Resampling.LANCZOS)

def live_frames(name):
    fp=ROOT/"public/gta6-media"/(name+".mp4")
    if not fp.exists(): return []
    raw=run(["ffmpeg","-nostdin","-v","error","-i",str(fp),"-t","1.0",
        "-vf",f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}",
        "-r",str(FPS),"-f","rawvideo","-pix_fmt","rgb24","-"],capture_output=True).stdout
    sz=W*H*3
    return [Image.frombytes("RGB",(W,H),raw[i:i+sz]) for i in range(0,len(raw)-sz+1,sz)]

def cover(key, progress):
    img=CACHE[key]
    extra_x=img.width-W; extra_y=img.height-H
    shift=0.12*(progress-0.5)
    x=round(extra_x*max(0,min(1,0.5+shift)))
    y=round(extra_y*max(0,min(1,0.5-0.7*shift)))
    return img.crop((x,y,x+W,y+H))

def caption(im, line, prog):
    layer=Image.new("RGBA",(W,H),(0,0,0,0)); d=ImageDraw.Draw(layer)
    for y in range(760,H):
        alpha=round(155*((y-760)/(H-760))**1.5)
        d.line([(0,y),(W,y)],fill=(0,0,0,alpha),width=1)
    d.rounded_rectangle((38,57,177,94),radius=9,fill=(0,0,0,152))
    d.text((49,63),"GTA VI",font=font(23),fill=LIME)
    if line==0:
        d.text((44,875),"UP TO",font=font(52),fill=WHITE)
        # Number is tied to its spoken sentence, not a standalone card.
        d.text((39,930),"212 GB",font=font(130),fill=LIME,stroke_width=2,stroke_fill=(9,9,9))
        d.text((45,1102),"PRELOAD SPACE",font=font(28),fill=WHITE)
    else:
        y=948
        for j,part in enumerate(CAPS[line]):
            size=59 if len(part)>16 else 72
            d.text((42,y+88*j),part,font=font(size),fill=LIME if j==1 else WHITE,
                   stroke_width=2,stroke_fill=(0,0,0))
    if line==1:
        d.text((42,1197),"SOURCE: ROCKSTAR SUPPORT",font=font(23),fill=(205,212,215))
    if line==2:
        # Simple editorial visualization, not a fake Xbox/PS storefront screenshot.
        d.rounded_rectangle((420,129,666,170),radius=10,fill=(0,0,0,140))
        d.text((438,137),"PS5  /  XBOX",font=font(22),fill=WHITE)
        d.rounded_rectangle((42,1168,680,1182),radius=7,fill=(90,90,90,180))
        d.rounded_rectangle((42,1168,42+round(638*prog),1182),radius=7,fill=LIME)
    if line==3:
        d.text((43,1198),"DOWNLOAD ≠ PLAY",font=font(27),fill=(210,210,205))
    if line==4:
        d.text((43,1198),"LOCAL MIDNIGHT",font=font(27),fill=WHITE)
    return Image.alpha_composite(im.convert("RGBA"),layer).convert("RGB")

def main():
    print("Generating 6 measured TTS lines",flush=True)
    pieces=[pcm(tts_segment(i,t)) for i,t in enumerate(LINES)]
    pad=bytes(round(.12*SR)*2)
    starts=[]; cursor=0; audio=bytearray()
    for i,p in enumerate(pieces):
        starts.append(cursor/(2*SR))
        audio.extend(p); cursor+=len(p)
        if i<len(pieces)-1: audio.extend(pad); cursor+=len(pad)
    duration=len(audio)/(2*SR)
    write_wav(BASE/"narration.wav",bytes(audio))
    make_music(duration)
    save_json(BASE/"timings.json",{"duration":duration,"voice":VOICE,
       "lines":[{"text":v,"start":starts[i],"end":starts[i]+len(pieces[i])/(2*SR)}
       for i,v in enumerate(LINES)]})
    global CACHE
    CACHE={key:prepared_image(key) for line in IMGS for key in line}
    live={i:live_frames(name) for i,name in LIVE.items()}
    seconds=[len(p)/(2*SR) for p in pieces]
    print("Narration duration",duration,"seconds, voice",VOICE,flush=True)
    subprocess.run(["mkdir","-p",str(OUT.parent)],check=True)
    cmd=["ffmpeg","-y","-v","error","-f","rawvideo","-pix_fmt","rgb24",
         "-s",f"{W}x{H}","-r",str(FPS),"-i","-",
         "-i",str(BASE/"narration.wav"),"-i",str(BASE/"original_music.wav"),
         "-filter_complex","[1:a]volume=1.0[n];[2:a]volume=0.13[m];[n][m]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[a]",
         "-map","0:v","-map","[a]","-c:v","libx264","-preset","fast",
         "-crf","24","-maxrate","2200k","-bufsize","3300k",
         "-pix_fmt","yuv420p","-c:a","aac","-b:a","128k",
         "-movflags","+faststart","-t",f"{duration:.5f}",str(OUT)]
    proc=subprocess.Popen(cmd,stdin=subprocess.PIPE)
    frames=round(duration*FPS)
    for k in range(frames):
        t=k/FPS
        idx=max(i for i,start in enumerate(starts) if t+0.08>=start)
        elapsed=max(0,t-starts[idx])
        prog=min(1,elapsed/max(0.1,seconds[idx]))
        shot=0 if prog<0.53 else 1
        key=IMGS[idx][shot]
        frame=cover(key, (prog/.53 if shot==0 else (prog-.53)/.47))
        # A single brief authentic Rockstar character clip near the end of selected lines.
        if idx in live and shot==1 and live[idx]:
            footage=live[idx]
            local=round((prog-0.53)/0.47*len(footage))
            if 0<=local<len(footage): frame=footage[local]
        frame=caption(frame,idx,prog)
        try:proc.stdin.write(frame.tobytes())
        except BrokenPipeError: raise RuntimeError("Video encoder exited early")
        if k%(FPS*6)==0:print("Rendered",round(t,1),"/",round(duration,1),"s",flush=True)
    proc.stdin.close()
    if proc.wait()!=0: raise RuntimeError("ffmpeg encode failed")
    probe=json.loads(run(["ffprobe","-v","error","-show_format","-of","json",str(OUT)],capture_output=True,text=True).stdout)
    print("OUTPUT",OUT,"BYTES",OUT.stat().st_size,"SECONDS",probe["format"]["duration"],flush=True)
    if OUT.stat().st_size>9000000: raise RuntimeError("Video exceeds 9 MB Git commit limit")
if __name__=="__main__": main()
