"""Reproducible overlay-only revision: decode existing cuts, copy original AAC."""
import json, subprocess, sys
from pathlib import Path
from PIL import Image
from semantic_overlays import validate_cues, load_states, composite

ROOT=Path(__file__).resolve().parents[2]
SOURCE=ROOT/"public/gta6_212gb_news.mp4"
OUT=ROOT/"public/gta6_212gb_semantic.mp4"

def heal(image,rect):
    """Remove a thin baked strip: per-column blend of rows just above/below, lightly blurred."""
    from PIL import ImageFilter
    x,y,w,h=rect; px=image.load()
    for cx in range(x,x+w):
        top,bot=px[cx,y-1],px[cx,y+h]
        for i in range(h):
            t=(i+1)/(h+1); px[cx,y+i]=tuple(round(top[k]*(1-t)+bot[k]*t) for k in range(3))
    patch=image.crop((x-4,y-4,x+w+4,y+h+4)).filter(ImageFilter.GaussianBlur(2.5))
    image.paste(patch.crop((4,2,w+4,h+6)),(x,y-2));return image

def main():
    probe=json.loads(subprocess.check_output(["ffprobe","-v","error","-show_format","-show_streams","-of","json",str(SOURCE)]))
    video=next(s for s in probe["streams"] if s["codec_type"]=="video")
    w,h=video["width"],video["height"]
    n,d=map(int,video["r_frame_rate"].split("/"));fps=n/d
    # Optional spec: {"output","erase":[{rect:[x,y,w,h],start,end}],"cues":[...]} ; default = legacy demo.
    spec_path=ROOT/(sys.argv[1] if len(sys.argv)>1 else "scripts/news-render/size212/semantic-cues.json")
    spec=json.loads(spec_path.read_text())
    if isinstance(spec,list): spec={"cues":spec}
    out=ROOT/spec["output"] if spec.get("output") else OUT
    erase=spec.get("erase",[])
    cues=validate_cues(spec["cues"],float(probe["format"]["duration"]))
    states=load_states(cues,ROOT/"public")
    decoder=subprocess.Popen(["ffmpeg","-v","error","-i",str(SOURCE),"-f","rawvideo","-pix_fmt","rgb24","-"],stdout=subprocess.PIPE)
    encoder=subprocess.Popen(["ffmpeg","-y","-v","error","-f","rawvideo","-pix_fmt","rgb24","-s",f"{w}x{h}","-r",str(fps),"-i","-","-i",str(SOURCE),"-map","0:v","-map","1:a","-c:v","libx264","-preset","fast","-crf","23","-pix_fmt","yuv420p","-c:a","copy","-movflags","+faststart",str(out)],stdin=subprocess.PIPE)
    count=0
    try:
        while True:
            raw=decoder.stdout.read(w*h*3)
            if not raw:break
            if len(raw)!=w*h*3:raise RuntimeError("Partial decoded frame")
            image=Image.frombytes("RGB",(w,h),raw)
            for e in erase:
                if e["start"]<=count/fps<e["end"]: image=heal(image,e["rect"])
            encoder.stdin.write(composite(image,cues,states,count/fps).tobytes());count+=1
        encoder.stdin.close()
        if decoder.wait() or encoder.wait():raise RuntimeError("FFmpeg failed")
    finally:
        if decoder.poll() is None:decoder.kill()
        if encoder.poll() is None:encoder.kill()
    manifest={"source":str(SOURCE.relative_to(ROOT)),"output":str(out.relative_to(ROOT)),"erase":erase,"frames":count,"fps":fps,"audio":"original AAC stream copied, no TTS or remix","overlay_cues":cues}
    spec_path.with_name(spec_path.stem.replace("-cues","")+"-manifest.json").write_text(json.dumps(manifest,indent=2))
    print("FRAMES",count,"BYTES",out.stat().st_size)
if __name__=="__main__":main()