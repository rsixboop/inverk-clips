#!/usr/bin/env python3
"""Inverk Clips live recorder (Windows / macOS / Linux). Run it on your own PC for streams you own or may record.

Keeps a rolling buffer of 10 s MPEG-TS segments per recorder monitor (Streamlink -> ffmpeg, stream copy),
claims due chat-spike highlights, cuts 20 s before the spike to 15 s after it with the original audio,
renders a 1080x1920 vertical MP4, uploads it to a one-time signed URL and reports heartbeat/buffer/errors.

The worker token is asked once (hidden input) and stored in your user profile, never printed or logged.
Windows: start inverk-recorder.bat (downloaded from Sources). Others: INVERK_URL=https://... python3 recorder.py
"""
import base64, calendar, csv, getpass, glob, json, os, shutil, subprocess, sys, tempfile, threading, time, urllib.error, urllib.request

VERSION = "2.1"
SEG, PRE, POST = 10, 20, 15
KEEP_S = int(os.environ.get("INVERK_KEEP_SECONDS", "900"))
IS_WIN = os.name == "nt"
NOWIN = 0x08000000 if IS_WIN else 0  # CREATE_NO_WINDOW: child consoles never pop up
CFG_DIR = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~/.config"), "InverkClips")
CFG = os.path.join(CFG_DIR, "config.json")
BUF = os.environ.get("INVERK_BUFFER_DIR", os.path.join(tempfile.gettempdir(), "inverk-live"))
APP = TOKEN = ""
FFMPEG = STREAMLINK = None
procs = {}   # monitor id -> Session
errors = {}  # monitor id -> last capture error
retry_at, fails = {}, {}  # reconnect backoff per monitor
done = set() # highlight ids already uploaded in this run (server also dedups by claim + idempotency key)

# ---------- configuration & tools ----------
def load_cfg():
    try:
        with open(CFG, encoding="utf-8") as f: return json.load(f)
    except Exception: return {}

def save_cfg(c):
    os.makedirs(CFG_DIR, exist_ok=True)
    with open(CFG, "w", encoding="utf-8") as f: json.dump(c, f)
    if not IS_WIN: os.chmod(CFG, 0o600)

def configure():
    global APP, TOKEN
    c = load_cfg()
    APP = (os.environ.get("INVERK_URL") or c.get("url") or "").rstrip("/")
    TOKEN = os.environ.get("INVERK_WORKER_TOKEN") or c.get("token") or ""
    if "--reset-token" in sys.argv: TOKEN = ""
    if not APP: APP = input("Адрес приложения (https://...): ").strip().rstrip("/")
    while not (TOKEN.startswith("lrw_") and len(TOKEN) == 68):
        TOKEN = getpass.getpass("Вставьте токен рекордера из «Источники» (ввод скрыт) и нажмите Enter: ").strip()
        if not (TOKEN.startswith("lrw_") and len(TOKEN) == 68): print("Это не токен рекордера (должен начинаться с lrw_). Попробуйте ещё раз.")
    if api("monitors").get("error", "").startswith("401"):
        save_cfg({**c, "url": APP, "token": ""}); sys.exit("Токен не принят приложением. Создайте новый в «Источники» и запустите снова.")
    save_cfg({**c, "url": APP, "token": TOKEN})

def win_candidates(rel):
    roots = [os.environ.get(k) for k in ("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432")]
    roots.append(os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs"))
    return [os.path.join(r, "Streamlink", rel) for r in roots if r]

def find_tool(name, env, rel):
    if os.environ.get(env) and os.path.isfile(os.environ[env]): return os.environ[env]
    if IS_WIN:  # prefer the ffmpeg that ships with Streamlink's Windows installer
        for p in win_candidates(rel):
            if os.path.isfile(p): return p
    return shutil.which(name)

def find_tools():
    global FFMPEG, STREAMLINK
    FFMPEG = find_tool("ffmpeg", "INVERK_FFMPEG", r"ffmpeg\ffmpeg.exe")
    STREAMLINK = find_tool("streamlink", "INVERK_STREAMLINK", r"bin\streamlink.exe")
    if not FFMPEG: sys.exit("Не найден ffmpeg. Установите Streamlink для Windows (в нём есть ffmpeg): https://streamlink.github.io/install.html или укажите INVERK_FFMPEG.")
    if not STREAMLINK: sys.exit("Не найден Streamlink. Установите: https://streamlink.github.io/install.html (или INVERK_STREAMLINK=путь\\streamlink.exe).")
    print(f"ffmpeg: {FFMPEG}\nstreamlink: {STREAMLINK}", flush=True)

def api(action, **kw):
    req = urllib.request.Request(f"{APP}/api/public/live/worker", data=json.dumps({"action": action, **kw}).encode(),
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r: return json.load(r)
    except urllib.error.HTTPError as e: return {"error": f"{e.code} {e.read()[:200].decode('utf-8', 'replace')}"}
    except Exception as e: return {"error": f"network {e}"}

# ---------- buffer index (pure, unit-tested) ----------
def read_index(session_dir):
    """[(path, wall_start, wall_end)] from ffmpeg's live CSV segment list + the session's wall-clock anchor."""
    meta = os.path.join(session_dir, "meta.json"); lst = os.path.join(session_dir, "list.csv")
    if not os.path.isfile(lst): return []
    with open(lst, newline="") as f: rows = [r for r in csv.reader(f) if len(r) >= 3]
    if not rows: return []
    first = os.path.join(session_dir, rows[0][0])
    try:
        with open(meta) as f: anchor = json.load(f)
    except Exception:
        if not os.path.isfile(first): return []
        # The first segment's last write is its end on the wall clock; ffmpeg's CSV times are stream time.
        anchor = {"wall": os.path.getmtime(first) - (float(rows[0][2]) - float(rows[0][1])), "pts": float(rows[0][1])}
        with open(meta, "w") as f: json.dump(anchor, f)
    w = lambda t: anchor["wall"] + float(t) - anchor["pts"]
    return [(os.path.join(session_dir, r[0]), w(r[1]), w(r[2])) for r in rows]

def all_segments(mid):
    out = []
    for s in sorted(glob.glob(os.path.join(BUF, mid, "*"))):
        if os.path.isdir(s): out += [x for x in read_index(s) if os.path.isfile(x[0])]
    return sorted(out, key=lambda x: x[1])

class NoMedia(Exception): pass   # window can never be served (before recording started / gap) -> final
class NotYet(Exception): pass    # post-roll not written yet -> retry

def plan_cut(segs, start_wall, end_wall, pre=PRE, post=POST):
    """Pick contiguous segments covering [start-pre, end+post]; returns (paths, seek_s, dur_s)."""
    a, b = start_wall - pre, end_wall + post
    if not segs or segs[0][1] > a + 1: raise NoMedia("Нет записи до этого момента: рекордер начал буферизацию позже (нет медиа до начала записи)")
    if segs[-1][2] < b - 1: raise NotYet("Хвост окна (15 с после всплеска) ещё не записан")
    use = [s for s in segs if s[2] > a and s[1] < b]
    if not use or use[0][1] > a + 1: raise NoMedia("Начало окна уже удалено из буфера или не записывалось")
    for p, q in zip(use, use[1:]):
        if q[1] - p[2] > 1.5: raise NoMedia(f"В записи разрыв {q[1] - p[2]:.0f} с (переподключение) внутри окна клипа")
    return [s[0] for s in use], max(0.0, a - use[0][1]), b - a

# ---------- capture sessions ----------
# ---------- Streamlink -> ffmpeg handoff (pure parts unit-tested) ----------
import re
SIGS = [(b"\x1aE\xdf\xa3", "matroska"), (b"FLV", "flv")]

def sanitize(text):
    """Logs may contain signed stream URLs: keep host/path, drop query strings and tokens."""
    text = re.sub(r"(https?://[^\s?\"']+)\?[^\s\"']*", r"\1?…", text)
    return re.sub(r"lrw_[0-9a-f]{8,}", "lrw_…", text)

def find_ts_sync(b):
    for i in range(0, min(len(b) - 376, 65536)):
        if b[i] == 0x47 and b[i + 188] == 0x47 and b[i + 376] == 0x47: return i
    return -1

def sniff(head):
    """-> (ffmpeg input format, bytes to skip, note). Leading non-media bytes (e.g. console text) are dropped."""
    i = find_ts_sync(head)
    if i == 0: return "mpegts", 0, "MPEG-TS"
    for sig, fmt in SIGS:
        if head.startswith(sig): return fmt, 0, fmt
    if len(head) > 8 and head[4:8] == b"ftyp": return "mp4", 0, "mp4"
    if i > 0: return "mpegts", i, f"MPEG-TS после {i} байт мусора: {sanitize(head[:min(i, 160)].decode('latin-1'))!r}"
    return None, 0, "неизвестный формат, первые байты: " + head[:24].hex()

class Relay(threading.Thread):
    """Reads Streamlink's stdout, identifies the container from the first bytes, starts ffmpeg with an explicit
    input format and copies bytes. Avoids ffmpeg guessing on a pipe ("Invalid data found when processing input")."""
    def __init__(self, src, start_ff, on_fail):
        super().__init__(daemon=True); self.src, self.start_ff, self.on_fail = src, start_ff, on_fail; self.ff = None; self.bytes = 0; self.note = ""
    def run(self):
        head = b""
        while len(head) < 65536 + 376:
            chunk = self.src.read(65536)
            if not chunk: break
            head += chunk
            fmt, skip, note = sniff(head)
            if fmt and (fmt != "mpegts" or skip or len(head) >= 4096): break
        fmt, skip, self.note = sniff(head)
        if not fmt: return self.on_fail(f"Streamlink отдал не видео ({self.note}; {len(head)} байт)")
        self.ff = self.start_ff(fmt)
        try:
            self.ff.stdin.write(head[skip:]); self.bytes = len(head) - skip
            while True:
                chunk = self.src.read(65536)
                if not chunk: break
                self.ff.stdin.write(chunk); self.bytes += len(chunk)
        except (BrokenPipeError, OSError): pass
        finally:
            try: self.ff.stdin.close()
            except OSError: pass

def ffmpeg_segment_cmd(fmt):
    return [FFMPEG, "-hide_banner", "-loglevel", "error", "-fflags", "+genpts+discardcorrupt", "-f", fmt, "-i", "pipe:0", "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
            "-f", "segment", "-segment_time", str(SEG), "-reset_timestamps", "1",
            "-segment_list", "list.csv", "-segment_list_type", "csv", "-segment_list_flags", "+live", "seg_%06d.ts"]

def streamlink_cmd(url):
    # --ffmpeg-fout mpegts: when Streamlink must mux separate audio/video it would otherwise emit matroska.
    return [STREAMLINK, "--stdout", "--loglevel", "info", "--hls-live-edge", "3", "--stream-segment-attempts", "5",
            "--ffmpeg-ffmpeg", FFMPEG, "--ffmpeg-fout", "mpegts", url, "best"]

class Session:
    def __init__(self, m):
        self.url = m["record_url"]; self.dir = os.path.join(BUF, m["id"], str(int(time.time()))); os.makedirs(self.dir, exist_ok=True)
        self.sl_log = open(os.path.join(self.dir, "streamlink.log"), "wb"); self.ff_log = open(os.path.join(self.dir, "ffmpeg.log"), "wb"); self.fail = None
        self.src = subprocess.Popen(streamlink_cmd(self.url), stdout=subprocess.PIPE, stderr=self.sl_log, creationflags=NOWIN)
        def start_ff(fmt):
            return subprocess.Popen(ffmpeg_segment_cmd(fmt), stdin=subprocess.PIPE, stderr=self.ff_log, cwd=self.dir, creationflags=NOWIN)
        def on_fail(msg): self.fail = msg
        self.relay = Relay(self.src.stdout, start_ff, on_fail); self.relay.start()
        print("буфер:", sanitize(self.url), flush=True)
    @property
    def ff(self): return self.relay.ff
    def alive(self):
        if self.fail or self.src.poll() is not None: return False
        return self.ff is None or self.ff.poll() is None
    def _tail(self, f):
        try:
            f.flush()
            with open(f.name, "rb") as h: lines = [l for l in h.read()[-2000:].decode("utf-8", "replace").splitlines() if l.strip()]
            return sanitize(" | ".join(lines[-2:]))[:220]
        except Exception: return ""
    def diagnose(self):
        parts = [self.fail] if self.fail else []
        if self.src.poll() is not None: parts.append(f"streamlink код {self.src.returncode}: {self._tail(self.sl_log)}")
        if self.ff is not None and self.ff.poll() is not None: parts.append(f"ffmpeg код {self.ff.returncode}: {self._tail(self.ff_log)}")
        if self.relay.note and self.relay.note != "MPEG-TS": parts.append(f"формат: {self.relay.note}")
        return "; ".join(p for p in parts if p) or "streamlink/ffmpeg завершились"
    def stop(self):
        for p in (self.src, self.ff):
            if p is not None and p.poll() is None:
                p.terminate()
                try: p.wait(5)
                except subprocess.TimeoutExpired: p.kill()
        self.relay.join(3); self.sl_log.close(); self.ff_log.close()

def sync_monitors():
    r = api("monitors"); ms = r.get("monitors", [])
    if r.get("error", "").startswith("401"):  # token revoked in Sources: forget it and ask for a new one on next start
        save_cfg({**load_cfg(), "token": ""}); raise SystemExit("Токен отозван или неверен. Создайте новый в «Источники» и запустите рекордер снова.")
    if r.get("error"): print("ошибка API:", sanitize(r["error"]), flush=True)
    live = {m["id"]: m for m in ms if m["media_mode"] == "recorder" and m["status"] == "live" and m.get("record_url")}
    for mid, s in list(procs.items()):
        if mid not in live or not s.alive() or live[mid]["record_url"] != s.url:
            if not s.alive():
                errors[mid] = "Захват прервался: " + s.diagnose(); fails[mid] = fails.get(mid, 0) + 1
                retry_at[mid] = time.time() + min(120, 10 * 2 ** (fails[mid] - 1)); errors[mid] += f" — повтор через {int(retry_at[mid] - time.time())} с"; print(errors[mid], flush=True)
            s.stop(); del procs[mid]
    for mid, m in live.items():
        if mid not in procs and time.time() >= retry_at.get(mid, 0):
            try: procs[mid] = Session(m)
            except Exception as e: errors[mid] = f"Не удалось запустить захват: {e}"
    now = time.time()
    for mid in os.listdir(BUF) if os.path.isdir(BUF) else []:
        for p, _a, b in all_segments(mid):
            if now - b > KEEP_S: os.remove(p)
    states = []
    for m in ms:
        if m["media_mode"] != "recorder": continue
        segs = all_segments(m["id"]); s = procs.get(m["id"])
        tail = [x for x in segs if s and x[0].startswith(s.dir)]
        buf = (tail[-1][2] - tail[0][1]) if tail else 0
        if buf > SEG: fails[m["id"]] = 0
        err = None if (s and s.alive()) else errors.get(m["id"]) or ("Эфир не идёт — запись не ведётся" if m["status"] != "live" else "Нет ссылки на эфир")
        states.append({"id": m["id"], "buffer_s": round(buf, 1), "ready": bool(s and s.alive() and buf >= PRE + SEG), "error": err})
    api("status", monitors=states, version=VERSION, tools=f"streamlink+ffmpeg ({'Windows' if IS_WIN else sys.platform})")
    return {m["id"]: m for m in ms}

# ---------- cutting ----------
VERT = ("[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2,eq=brightness=-0.08[bg];"
        "[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]")

def render(inp_args, seek, dur, out):
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *inp_args, "-ss", f"{seek:.3f}", "-t", f"{dur:.3f}", "-filter_complex", VERT, "-map", "[v]", "-map", "0:a:0",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-r", "30", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out]
    subprocess.run(cmd, check=True, timeout=600, creationflags=NOWIN, capture_output=True)

def iso_ts(s): return calendar.timegm(time.strptime(s[:19], "%Y-%m-%dT%H:%M:%S")) + (float("0" + s[19:s.find("+") if "+" in s else None].rstrip("Z")) if s[19:20] == "." else 0)

def cut_highlight(h, mon, out):
    if mon.get("media_mode") == "recording_url":
        if h.get("offset_s") is None: raise NoMedia("Неизвестно время начала эфира — нельзя найти момент в записи")
        dur = iso_ts(h["end_at"]) - iso_ts(h["start_at"]) + PRE + POST
        return render(["-i", mon["record_url"]], max(0, float(h["offset_s"]) - PRE), dur, out)
    paths, seek, dur = plan_cut(all_segments(h["monitor_id"]), iso_ts(h["start_at"]), iso_ts(h["end_at"]))
    lst = out + ".txt"
    with open(lst, "w", encoding="utf-8") as f: f.write("".join("file '{}'\n".format(p.replace("\\", "/").replace("'", "'\\''")) for p in paths))
    render(["-f", "concat", "-safe", "0", "-i", lst], seek, dur, out)

def process(h, mon):
    if h["id"] in done: return api("fail", id=h["id"], claim=h["claim"], error="уже загружено этим рекордером", retryable=False)
    with tempfile.TemporaryDirectory() as t:
        out = os.path.join(t, "clip.mp4")
        try: cut_highlight(h, mon, out)
        except NoMedia as e: return api("fail", id=h["id"], claim=h["claim"], error=str(e), retryable=False)
        except NotYet as e: return api("fail", id=h["id"], claim=h["claim"], error=str(e), retryable=True)
        except subprocess.CalledProcessError as e:
            return api("fail", id=h["id"], claim=h["claim"], error="ffmpeg: " + (e.stderr or b"").decode("utf-8", "replace")[-250:], retryable=True)
        with open(out, "rb") as f: data = f.read()
        urllib.request.urlopen(urllib.request.Request(h["upload_url"], data=data, method="PUT", headers={"Content-Type": "video/mp4", "x-upsert": "true"}), timeout=300).read()
        r = api("complete", id=h["id"], claim=h["claim"])
        if r.get("ok"): done.add(h["id"])
        print("клип", h["id"][:8], f"{len(data) / 1048576:.1f} МБ", "готов" if r.get("ok") else r, flush=True)

SCENE_S = int(os.environ.get("INVERK_SCENE_SECONDS", "60"))
def scene_loop():
    """Visual game check from the newest finished segment; own thread so capture/cutting never waits."""
    while True:
        time.sleep(SCENE_S)
        for mid, s in list(procs.items()):
            try:
                segs = all_segments(mid); now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                if not s.alive() or len(segs) < 2: api("frame", monitor_id=mid, frame_at=now, unavailable="Рекордер не получает видео этого эфира"); continue
                p, a, b = segs[-2]
                jpg = subprocess.run([FFMPEG, "-loglevel", "error", "-ss", str(SEG / 2), "-i", p, "-frames:v", "1", "-vf", "scale=768:-2", "-q:v", "6", "-f", "image2", "pipe:1"],
                                     capture_output=True, timeout=30, creationflags=NOWIN).stdout
                if not jpg: api("frame", monitor_id=mid, frame_at=now, unavailable="Не удалось извлечь кадр"); continue
                api("frame", monitor_id=mid, frame_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime((a + b) / 2)), jpeg_base64=base64.b64encode(jpg).decode())
            except Exception as e: print("scene error", e, flush=True)

def main():
    find_tools(); configure(); os.makedirs(BUF, exist_ok=True)
    print(f"Inverk рекордер {VERSION} запущен. Буфер: {BUF}. Окно можно свернуть; Ctrl+C — остановить.", flush=True)
    threading.Thread(target=scene_loop, daemon=True).start()
    try:
        while True:
            try:
                mons = sync_monitors()
                for h in api("claim").get("highlights", []):
                    try: process(h, mons.get(h["monitor_id"], {"media_mode": "recorder"}))
                    except Exception as e: api("fail", id=h["id"], claim=h["claim"], error=str(e)[:280], retryable=True)
            except Exception as e: print("ошибка цикла:", e, flush=True)
            time.sleep(10)
    except KeyboardInterrupt: pass
    finally:
        for s in procs.values(): s.stop()

if __name__ == "__main__": main()
