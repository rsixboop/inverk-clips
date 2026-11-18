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

if __name__ == "__main__": unittest.main(verbosity=2)
