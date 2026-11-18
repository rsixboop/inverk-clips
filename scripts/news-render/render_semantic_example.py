"""Reproducible overlay-only revision: decode existing cuts, copy original AAC."""
import json, subprocess
from pathlib import Path
from PIL import Image
from semantic_overlays import validate_cues, load_states, composite

ROOT=Path(__file__).resolve().parents[2]
SOURCE=ROOT/"public/gta6_212gb_news.mp4"
OUT=ROOT/"public/gta6_212gb_semantic.mp4"

def main():
    probe=json.loads(subprocess.check_output(["ffprobe","-v","error","-show_format","-show_streams","-of","json",str(SOURCE)]))
    video=next(s for s in probe["streams"] if s["codec_type"]=="video")
    w,h=video["width"],video["height"]
    n,d=map(int,video["r_frame_rate"].split("/"));fps=n/d
    cues=validate_cues(json.loads((ROOT/"scripts/news-render/size212/semantic-cues.json").read_text()),float(probe["format"]["duration"]))
    states=load_states(cues,ROOT/"public")
    decoder=subprocess.Popen(["ffmpeg","-v","error","-i",str(SOURCE),"-f","rawvideo","-pix_fmt","rgb24","-"],stdout=subprocess.PIPE)
    encoder=subprocess.Popen(["ffmpeg","-y","-v","error","-f","rawvideo","-pix_fmt","rgb24","-s",f"{w}x{h}","-r",str(fps),"-i","-","-i",str(SOURCE),"-map","0:v","-map","1:a","-c:v","libx264","-preset","fast","-crf","23","-pix_fmt","yuv420p","-c:a","copy","-movflags","+faststart",str(OUT)],stdin=subprocess.PIPE)
    count=0
    try:
        while True:
            raw=decoder.stdout.read(w*h*3)
            if not raw:break
            if len(raw)!=w*h*3:raise RuntimeError("Partial decoded frame")
            image=Image.frombytes("RGB",(w,h),raw)
            encoder.stdin.write(composite(image,cues,states,count/fps).tobytes());count+=1
        encoder.stdin.close()
        if decoder.wait() or encoder.wait():raise RuntimeError("FFmpeg failed")
    finally:
        if decoder.poll() is None:decoder.kill()
        if encoder.poll() is None:encoder.kill()
    manifest={"source":str(SOURCE.relative_to(ROOT)),"output":str(OUT.relative_to(ROOT)),"frames":count,"fps":fps,"audio":"original AAC stream copied, no TTS or remix","overlay_cues":cues}
    (ROOT/"scripts/news-render/size212/semantic-manifest.json").write_text(json.dumps(manifest,indent=2))
    print(json.dumps(manifest,indent=2));print("BYTES",OUT.stat().st_size)
if __name__=="__main__":main()