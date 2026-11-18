#!/usr/bin/env python3
"""Inverk Clips live recorder (Windows / macOS / Linux). Run it on your own PC for streams you own or may record.

Keeps a rolling buffer of 10 s MPEG-TS segments per recorder monitor (Streamlink -> ffmpeg, stream copy),
claims due chat-spike highlights, cuts 20 s before the spike to 15 s after it with the original audio,
renders a 1080x1920 vertical MP4, uploads it to a one-time signed URL and reports heartbeat/buffer/errors.

The worker token is asked once (hidden input) and stored in your user profile, never printed or logged.
Windows: start inverk-recorder.bat (downloaded from Sources). Others: INVERK_URL=https://... python3 recorder.py
"""
import base64, calendar, csv, getpass, glob, json, os, shutil, subprocess, sys, tempfile, threading, time, urllib.error, urllib.request

VERSION = "2.2"
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


# ---------- folder import: existing recordings in %USERPROFILE%\Videos\StreamClips\<channel>\<yyyyMMdd-HHmmss>\clip_NNNN.mp4 ----------
# Read-only: files are only listed, probed and read by ffmpeg; nothing is ever written, renamed or locked there.
import re as _re
FOLDER = None
FIDX = os.path.join(CFG_DIR, "folder_index.json")
SESSION_RE, CLIP_RE = _re.compile(r"^\d{8}-\d{6}$"), _re.compile(r"^clip_(\d{4,})\.mp4$", _re.I)
STABLE_S, QUIET_S, LAST_CLIP_S, ALIGN_TOL = 20, 30, 180, 10

def load_fidx():
    try:
        with open(FIDX, encoding="utf-8") as f: return json.load(f)
    except Exception: return {}

def save_fidx(idx):
    os.makedirs(CFG_DIR, exist_ok=True); tmp = FIDX + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f: json.dump(idx, f)
    os.replace(tmp, FIDX)

def session_start(name): return time.mktime(time.strptime(name, "%Y%m%d-%H%M%S"))  # folder names are local time

def probe(path):
    """Duration if the MP4 is finalized (index readable) and has video+audio, else None. Uses ffmpeg itself because
    Streamlink's bundled ffmpeg folder has no ffprobe."""
    r = subprocess.run([FFMPEG, "-hide_banner", "-i", path], capture_output=True, timeout=60, creationflags=NOWIN)
    err = r.stderr.decode("utf-8", "replace")
    m = _re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", err)
    if not m or "moov atom not found" in err or "Video:" not in err or "Audio:" not in err: return None
    d = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)); return d if d > 0.5 else None

def scan_folder(root, idx, now=None, prober=None):
    """Update idx (rel_path -> record) for every clip file; returns records grouped by (channel, session)."""
    now = now or time.time(); prober = prober or probe; sessions = {}
    for ch in sorted(os.listdir(root)):
        cdir = os.path.join(root, ch)
        if not os.path.isdir(cdir): continue
        for sess in sorted(os.listdir(cdir)):
            sdir = os.path.join(cdir, sess)
            if not (os.path.isdir(sdir) and SESSION_RE.match(sess)): continue
            clips = sorted(((int(m.group(1)), f) for f in os.listdir(sdir) if (m := CLIP_RE.match(f))), key=lambda x: x[0])
            recs = []
            for i, (num, f) in enumerate(clips):
                path = os.path.join(sdir, f); rel = f"{ch}/{sess}/{f}"
                try: st = os.stat(path)
                except OSError: continue
                r = idx.get(rel) or {"rel_path": rel, "channel": ch, "session": sess, "file_name": f, "num": num}
                changed = r.get("size_bytes") != st.st_size or r.get("mtime") != st.st_mtime
                if changed: r.update(size_bytes=st.st_size, mtime=st.st_mtime, seen_at=now, status="writing", duration_s=None, features=None)
                later = i < len(clips) - 1
                if r["status"] in ("writing", "checking"):
                    if changed or now - st.st_mtime < QUIET_S or now - r["seen_at"] < STABLE_S: r["status"], r["detail"] = "writing", "файл ещё пишется"
                    elif not later and now - st.st_mtime < LAST_CLIP_S: r["status"], r["detail"] = "checking", "последний файл сессии — ждём завершения"
                    else:
                        d = prober(path)
                        r["status"], r["duration_s"], r["detail"] = ("ready", d, None) if d else ("invalid", None, "MP4 не завершён или без звука/видео")
                r["abs"] = path; idx[rel] = r; recs.append(r)
            if recs: sessions[(ch, sess)] = recs
    for key, recs in sessions.items(): timeline(key[1], recs)
    return sessions

def timeline(sess, recs):
    """Session-relative offsets from cumulative durations; wall clock counts as verified only when every file's
    mtime (= when the writer closed it) matches folder start + cumulative duration within ALIGN_TOL."""
    t0 = session_start(sess); off = 0.0; ok = True; prev = None
    for r in recs:
        contiguous = prev is not None and r["num"] == prev["num"] + 1 and prev["status"] == "ready"
        if prev is not None and not contiguous: ok = False
        if r["status"] != "ready": r.update(offset=None, aligned=False, start_at=None); prev = r; ok = False; continue
        r["offset"] = off; end_wall = t0 + off + r["duration_s"]
        ok = ok and abs(r["mtime"] - end_wall) <= ALIGN_TOL
        r["aligned"] = ok; r["start_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t0 + off)) if ok else None
        off += r["duration_s"]; prev = r

def segments_for(recs, a, b):
    """Map a session-time window onto (file, from, to) pieces, stitching adjacent files; None if not contiguous."""
    out = []
    for r in recs:
        if r["status"] != "ready" or r.get("offset") is None: continue
        s, e = r["offset"], r["offset"] + r["duration_s"]
        if e <= a or s >= b: continue
        if out and abs(out[-1][3] - s) > 0.05: return None
        out.append((r, max(a, s) - s, min(b, e) - s, e))
    if not out or out[0][0]["offset"] + out[0][1] > a + 0.05 or out[-1][0]["offset"] + out[-1][2] < b - 0.05: return None
    return [(r, f, t) for r, f, t, _ in out]

def audio_rms(path):
    """Per-second RMS level (dB) of the original audio."""
    r = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", path, "-vn", "-ac", "1",
                        "-af", "aresample=16000,asetnsamples=n=16000,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-", "-f", "null", "-"],
                       capture_output=True, timeout=900, creationflags=NOWIN)
    vals = []
    for line in r.stdout.decode("utf-8", "replace").splitlines():
        if "RMS_level=" in line:
            v = line.split("=", 1)[1].strip(); vals.append(-90.0 if v in ("-inf", "inf", "nan") else max(-90.0, float(v)))
    return vals

def scene_changes(path, start, dur):
    r = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-ss", f"{start:.2f}", "-t", f"{dur:.2f}", "-i", path, "-an", "-vf", "fps=4,scale=160:-2,select='gt(scene,0.3)',metadata=print:file=-", "-f", "null", "-"],
                       capture_output=True, timeout=300, creationflags=NOWIN)
    return r.stdout.decode("utf-8", "replace").count("lavfi.scene_score=")

def norm(s): return _re.sub(r"[^0-9a-zа-яё]", "", (s or "").lower())

def rank_candidates(sessions, monitors, highlights, used, max_files=30):
    """Best moments first. Verified wall clock + matching monitor -> chat spikes; otherwise audio surge + scene cuts."""
    cands = []; used_keys = {(u.get("channel"), u.get("session"), int(u.get("a", -1))) for u in used if isinstance(u, dict)}
    for (ch, sess), recs in sessions.items():
        ready = [r for r in recs if r["status"] == "ready"][-max_files:]
        if not ready: continue
        mon_ids = {m["id"] for m in monitors if norm(ch) and any(norm(ch) in norm(m.get(k)) or (norm(m.get(k)) and norm(m.get(k)) in norm(ch)) for k in ("channel_title", "input", "channel_id"))}
        if all(r.get("aligned") for r in ready) and mon_ids:
            t0 = session_start(sess)
            for h in highlights:
                if h["monitor_id"] not in mon_ids: continue
                a, b = iso_ts(h["start_at"]) - t0 - PRE, iso_ts(h["end_at"]) - t0 + POST
                segs = segments_for(recs, a, b)
                if segs: cands.append({"channel": ch, "session": sess, "a": a, "b": b, "score": 100 + float(h.get("score") or 0), "segs": segs,
                                       "reason": f"всплеск чата {h['peak_at'][11:19]} UTC; время файлов сверено"})
        series = []  # (session_time, dB)
        for r in ready:
            if r.get("features") is None: r["features"] = {"rms": audio_rms(r["abs"])}
            series += [(r["offset"] + i, v) for i, v in enumerate(r["features"]["rms"])]
        peaks = []
        for i in range(len(series)):
            win = [v for _, v in series[i:i + 3]]; base = sorted(v for _, v in series[max(0, i - 60):i] or series[:60])
            if len(win) < 3 or not base: continue
            peaks.append((sum(win) / 3 - base[len(base) // 2], series[i][0]))
        peaks.sort(reverse=True); picked = []
        for z, t in peaks:
            if len(picked) >= 5: break
            if any(abs(t - q) < 30 for _, q in picked): continue
            a, b = t - 15, t + 13  # setup 15 s, action ~3 s, reaction 10 s
            if (ch, sess, int(a)) in used_keys: continue
            segs = segments_for(recs, a, b)
            if segs: picked.append((z, t)); 
            else: continue
            cuts = sum(scene_changes(r["abs"], f, max(0.1, to - f)) for r, f, to in segments_for(recs, t - 8, t + 8) or [])
            cands.append({"channel": ch, "session": sess, "a": a, "b": b, "score": z + 0.3 * min(cuts, 10), "segs": segs,
                          "reason": f"громкость +{z:.1f} дБ к фону, смен сцены рядом: {cuts}; время чата не сверено — выбор по звуку и картинке"})
    return sorted(cands, key=lambda c: -c["score"])

def ass_time(t): t = max(0.0, t); return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"
def ass_text(s): return (s or "").replace("\\", "").replace("{", "(").replace("}", ")").replace("\n", " ")

def write_ass(cues, path):
    head = ("[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\n"
            "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginV\n"
            "Style: Main,Arial,66,&H00FFFFFF,&H00000000,&H64000000,1,5,0,2,430\nStyle: Alt,Arial,46,&H0000F0FF,&H00000000,&H64000000,1,4,0,2,350\n\n"
            "[Events]\nFormat: Layer, Start, End, Style, Text\n")
    lines = []
    for c in cues:
        lines.append(f"Dialogue: 0,{ass_time(c['start'])},{ass_time(c['end'] + 0.25)},Main,{ass_text(c['text'])}")
        if c.get("alt"): lines.append(f"Dialogue: 0,{ass_time(c['start'])},{ass_time(c['end'] + 0.25)},Alt,{ass_text(c['alt'])}")
    with open(path, "w", encoding="utf-8") as f: f.write(head + "\n".join(lines) + "\n")

def has_subtitles_filter():
    r = subprocess.run([FFMPEG, "-hide_banner", "-filters"], capture_output=True, creationflags=NOWIN)
    return b" subtitles " in r.stdout

def render_candidate(segs, out, cues=None, audio_only=False):
    """Stitch pieces (re-timed, original audio), frame 9:16 over a blurred fill, burn RU/EN captions if available."""
    args, parts = [], []
    for i, (r, f, t) in enumerate(segs):
        args += ["-ss", f"{f:.3f}", "-t", f"{t - f:.3f}", "-i", r["abs"]]
        parts.append(f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo[a{i}]" if audio_only else
                     f"[{i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v{i}];[{i}:a]aresample=48000,aformat=channel_layouts=stereo[a{i}]")
    n = len(segs); cwd = os.path.dirname(out)
    if audio_only:
        fc = ";".join(parts) + ";" + "".join(f"[a{i}]" for i in range(n)) + f"concat=n={n}:v=0:a=1[ca]"
        cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *args, "-filter_complex", fc, "-map", "[ca]", "-ac", "1", "-c:a", "aac", "-b:a", "64k", out]
    else:
        sub = ""
        if cues: write_ass(cues, os.path.join(cwd, "c.ass")); sub = ",subtitles=c.ass"  # relative name: no Windows drive-letter escaping
        fc = (";".join(parts) + ";" + "".join(f"[v{i}][a{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=1[cv][ca];"
              "[cv]split[x][y];[x]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2,eq=brightness=-0.08[bg];"
              f"[y]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p{sub}[v]")
        cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *args, "-filter_complex", fc, "-map", "[v]", "-map", "[ca]",
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-r", "30", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", os.path.basename(out)]
    subprocess.run(cmd, check=True, timeout=900, capture_output=True, creationflags=NOWIN, cwd=cwd)

def put(url, path, ctype):
    with open(path, "rb") as f: data = f.read()
    urllib.request.urlopen(urllib.request.Request(url, data=data, method="PUT", headers={"Content-Type": ctype, "x-upsert": "true"}), timeout=300).read()

reported = {}
def report_index(idx):
    rows = []
    for rel, r in idx.items():
        sig = (r["status"], r.get("duration_s"), r.get("aligned"), r.get("size_bytes"))
        if reported.get(rel) == sig: continue
        rows.append({k: r.get(k) for k in ("rel_path", "channel", "session", "file_name", "size_bytes", "duration_s", "start_at", "aligned", "status", "detail")}); reported[rel] = sig
    for i in range(0, len(rows), 400): api("folder_index", files=rows[i:i + 400])

def folder_cycle(idx):
    sessions = scan_folder(FOLDER, idx); save_fidx({k: {x: y for x, y in v.items() if x != "abs"} for k, v in idx.items()}); report_index(idx)
    nxt = api("folder_next")
    if not nxt.get("render"): return nxt.get("why")
    cands = rank_candidates(sessions, nxt.get("monitors", []), nxt.get("highlights", []), nxt.get("used", []))
    save_fidx({k: {x: y for x, y in v.items() if x != "abs"} for k, v in idx.items()})
    if not cands: return "готовых файлов для кандидата пока нет"
    c = cands[0]; segs = [{"file": r["rel_path"], "from_s": round(f, 2), "to_s": round(t, 2)} for r, f, t in c["segs"]]
    made = api("candidate_create", channel=c["channel"], segments=segs, score=round(c["score"], 2), reason=c["reason"], window_info={"channel": c["channel"], "session": c["session"], "a": int(c["a"]), "b": int(c["b"])})
    if made.get("error"): return made["error"]
    cid = made["id"]
    try:
        with tempfile.TemporaryDirectory() as t:
            api("candidate_progress", id=cid, status="transcribing", detail="звук отправлен на распознавание")
            aud = os.path.join(t, "a.m4a"); render_candidate(c["segs"], aud, audio_only=True); put(made["audio_upload_url"], aud, "audio/mp4")
            cues, note = [], ""
            for _ in range(40):
                tr = api("candidate_transcribe", id=cid)
                if tr.get("state") == "done": cues, note = tr.get("captions") or [], tr.get("note") or ""; break
                time.sleep(5)
            if cues and not has_subtitles_filter(): cues, note = [], "этот ffmpeg без фильтра subtitles — клип без субтитров"
            api("candidate_progress", id=cid, status="rendering", detail=f"рендер 9:16; {note or 'без субтитров (распознавание не успело)'}")
            out = os.path.join(t, "clip.mp4"); render_candidate(c["segs"], out, cues); put(made["video_upload_url"], out, "video/mp4")
            r = api("candidate_complete", id=cid); return "кандидат готов" if r.get("ok") else r.get("error")
    except Exception as e:
        err = sanitize(e.stderr.decode("utf-8", "replace")[-250:] if isinstance(e, subprocess.CalledProcessError) and e.stderr else str(e))
        api("candidate_fail", id=cid, error=err[:280]); return err

def folder_loop():
    idx = load_fidx(); last = None
    while True:
        try:
            msg = folder_cycle(idx)
            if msg != last: print("папка:", msg, flush=True); last = msg
        except Exception as e: print("папка, ошибка:", sanitize(str(e)), flush=True)
        time.sleep(30)

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
    global FOLDER
    find_tools(); configure(); os.makedirs(BUF, exist_ok=True)
    fa = sys.argv[sys.argv.index("--folder") + 1] if "--folder" in sys.argv[:-1] else os.environ.get("INVERK_FOLDER") or os.path.join(os.path.expanduser("~"), "Videos", "StreamClips")
    if os.path.isdir(fa) and "--no-folder" not in sys.argv:
        FOLDER = fa; print(f"Папка записей (только чтение): {FOLDER}", flush=True); threading.Thread(target=folder_loop, daemon=True).start()
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
