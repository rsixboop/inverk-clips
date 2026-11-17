#!/usr/bin/env python3
"""Reusable, style-aware, AI-generated cinematic motion assets for news shorts.

Call ensure_assets(requests, style): for each semantic beat choose a verified
library clip or generate a coherent image -> 5s AI video. A durable queue ID is
written before polling, with an ambiguity barrier for paid submissions. Every
accepted asset is checked for real image motion and stored in index.json.
The consuming renderer can invoke this automatically with no manual steps.
"""
from __future__ import annotations
import hashlib, json, os, subprocess, time, urllib.request
from pathlib import Path
from PIL import Image, ImageChops, ImageStat
ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent
LIB=ROOT/"public/generated-assets"
INDEX=LIB/"index.json"
JOBS=HERE/".asset-requests"
STYLE_FILE=HERE/"asset-styles.json"
IMAGE_MODEL="fal-ai/nano-banana"
VIDEO_MODEL="fal-ai/kling-video/v2.5-turbo/pro/image-to-video"
COST_IMAGE=0.04
COST_VIDEO=0.35
MAX_ASSETS=8
BUDGET_USD=float(os.environ.get("ASSET_BUDGET_USD","6"))
def save(path, obj):
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_name(path.name+".tmp")
    tmp.write_text(json.dumps(obj,indent=2,ensure_ascii=False)+"\n")
    os.replace(tmp,path)
def load(path,default):
    return json.loads(path.read_text()) if path.exists() else default
def styles():
    return load(STYLE_FILE,{})["presets"]
def style_signature(style):
    return hashlib.sha256(json.dumps(style,sort_keys=True).encode()).hexdigest()[:12]
def asset_id(key,style_sig):
    return hashlib.sha256((key+"|"+style_sig).encode()).hexdigest()[:14]
def prompt_for(req,style):
    parts=[f"Create a production-grade original cinematic EDITORIAL ASSET. Precise visual intent: {req['intent']}.",
           f"Scene design: {req['scene']}.",
           f"Art direction: {style['label']}. Palette: {', '.join(style['palette'])}.",
           f"Materials: {style['materials']}. Environment: {style['environment']}. Lighting: {style['lighting']}.",
           "Portrait 9:16 composition for mobile, gorgeous coherent product cinematography, single main visual action, detailed surface textures, polished high-budget game marketing aesthetic.",
           "This is an ORIGINAL illustrative visualization, NOT a purported real game screenshot.",
           f"Absolutely avoid: {style['negative']}, any captions, logos, game characters, letters, numbers, textual UI."]
    return " ".join(parts)
def motion_prompt(req,style):
    return ("Make this EXACT existing graphic come to life in a coherent continuous 5-second cinematic shot. "
            +req["motion"]+". "+style["motion"]+". "
            "The primary visual remains completely recognizable and physically stable. "
            "Show a clear beginning, changing middle, and meaningful visual end-state, with fluid photorealistic animation. "
            "No letters, no talking faces, no flickering/morphing, no unwanted objects, no abrupt jump cut, no logos, no watermark.")
def jreq(url,headers=None,data=None):
    req=urllib.request.Request(url,headers=headers or {},data=data)
    with urllib.request.urlopen(req,timeout=40) as res:
        return json.loads(res.read().decode())
def queue(model,payload,jobkey):
    """One paid request once; never resubmit after an unknown response."""
    key=os.environ.get("FAL_KEY")
    if not key: raise RuntimeError("FAL_KEY is required only for missing assets")
    job=JOBS/(jobkey+".json")
    state=load(job,{})
    headers={"Authorization":"Key "+key,"Content-Type":"application/json"}
    if state.get("status")=="submitting":
        raise RuntimeError(f"Unknown paid submission outcome for {jobkey}: do not blindly retry")
    if state.get("status")=="done":
        return state["result"]
    if not state.get("request_id"):
        save(job,{"status":"submitting","model":model})
        try:
            res=jreq("https://queue.fal.run/"+model,headers,json.dumps(payload).encode())
        except Exception as e:
            # Deliberately keep 'submitting' if network error happened after send.
            raise RuntimeError(f"Paid submit ambiguous for {jobkey}: {type(e).__name__}") from e
        rid=res.get("request_id")
        if not isinstance(rid,str) or len(rid)<8:
            raise RuntimeError("Provider did not return a durable request ID")
        save(job,{"status":"submitted","model":model,"request_id":rid})
        state=load(job,{})
    rid=state["request_id"]
    base=f"https://queue.fal.run/{'/'.join(model.split('/')[:2])}/requests/{rid}"
    for tries in range(150):
        st=jreq(base+"/status",headers)
        if st.get("status")=="COMPLETED":
            result=jreq(base,headers)
            if result.get("error"): raise RuntimeError(f"Provider failed {jobkey} (inspect request ID)")
            save(job,{"status":"done","model":model,"request_id":rid,"result":result})
            return result
        if st.get("status") not in ("IN_QUEUE","IN_PROGRESS"):
            raise RuntimeError(f"Provider returned {st.get('status')} for {jobkey}")
        time.sleep(3)
    raise RuntimeError(f"Still processing: {jobkey}; request ID saved for next run")
def download(url,path):
    if not url.startswith("https://") or not any(domain in url.split("/")[2] for domain in ("fal.media","fal.run","storage.googleapis.com")):
        raise RuntimeError("Unexpected asset host")
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_name(path.name+".partial")
    urllib.request.urlretrieve(url,tmp)
    if tmp.stat().st_size<3000: raise RuntimeError("Empty asset downloaded")
    tmp.replace(path)
def still_quality(path):
    with Image.open(path) as im:
        if im.width<512 or im.height<512: return False, "too_small"
        im=im.convert("RGB").resize((160,160))
        stat=ImageStat.Stat(im)
        if min(stat.stddev)<12 and sum(stat.stddev)<64: return False,"flat_image"
    return True,"ok"
def video_quality(path):
    p=subprocess.run(["ffprobe","-v","error","-show_entries","stream=codec_name,width,height,duration:format=duration",
                      "-of","json",str(path)],capture_output=True,text=True,check=True)
    o=json.loads(p.stdout)
    streams=o.get("streams",[])
    videos=[s for s in streams if s.get("codec_name") in ("h264","hevc","vp9","av1")]
    if not videos:return False,"no_video",0
    duration=float(o.get("format",{}).get("duration",0))
    if duration<4.4: return False,"short_video",duration
    # Compare 3 samples of the video to avoid accepting static/nonmoving outputs.
    previews=[]
    for t in (0.4,2.4,4.4):
        proc=subprocess.run(["ffmpeg","-nostdin","-v","error","-ss",str(t),"-i",str(path),
          "-frames:v","1","-vf","scale=160:284","-pix_fmt","rgb24","-f","rawvideo","-"],capture_output=True)
        if len(proc.stdout)!=160*284*3:return False,"decode_failed",duration
        previews.append(Image.frombytes("RGB",(160,284),proc.stdout))
    differences=[ImageStat.Stat(ImageChops.difference(previews[i],previews[i+1])).mean for i in range(2)]
    motion=sum(sum(x)/3 for x in differences)/2
    return motion>1.6, f"motion={motion:.2f}",duration
def reuse_score(entry,req,style_id,sig,episode_id=""):
    if entry.get("semantic_key")!=req["semantic_key"]:return -1
    if entry.get("style_id")!=style_id or entry.get("style_signature")!=sig:return -1
    if entry.get("status")!="auto_validated":return -1
    if entry.get("reuse_count",0)>=entry.get("max_reuse",4) and episode_id not in entry.get("used_in_episodes",[]):return -1
    if not (ROOT/entry["video_path"]).exists():return -1
    if entry.get("quality",0)<0.73:return -1
    return 100+entry["quality"]*10-entry.get("reuse_count",0)*3
def ensure_assets(requests:list[dict],style_id:str="vice-neon",budget_usd:float=BUDGET_USD,episode_id:str=""):
    if len(requests)>MAX_ASSETS:raise ValueError(f"Max {MAX_ASSETS} assets per episode")
    presets=styles()
    if style_id not in presets:raise ValueError(f"Unknown style {style_id}")
    style=presets[style_id]; sig=style_signature(style)
    LIB.mkdir(parents=True,exist_ok=True)
    index=load(INDEX,{"schema_version":1,"assets":[],"total_generated":0})
    used=set(); selected=[]; spent=0
    for req in requests:
        if not all(req.get(k) for k in ("semantic_key","intent","scene","motion")):
            raise ValueError("Asset request missing semantic_key/intent/scene/motion")
        candidates=sorted([(reuse_score(a,req,style_id,sig,episode_id),a) for a in index["assets"]],
                          key=lambda x:x[0],reverse=True)
        best=next((a for score,a in candidates if score>=0 and a["id"] not in used),None)
        if best:
            if episode_id and episode_id not in best.get("used_in_episodes",[]):
                best.setdefault("used_in_episodes",[]).append(episode_id)
                best["reuse_count"]=best.get("reuse_count",0)+1
            elif not episode_id:
                best["reuse_count"]=best.get("reuse_count",0)+1
            best["last_used_on"]=time.strftime("%Y-%m-%d")
            save(INDEX,index);selected.append(best);used.add(best["id"])
            print("REUSE",req["semantic_key"],best["id"],flush=True)
            continue
        if spent+COST_IMAGE+COST_VIDEO>budget_usd:
            raise RuntimeError(f"Asset budget cap reached at {spent:.2f} USD")
        # Regenerate only if style / semantic / quality changed. Failed variants
        # use incrementing suffixes, with no unbounded automatic retry.
        key=req["semantic_key"].lower().replace(" ","-").replace("_","-")
        same=[a for a in index["assets"] if a["semantic_key"]==req["semantic_key"] and a["style_signature"]==sig]
        pending=next((a for a in same if a.get("status")=="pending"),None)
        # Resume an interrupted image/video job from its stored queue request IDs.
        # Never create a second paid variation just because the first one is pending.
        if pending:
            base=pending
            ident=base["id"]
            image_path=ROOT/base["image_path"]; video_path=ROOT/base["video_path"]
            prompt=base["prompt"]; mp=base["motion_prompt"]
        else:
            attempts=len(same)
            if attempts>=2: raise RuntimeError(f"No acceptable variant for {key} after 2 attempts; no paid retry")
            ident=asset_id(key+"-"+str(attempts),sig)
            folder=LIB/style_id/ident;folder.mkdir(parents=True,exist_ok=True)
            image_path=folder/"plate.png"; video_path=folder/"motion.mp4"
            prompt=prompt_for(req,style);mp=motion_prompt(req,style)
            base={"id":ident,"semantic_key":req["semantic_key"],"intent":req["intent"],"style_id":style_id,
                  "style_signature":sig,"image_path":str(image_path.relative_to(ROOT)),
                  "video_path":str(video_path.relative_to(ROOT)),"status":"pending",
                  "reuse_count":0,"max_reuse":style["max_reuse"],
                  "quality":0,"prompt":prompt,"motion_prompt":mp,
                  "created_at":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime())}
            index["assets"].append(base);save(INDEX,index)
        try:
            if not image_path.exists():
                result=queue(IMAGE_MODEL,{"prompt":prompt,"num_images":1,"aspect_ratio":"9:16","output_format":"png"},ident+"-image")
                download(result["images"][0]["url"],image_path)
            q,detail=still_quality(image_path)
            if not q:raise RuntimeError("Image QC failed: "+detail)
            if not video_path.exists():
                image_url=queue(IMAGE_MODEL,{"prompt":prompt,"num_images":1,"aspect_ratio":"9:16","output_format":"png"},ident+"-image")["images"][0]["url"]
                result=queue(VIDEO_MODEL,{"prompt":mp,"image_url":image_url,"duration":"5","negative_prompt":"text, watermark, logo, deformed objects, morphing, blurry, distorted"},ident+"-motion")
                raw=video_path.with_name("motion_source.mp4")
                download(result["video"]["url"],raw)
                # Normalize to a Git-trackable 720p vertical clip, preserving
                # motion and making all reusable clips the same media format.
                subprocess.run(["ffmpeg","-y","-nostdin","-v","error","-i",str(raw),
                   "-vf","scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=30,setsar=1",
                   "-an","-c:v","libx264","-preset","fast","-crf","25",
                   "-maxrate","2600k","-bufsize","3900k","-pix_fmt","yuv420p",str(video_path)],check=True)
                raw.unlink(missing_ok=True)
            ok,detail,length=video_quality(video_path)
            if not ok:raise RuntimeError("Animation QC failed: "+detail)
            base.update(status="auto_validated",quality=0.8,duration=length,technical_qc=detail,reuse_count=1,
                        used_in_episodes=[episode_id] if episode_id else [])
            index["total_generated"]+=1
            spent+=COST_IMAGE+COST_VIDEO
            selected.append(base);used.add(ident)
            print("GENERATED",key,ident,detail,flush=True)
        except Exception as e:
            base.update(status="rejected",error=str(e)[:300])
            save(INDEX,index)
            raise
        save(INDEX,index)
    return selected,round(spent,2)
if __name__=="__main__":
    import sys
    specs=json.loads(Path(sys.argv[1]).read_text())
    result,cost=ensure_assets(specs,sys.argv[2] if len(sys.argv)>2 else "vice-neon")
    print(json.dumps({"assets":[v["video_path"] for v in result],"estimated_new_spend_usd":cost},indent=2))
