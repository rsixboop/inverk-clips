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

def story_graphics(im, line, elapsed, spoken_seconds):
    """Reveal visual proof only as the narration reaches it; never preview the
    next point via persistent lower-third topic summaries."""
    p=max(0,min(1,elapsed/max(0.1,spoken_seconds)))
    overlay=Image.new("RGBA",(W,H),(0,0,0,0))
    d=ImageDraw.Draw(overlay)
    d.rounded_rectangle((37,56,165,96),radius=10,fill=(3,8,12,150))
    d.text((50,63),"GTA VI",font=font(23),fill=LIME)
    def panel(box):
        d.rounded_rectangle(box,radius=19,fill=(11,19,24,185),outline=(136,166,164,90),width=2)
    if line==0:
        # An immediate numeric hook is useful; the extra 'preload space' teaser isn't.
        if p<0.84:
            d.text((38,946),"212 GB",font=font(133),fill=LIME,
                   stroke_width=4,stroke_fill=(5,11,15))
        if p>0.40:
            panel((40,1100,678,1192))
            d.rounded_rectangle((70,1135,651,1162),radius=11,fill=(69,82,89,220))
            width=round(576*min(1,(p-0.40)/0.56))
            if width>4: d.rounded_rectangle((70,1135,70+width,1162),radius=min(11,width//2),fill=LIME)
    elif line==1:
        # Source attribution appears only *after* Rockstar is mentioned.
        if p>0.40:
            panel((55,1000,665,1143))
            d.text((88,1019),"ROCKSTAR",font=font(57),fill=WHITE)
            d.text((88,1091),"OFFICIAL SUPPORT",font=font(27),fill=LIME)
    elif line==2:
        # A stylized download indicator, NOT a fabricated console screenshot.
        if p>0.13:
            panel((42,1023,680,1201))
            d.rounded_rectangle((72,1133,646,1155),radius=10,fill=(65,80,90,230))
            width=round(566*min(1,(p-0.13)/0.85))
            if width>4: d.rounded_rectangle((72,1133,72+width,1155),radius=min(10,width//2),fill=LIME)
        if p>0.44: d.text((92,1050),"PS5",font=font(43),fill=WHITE)
        if p>0.76: d.text((286,1055),"XBOX SERIES",font=font(36),fill=WHITE)
    elif line==3:
        # An actual lock illustrates 'can't play early'. No words spoil the line.
        if p>0.43:
            panel((243,832,485,1114))
            d.arc((299,876,429,1009),180,360,fill=WHITE,width=16)
            d.rounded_rectangle((290,948,440,1067),radius=15,fill=(40,50,58,240),outline=LIME,width=6)
            d.ellipse((360,980,370,990),fill=WHITE)
            d.rectangle((362,990,367,1023),fill=WHITE)
    elif line==4:
        # NOV 19 appears *during* that exact phrase, not before the narrator.
        if p>0.39:
            panel((104,892,629,1093))
            d.text((135,920),"NOV 19",font=font(102),fill=LIME)
        if p>0.77:
            cx,cy=551,1144
            d.ellipse((cx-43,cy-43,cx+43,cy+43),fill=(17,27,31,220),outline=WHITE,width=5)
            d.line((cx,cy,cx,cy-30),fill=WHITE,width=5)
            d.line((cx,cy,cx+27,cy),fill=LIME,width=5)
    elif line==5:
        # Viewer sees a game library and a choice about deleting one title,
        # instead of two GTA characters with no link to the spoken question.
        if p>0.08:
            panel((36,781,680,1171))
            palette=[(69,136,171),(124,105,188),(176,113,93)]
            for j,c in enumerate(palette):
                x=67+j*199
                d.rounded_rectangle((x,828,x+167,1036),radius=13,fill=c)
                d.line((x+18,856,x+149,1006),fill=(224,233,234,170),width=7)
                d.line((x+142,862,x+30,999),fill=(24,39,58,155),width=10)
            if p>0.48:
                d.rounded_rectangle((252,814,454,1051),radius=14,outline=LIME,width=7)
                d.rounded_rectangle((316,1080,404,1152),radius=12,fill=(177,61,69,240))
                d.rectangle((348,1094,374,1136),fill=WHITE)
                d.line((343,1089,379,1089),fill=WHITE,width=6)
    return Image.alpha_composite(im.convert("RGBA"),overlay).convert("RGB")

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
