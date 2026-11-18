#!/usr/bin/env python3
"""One-command end-to-end GTA news production: narration -> semantic reuse/generation
of 5-second motion assets -> narrator-paced montage -> music -> shareable MP4.
No manually prepared icons, no extra UI, no hidden paid retries.
Use: python3 scripts/news-render/make_episode.py scripts/news-render/episodes/ps5-immersive.json
"""
from __future__ import annotations
import json, os, sys, subprocess, wave, hashlib
from pathlib import Path
from auto_assets import ROOT, ensure_assets, queue, download, load, save
HERE=Path(__file__).resolve().parent
SR=48000
def run(args,**kwargs):
    return subprocess.run(args,check=True,**kwargs)
def probe(path):
    r=run(["ffprobe","-v","error","-of","json","-show_entries",
           "format=duration,size:stream=width,height,codec_name",str(path)],
          text=True,capture_output=True)
    return json.loads(r.stdout)
def read_pcm(path):
    p=run(["ffmpeg","-nostdin","-v","error","-i",str(path),"-f","s16le","-ar",str(SR),
            "-ac","1","-"],capture_output=True)
    if not p.stdout:raise RuntimeError("Empty voice audio")
    return p.stdout
def write_pcm(path,pcm):
    with wave.open(str(path),"wb") as w:
        w.setframerate(SR);w.setnchannels(1);w.setsampwidth(2);w.writeframes(pcm)
def render(config):
    ep=json.loads(Path(config).read_text())
    if ep.get("mode") == "overlay":
        # SAME production entrypoint; an overlay video never invokes the old
        # image-to-video/fullscreen-scene branch.
        from render_overlay_news import make_episode as render_overlay_episode
        return render_overlay_episode(config)
    if not ep.get("source_url","").startswith("https://www.rockstargames.com/"):
        raise RuntimeError("Episode must be grounded in an official Rockstar URL")
    if not ep.get("source_claims"):raise RuntimeError("No source-checked claims")
    scenes=ep["scenes"]
    if not 4<=len(scenes)<=7:raise RuntimeError("Only 4–7 precise content beats per episode")
    project=ep["id"]
    work=HERE/"episode-state"/project;work.mkdir(parents=True,exist_ok=True)
    audio=[]; dur=[]
    print("VOICE",len(scenes),"scenes",flush=True)
    # Narrator first. TTS ID is persisted and reused after an interrupted session.
    for i,scene in enumerate(scenes):
        text=scene["narration"]
        file=work/f"voice_{i+1}.wav"
        if not file.exists():
            payload={"prompt":text,"voice":ep.get("voice","am_fenrir"),"speed":1.14}
            key=hashlib.sha256((project+":"+str(i)+":"+text).encode()).hexdigest()[:16]
            r=queue("fal-ai/kokoro/american-english",payload,key+"-tts")
            url=r.get("audio",{}).get("url")
            if not url:raise RuntimeError("TTS audio URL missing")
            download(url,file)
        pcm=read_pcm(file);length=len(pcm)/(2*SR)
        if length>4.75:raise RuntimeError(f"Narration {i+1} takes {length:.2f}s; shorten this line before consuming visual assets")
        audio.append(pcm)
        dur.append(max(3.3,length+0.22))
        print("VOICE_LENGTH",i+1,round(length,2),"SCENE",round(dur[-1],2),flush=True)
    # The style-aware library automatically checks whether each concept already
    # exists at a matching quality/style before it spends on a new animation.
    asset_scenes=[s for s in scenes if "asset" in s]
    assets,spent=ensure_assets([s["asset"] for s in asset_scenes],
                               ep.get("style","vice-neon"),ep.get("max_asset_spend_usd",5),episode_id=project)
    if len(assets)<4:raise RuntimeError("Minimum 4 genuine generated motion assets required")
    print("ASSET_SELECTION",len(assets),"estimated new spend",spent,flush=True)
    # Real sourced imagery can open the video; the remaining four animated
    # explanatory clips are always from the AI-generated reusable library.
    parts=[]; asset_by_scene=[]; ai=iter(assets)
    for i,(scene,length) in enumerate(zip(scenes,dur)):
        cut=work/f"shot_{i:02}.mp4"
        source=scene.get("stock_image")
        if source:
            if source not in ("vc16","vc14","vc01","vc11","vc02"):
                raise RuntimeError("Unverified official intro image: "+str(source))
            image=ROOT/"public/gta6-media"/(source+".jpg")
            if not image.exists():raise RuntimeError("Missing official source image")
            font=subprocess.run(["fc-match","-f","%{file}","DejaVu Sans:style=Bold"],
                                text=True,capture_output=True,check=True).stdout.strip()
            filters=("scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,"
                     "zoompan=z='min(zoom+0.0007,1.10)':x='iw/2-(iw/zoom/2)':"
                     "y='ih/2-(ih/zoom/2)':d=1:s=720x1280:fps=30,"
                     "drawtext=fontfile='"+font+"':text='GTA VI / PS5':"
                     "x=42:y=970:fontsize=65:fontcolor=white:borderw=3:"
                     "bordercolor=black:enable='lt(t,4.0)'")
            run(["ffmpeg","-y","-nostdin","-v","error","-loop","1","-framerate","30",
                 "-t",f"{length:.4f}","-i",str(image),"-vf",filters,
                 "-an","-c:v","libx264","-preset","fast","-crf","25",
                 "-maxrate","1700k","-bufsize","2600k","-pix_fmt","yuv420p",str(cut)])
            asset_by_scene.append({"type":"official_still","id":source,"video":None})
        else:
            asset=next(ai)
            path=ROOT/asset["video_path"]
            if float(asset.get("duration",0))<length-0.02:
                raise RuntimeError(f"Asset {asset['id']} shorter than narrator line")
            run(["ffmpeg","-y","-nostdin","-v","error","-i",str(path),"-t",f"{length:.4f}",
                 "-vf","scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=30,setsar=1",
                 "-an","-c:v","libx264","-preset","fast","-crf","25",
                 "-maxrate","1700k","-bufsize","2600k","-pix_fmt","yuv420p",
                 "-movflags","+faststart",str(cut)])
            asset_by_scene.append({"type":"generated_motion","id":asset["id"],
                                   "semantic_key":asset["semantic_key"],
                                   "video":asset["video_path"],"qc":asset.get("technical_qc")})
        parts.append(cut)
    listing=work/"concat.txt"
    listing.write_text("".join("file '"+str(p.resolve()).replace("'","")+"'\n" for p in parts))
    visual=work/"visual.mp4"
    run(["ffmpeg","-y","-nostdin","-v","error","-f","concat","-safe","0","-i",str(listing),
         "-c","copy",str(visual)])
    # Exact measured silence between phrases; no subject labels or captions
    # anticipating the next line. Assets are the narration's illustrations.
    packed=bytearray()
    starts=[]
    for i,(pcm,length) in enumerate(zip(audio,dur)):
        starts.append(len(packed)/(2*SR))
        packed.extend(pcm)
        remainder=int(length*SR)-len(pcm)//2
        if remainder<0:raise RuntimeError("negative voice padding")
        packed.extend(bytes(2*remainder))
    spoken=work/"narration.wav";write_pcm(spoken,packed)
    score=HERE/"size212/original_music.wav"
    if not score.exists():raise RuntimeError("Original royalty-free project score is missing")
    outfile=ROOT/ep["output"];outfile.parent.mkdir(parents=True,exist_ok=True)
    total=len(packed)/(2*SR)
    # Voice-forward mix, gently engaging synth score, no stock GTA soundtrack.
    run(["ffmpeg","-y","-nostdin","-v","error","-i",str(visual),"-i",str(spoken),
         "-stream_loop","-1","-i",str(score),
         "-filter_complex",
         "[1:a]highpass=f=78,acompressor=threshold=0.12:ratio=2.1:attack=9:release=120[v];"
         "[2:a]volume=0.25,lowpass=f=6500,afade=t=in:st=0:d=0.6[m];"
         "[v][m]amix=inputs=2:duration=first:weights='1 0.5':normalize=0,"
         "loudnorm=I=-16:TP=-1.5:LRA=9[a]",
         "-map","0:v","-map","[a]","-c:v","copy","-c:a","aac","-b:a","144k",
         "-movflags","+faststart","-t",f"{total:.4f}",str(outfile)])
    metadata={"id":project,"source_url":ep["source_url"],"style":ep.get("style","vice-neon"),
              "output":str(outfile.relative_to(ROOT)),"duration":round(total,2),
              "assets":[{**a,"narration":sc["narration"],"at":round(t,2)}
                         for a,sc,t in zip(asset_by_scene,scenes,starts)],
              "estimated_new_asset_spend_usd":spent}
    save(work/"episode-manifest.json",metadata)
    check=probe(outfile)
    secs=float(check["format"]["duration"])
    if abs(secs-total)>0.25:raise RuntimeError("Render and speech lengths do not agree")
    if outfile.stat().st_size>9_000_000:raise RuntimeError("MP4 over 9MB Git transport limit")
    run(["ffmpeg","-v","error","-i",str(outfile),"-f","null","-"],
         capture_output=True)
    print("SUCCESS",metadata["output"],"DURATION",round(secs,2),"BYTES",
          outfile.stat().st_size,"ASSETS",len(assets),"COST_EST",spent,flush=True)
    return metadata
if __name__=="__main__":
    if len(sys.argv)<2:raise SystemExit("Usage: make_episode.py <episode.json>")
    render(sys.argv[1])
