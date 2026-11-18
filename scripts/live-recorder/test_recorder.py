"""Fixture tests for public/recorder/recorder.py: buffer indexing, 20 s/15 s window, no media before start,
reconnect gaps, duplicate protection. Run: python3 scripts/live-recorder/test_recorder.py"""
import json, os, shutil, subprocess, sys, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "public", "recorder"))
import recorder as R

W0 = 1_800_000_000.0
def iso(t): import time; return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int(round((t % 1) * 1000)):03d}+00:00"

class Fixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        R.FFMPEG = shutil.which("ffmpeg"); cls.tmp = tempfile.mkdtemp(); R.BUF = cls.tmp
        cls.mid = "mon"; d = os.path.join(cls.tmp, cls.mid, "1"); os.makedirs(d)
        # Same segmenter flags as the live Session, fed a 70 s source whose frame shows elapsed seconds.
        src = subprocess.Popen([R.FFMPEG, "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=s=320x240:r=30:d=70", "-f", "lavfi", "-i", "sine=f=440:d=70",
                                "-c:v", "libx264", "-g", "30", "-c:a", "aac", "-f", "mpegts", "pipe:1"], stdout=subprocess.PIPE)
        subprocess.run([R.FFMPEG, "-loglevel", "error", "-i", "pipe:0", "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-f", "segment", "-segment_time", "10",
                        "-reset_timestamps", "1", "-segment_list", "list.csv", "-segment_list_type", "csv", "-segment_list_flags", "+live", "seg_%06d.ts"],
                       stdin=src.stdout, cwd=d, check=True); src.wait()
        first = next(open(os.path.join(d, "list.csv"))).split(",")
        json.dump({"wall": W0, "pts": float(first[1])}, open(os.path.join(d, "meta.json"), "w"))  # recording started at W0

    def test_index_contiguous(self):
        segs = R.all_segments(self.mid)
        self.assertGreaterEqual(len(segs), 6); self.assertAlmostEqual(segs[0][1], W0, places=3); self.assertGreater(segs[-1][2], W0 + 69)
        for a, b in zip(segs, segs[1:]): self.assertLess(abs(b[1] - a[2]), 0.1)

    def test_window_20_before_15_after(self):
        paths, seek, dur = R.plan_cut(R.all_segments(self.mid), W0 + 30, W0 + 35)
        self.assertAlmostEqual(dur, 40.0, places=3)
        out = os.path.join(self.tmp, "clip.mp4")
        R.cut_highlight({"monitor_id": self.mid, "start_at": iso(W0 + 30), "end_at": iso(W0 + 35)}, {"media_mode": "recorder"}, out)
        probe = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", out], capture_output=True).stdout)
        self.assertAlmostEqual(float(probe["format"]["duration"]), 40.0, delta=0.2)
        self.assertEqual(sorted(s["codec_type"] for s in probe["streams"]), ["audio", "video"])
        v = next(s for s in probe["streams"] if s["codec_type"] == "video"); self.assertEqual((v["width"], v["height"]), (1080, 1920))
        subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-i", out, "-f", "null", "-"], check=True)
        # First frame must be source second 10 (= 30 - 20); testsrc draws the elapsed-seconds counter.
        for at, want in ((0.2, "10"), (39.5, "49")):
            png = os.path.join(self.tmp, f"f{want}.png")
            subprocess.run([R.FFMPEG, "-loglevel", "error", "-y", "-ss", str(at), "-i", out, "-frames:v", "1", "-vf", "crop=1080:810:0:555,scale=-1:400,negate", png], check=True)
            scores = {}
            for sec in (int(want) - 1, int(want), int(want) + 1):  # the matching second must clearly win over its neighbours
                src_png = os.path.join(self.tmp, f"s{sec}.png")
                subprocess.run([R.FFMPEG, "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x240:r=30:d=70", "-ss", str(sec + at % 1), "-frames:v", "1", "-vf", "scale=1080:810,scale=-1:400,negate", src_png], check=True)
                err = subprocess.run([R.FFMPEG, "-loglevel", "info", "-i", png, "-i", src_png, "-lavfi", "ssim", "-f", "null", "-"], capture_output=True, text=True).stderr
                scores[sec] = float(err.split("All:")[1].split()[0])
            self.assertEqual(max(scores, key=scores.get), int(want), f"frame at {at}s matches {scores}")

    def test_no_media_before_recording_started(self):
        with self.assertRaises(R.NoMedia): R.plan_cut(R.all_segments(self.mid), W0 + 5, W0 + 8)

    def test_post_roll_not_written_yet(self):
        with self.assertRaises(R.NotYet): R.plan_cut(R.all_segments(self.mid), W0 + 50, W0 + 60)

    def test_reconnect_gap_is_reported(self):
        segs = [("a", W0, W0 + 10), ("b", W0 + 10, W0 + 20), ("c", W0 + 30, W0 + 40), ("d", W0 + 40, W0 + 80)]
        with self.assertRaises(R.NoMedia): R.plan_cut(segs, W0 + 40, W0 + 45)

    def test_duplicate_highlight_not_uploaded_twice(self):
        calls = []; R.api = lambda action, **kw: calls.append((action, kw)) or {"ok": True}
        R.done.add("h1"); R.process({"id": "h1", "claim": "c", "monitor_id": self.mid}, {"media_mode": "recorder"})
        self.assertEqual(calls, [("fail", {"id": "h1", "claim": "c", "error": "уже загружено этим рекордером", "retryable": False})])

class Selective(unittest.TestCase):
    """Best-quality stream copy buffer -> chat spike -> audio/vision validation -> clip only for confirmed moments."""
    @classmethod
    def setUpClass(cls):
        R.FFMPEG = shutil.which("ffmpeg"); cls.tmp = tempfile.mkdtemp(); R.BUF = cls.tmp; cls.mid = "sel"
        d = os.path.join(cls.tmp, cls.mid, "1"); os.makedirs(d)
        # 1280x720 60 fps source, quiet commentary then a loud 8 s burst at 30-38 s (the "action/reaction").
        src = subprocess.Popen([R.FFMPEG, "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=s=1280x720:r=60:d=70", "-f", "lavfi", "-i",
                                "sine=f=300:d=70,volume='if(between(t,30,38),1,0.03)':eval=frame", "-c:v", "libx264", "-g", "60", "-c:a", "aac", "-f", "mpegts", "pipe:1"], stdout=subprocess.PIPE)
        subprocess.run(R.ffmpeg_segment_cmd("mpegts"), stdin=src.stdout, cwd=d, check=True, stderr=subprocess.DEVNULL); src.wait()
        first = next(open(os.path.join(d, "list.csv"))).split(",")
        json.dump({"wall": W0, "pts": float(first[1])}, open(os.path.join(d, "meta.json"), "w"))

    def run_process(self, hid, chatters, scenes):
        calls, uploads = [], []
        def api(action, **kw):
            calls.append((action, kw)); return {"scenes": scenes} if action == "validate_frames" else {"ok": True}
        class Up:
            def read(self): return b""
        R.api = api; R.urllib.request.urlopen = lambda req, timeout=0: uploads.append(len(req.data)) or Up()
        R.process({"id": hid, "claim": "c", "monitor_id": self.mid, "start_at": iso(W0 + 30), "end_at": iso(W0 + 34), "chatters": chatters, "upload_url": "https://x"}, {"media_mode": "recorder"})
        return calls, uploads

    def test_stream_copy_keeps_source_quality(self):
        seg = R.all_segments(self.mid)[0][0]
        self.assertEqual(R.probe_quality(seg), "1280x720 60fps")

    def test_confirmed_gameplay_spike_is_clipped(self):
        calls, uploads = self.run_process("g1", 14, [{"activity": "gameplay", "confidence": 0.9, "game": "Rust"}] * 3)
        frames = next(kw for a, kw in calls if a == "validate_frames")["frames"]; self.assertEqual(len(frames), 3)
        done = next(kw for a, kw in calls if a == "complete"); self.assertTrue(done["note"].startswith("выбрано"), done["note"])
        self.assertIn("звук +", done["note"]); self.assertEqual(len(uploads), 1); self.assertGreater(uploads[0], 100_000)

    def test_routine_menu_spike_is_skipped_without_render(self):
        calls, uploads = self.run_process("m1", 14, [{"activity": "menu", "confidence": 0.9}] * 3)
        fail = next(kw for a, kw in calls if a == "fail"); self.assertIn("рутина", fail["error"]); self.assertFalse(fail["retryable"]); self.assertEqual(uploads, [])

    def test_few_chatters_skipped_before_any_check(self):
        calls, uploads = self.run_process("c1", 3, [])
        self.assertNotIn("validate_frames", [a for a, _ in calls]); self.assertIn("мало уникальных", calls[-1][1]["error"]); self.assertEqual(uploads, [])

    def test_vision_unavailable_is_disclosed(self):
        calls, _ = self.run_process("v1", 14, [{"activity": "unavailable"}] * 3)
        note = next(kw for a, kw in calls if a in ("complete", "fail")); text = note.get("note") or note.get("error")
        self.assertIn("кадры: проверка недоступна", text)

    def test_audio_surge_measured_from_real_buffer(self):
        segs = R.all_segments(self.mid); paths, seek, dur = R.plan_cut(segs, W0 + 30, W0 + 34)
        lst = os.path.join(self.tmp, "l.txt"); open(lst, "w").write("".join(f"file '{p}'\n" for p in paths))
        self.assertGreater(R.surge(R.window_audio(["-f", "concat", "-safe", "0", "-i", lst], seek, dur)), 20)

class Decide(unittest.TestCase):
    def test_rules(self):
        g = [{"activity": "gameplay", "confidence": 0.9}]
        self.assertFalse(R.decide(5, 20, g)[0])                       # one small group of chatters never qualifies
        self.assertTrue(R.decide(10, 1, g)[0])                        # confident gameplay confirms
        self.assertFalse(R.decide(10, 4, [{"activity": "chatting", "confidence": 0.8}] * 2)[0])
        self.assertFalse(R.decide(10, 7, [{"activity": "gameplay", "confidence": 0.4}])[0])  # low-confidence vision, modest audio
        self.assertTrue(R.decide(10, 10, [])[0])                      # no vision: only a strong surge, disclosed
        self.assertFalse(R.decide(10, None, [])[0])

class Handoff(unittest.TestCase):
    """Streamlink -> ffmpeg handoff: container sniffing, junk-prefix recovery, real Streamlink 8.6.3 args."""
    def run_relay(self, payload_cmd, junk=b""):
        R.FFMPEG = shutil.which("ffmpeg"); d = tempfile.mkdtemp()
        data = junk + subprocess.run(payload_cmd, capture_output=True, check=True).stdout
        import io
        rel = R.Relay(io.BytesIO(data), lambda fmt: subprocess.Popen(R.ffmpeg_segment_cmd(fmt), stdin=subprocess.PIPE, stderr=subprocess.PIPE, cwd=d), lambda m: self.fail(m))
        rel.run(); rel.ff.wait(30)
        os.makedirs(os.path.join(d, "..", "x"), exist_ok=True)
        rows = [l for l in open(os.path.join(d, "list.csv")) if l.strip()]
        return rel, rows
    SRC = ["-f", "lavfi", "-i", "testsrc=s=320x240:r=30:d=25", "-f", "lavfi", "-i", "sine=d=25", "-c:v", "libx264", "-g", "30", "-c:a", "aac"]
    def test_ts(self):
        rel, rows = self.run_relay(["ffmpeg", "-loglevel", "error", *self.SRC, "-f", "mpegts", "-"]); self.assertEqual(rel.note, "MPEG-TS"); self.assertGreaterEqual(len(rows), 2)
    def test_console_text_before_ts_is_dropped(self):
        rel, rows = self.run_relay(["ffmpeg", "-loglevel", "error", *self.SRC, "-f", "mpegts", "-"], junk=b"[cli][info] Opening stream: 1080p60 https://x.googlevideo.com/a?sig=SECRET\r\n")
        self.assertIn("мусора", rel.note); self.assertNotIn("SECRET", rel.note); self.assertGreaterEqual(len(rows), 2)
    def test_matroska_from_streamlink_muxer(self):
        rel, rows = self.run_relay(["ffmpeg", "-loglevel", "error", *self.SRC, "-f", "matroska", "-"]); self.assertEqual(rel.note, "matroska"); self.assertGreaterEqual(len(rows), 2)
    def test_garbage_is_reported_not_fed(self):
        self.assertIsNone(R.sniff(b"<html>Sign in to confirm" + b" " * 5000)[0])
    def test_sanitize(self):
        self.assertEqual(R.sanitize("GET https://r1.googlevideo.com/x/y.m3u8?sig=abc&ip=1 lrw_0123456789abcdef"), "GET https://r1.googlevideo.com/x/y.m3u8?… lrw_…")
    @unittest.skipUnless(os.path.isfile("/tmp/sl/bin/streamlink"), "Streamlink 8.6.3 venv not installed")
    def test_real_streamlink_863_live_hls(self):
        R.FFMPEG = shutil.which("ffmpeg"); R.STREAMLINK = "/tmp/sl/bin/streamlink"; R.BUF = tempfile.mkdtemp()
        import time
        s = R.Session({"id": "sl", "record_url": "hls://https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"}); time.sleep(25)
        segs = R.all_segments("sl"); diag = s.diagnose(); s.stop()
        self.assertGreaterEqual(len(segs), 1, diag); self.assertEqual(s.relay.note, "MPEG-TS")

if __name__ == "__main__": unittest.main(verbosity=2)
