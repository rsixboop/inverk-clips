#!/usr/bin/env python3
"""Inverk Clips live recorder worker (run on your own machine/VPS; needs ffmpeg + streamlink or yt-dlp).

Records ONLY streams you own or are authorized to record (monitors with confirmed rights). Keeps a rolling
buffer of 10 s MPEG-TS segments per live monitor, claims due chat-spike highlights from the app, cuts the
pre/post window with original audio, renders a contextual 1080x1920 vertical (full frame over blurred fill),
uploads to a one-time signed URL and reports completion. Recording-URL monitors are cut by stream offset.

  INVERK_URL=https://prompt-to-pocket-clips.lovable.app INVERK_WORKER_TOKEN=lrw_... python3 recorder.py
"""
import calendar, glob, json, os, shutil, signal, subprocess, sys, tempfile, time, urllib.request

APP = os.environ.get("INVERK_URL", "").rstrip("/"); TOKEN = os.environ.get("INVERK_WORKER_TOKEN", "")
BUF = os.environ.get("INVERK_BUFFER_DIR", os.path.join(tempfile.gettempdir(), "inverk-live"))
KEEP_S = int(os.environ.get("INVERK_KEEP_SECONDS", "900")); SEG = 10
procs = {}  # monitor id -> (Popen, record_url)

def api(action, **kw):
    req = urllib.request.Request(f"{APP}/api/public/live/worker", data=json.dumps({"action": action, **kw}).encode(),
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r: return json.load(r)
    except urllib.error.HTTPError as e: return {"error": f"{e.code} {e.read()[:200]!r}"}

def grabber(url):
    if shutil.which("streamlink"): return ["streamlink", "--stdout", "--hls-live-edge", "2", url, "best"]
    return ["yt-dlp", "-q", "-f", "best", "--no-part", "-o", "-", url]

def start_buffer(m):
    d = os.path.join(BUF, m["id"]); os.makedirs(d, exist_ok=True)
    src = subprocess.Popen(grabber(m["record_url"]), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    ff = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-c", "copy", "-f", "segment", "-segment_time", str(SEG),
                           "-reset_timestamps", "1", "-strftime", "1", os.path.join(d, "seg_%s.ts")], stdin=src.stdout, stderr=subprocess.DEVNULL)
    procs[m["id"]] = (ff, src, m["record_url"]); print("buffering", m["record_url"], flush=True)

def sync_monitors():
    ms = api("monitors").get("monitors", [])
    live = {m["id"]: m for m in ms if m["media_mode"] == "recorder" and m["status"] == "live" and m.get("record_url")}
    for mid, (ff, src, url) in list(procs.items()):
        if mid not in live or ff.poll() is not None or live[mid]["record_url"] != url:
            for p in (ff, src): p.send_signal(signal.SIGTERM)
            del procs[mid]
    for mid, m in live.items():
        if mid not in procs: start_buffer(m)
    for d in glob.glob(os.path.join(BUF, "*", "seg_*.ts")):  # prune old segments
        if time.time() - int(os.path.basename(d)[4:-3]) > KEEP_S: os.remove(d)
    return {m["id"]: m for m in ms}

VERT = ("[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2,eq=brightness=-0.08[bg];"
        "[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]")

def render(inp_args, dur, out):
    cmd = ["ffmpeg", "-loglevel", "error", "-y", *inp_args, "-t", f"{dur:.2f}", "-filter_complex", VERT, "-map", "[v]", "-map", "0:a:0",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-r", "30", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out]
    subprocess.run(cmd, check=True, timeout=600)

def iso_ts(s): return calendar.timegm(time.strptime(s[:19], "%Y-%m-%dT%H:%M:%S"))

def process(h, mon):
    start, end = iso_ts(h["start_at"]), iso_ts(h["end_at"]); dur = end - start
    with tempfile.TemporaryDirectory() as t:
        out = os.path.join(t, "clip.mp4")
        if mon["media_mode"] == "recording_url":
            if h.get("offset_s") is None: return api("fail", id=h["id"], claim=h["claim"], error="Неизвестно время начала эфира — нельзя найти момент в записи", retryable=False)
            render(["-ss", str(float(h["offset_s"])), "-i", mon["record_url"]], dur, out)
        else:
            segs = sorted(glob.glob(os.path.join(BUF, h["monitor_id"], "seg_*.ts")), key=lambda p: int(os.path.basename(p)[4:-3]))
            use = [p for p in segs if int(os.path.basename(p)[4:-3]) + SEG > start and int(os.path.basename(p)[4:-3]) < end]
            if not use or int(os.path.basename(use[0])[4:-3]) > start + 2 or int(os.path.basename(use[-1])[4:-3]) + SEG < end - 2:
                return api("fail", id=h["id"], claim=h["claim"], error="В буфере рекордера нет полного окна (эфир не записывался в этот момент)", retryable=False)
            lst = os.path.join(t, "list.txt"); open(lst, "w").write("".join(f"file '{p}'\n" for p in use))
            render(["-f", "concat", "-safe", "0", "-i", lst, "-ss", f"{max(0, start - int(os.path.basename(use[0])[4:-3])):.2f}"], dur, out)
        data = open(out, "rb").read()
        req = urllib.request.Request(h["upload_url"], data=data, method="PUT", headers={"Content-Type": "video/mp4", "x-upsert": "true"})
        urllib.request.urlopen(req, timeout=300).read()
        print("uploaded", h["id"], len(data), api("complete", id=h["id"], claim=h["claim"]), flush=True)

def main():
    if not APP or not TOKEN: sys.exit("Set INVERK_URL and INVERK_WORKER_TOKEN")
    for tool in ("ffmpeg",):
        if not shutil.which(tool): sys.exit(f"{tool} not found")
    if not (shutil.which("streamlink") or shutil.which("yt-dlp")): print("warning: no streamlink/yt-dlp — only recording-URL monitors work", flush=True)
    while True:
        try:
            mons = sync_monitors()
            for h in api("claim").get("highlights", []):
                try: process(h, mons.get(h["monitor_id"], {"media_mode": "recorder"}))
                except Exception as e: api("fail", id=h["id"], claim=h["claim"], error=str(e)[:280], retryable=True)
        except Exception as e: print("loop error", e, flush=True)
        time.sleep(10)

if __name__ == "__main__": main()
