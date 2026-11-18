"""Folder-import fixtures: two adjacent clip files with a loud moment crossing their boundary, an active file,
restart/dedup, wall-clock verification and chat-spike correlation. Run: python3 scripts/live-recorder/test_folder_import.py"""
import json, os, shutil, subprocess, sys, tempfile, time, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "public", "recorder"))
import recorder as R

T0 = time.mktime((2026, 11, 18, 12, 0, 0, 0, 0, -1)); SESS = "20261118-120000"
def iso(t): return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + ".000+00:00"

class Folder(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        R.FFMPEG = shutil.which("ffmpeg"); R.CFG_DIR = tempfile.mkdtemp(); R.FIDX = os.path.join(R.CFG_DIR, "fi.json")
        cls.root = tempfile.mkdtemp(); d = os.path.join(cls.root, "xqc", SESS); os.makedirs(d); src = os.path.join(cls.root, "src.mp4")
        # quiet tone, loud burst at 17-21 s (crosses the 20 s file boundary)
        subprocess.run([R.FFMPEG, "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=640x360:r=30:d=40", "-f", "lavfi", "-i", "sine=f=300:d=40",
                        "-af", "volume='if(between(t,17,21),1,0.01)':eval=frame", "-c:v", "libx264", "-g", "30", "-c:a", "aac", src], check=True)
        for i, (a, mt) in enumerate(((0, T0 + 20), (20, T0 + 40)), 1):
            p = os.path.join(d, f"clip_{i:04d}.mp4")
            subprocess.run([R.FFMPEG, "-loglevel", "error", "-y", "-ss", str(a), "-t", "20", "-i", src, "-c:v", "libx264", "-c:a", "aac", p], check=True); os.utime(p, (mt, mt))
        act = os.path.join(d, "clip_0003.mp4"); open(act, "wb").write(open(os.path.join(d, "clip_0001.mp4"), "rb").read()[:200_000])  # being written: no index yet
        cls.active = act; cls.d = d

    def scan(self, now, idx, calls=None):
        def prober(p):
            if calls is not None: calls.append(p)
            return R.probe(p)
        os.utime(self.active, (now - 2, now - 2))
        return R.scan_folder(self.root, idx, now=now, prober=prober)

    def test_finalized_only_restart_and_dedup(self):
        idx, calls = {}, []; now = T0 + 1000
        s = self.scan(now, idx, calls); self.assertEqual([r["status"] for r in s[("xqc", SESS)]], ["writing"] * 3); self.assertEqual(calls, [])
        s = self.scan(now + 25, idx, calls)
        self.assertEqual([r["status"] for r in s[("xqc", SESS)]], ["ready", "ready", "writing"])  # active file never probed as final
        self.assertEqual(len(calls), 2)
        recs = s[("xqc", SESS)]; self.assertAlmostEqual(recs[1]["offset"], recs[0]["duration_s"], places=2); self.assertTrue(recs[1]["aligned"])
        R.save_fidx({k: {x: y for x, y in v.items() if x != "abs"} for k, v in idx.items()}); idx2 = R.load_fidx(); calls.clear()
        self.scan(now + 60, idx2, calls); self.assertEqual(calls, [])  # restart: unchanged files are not re-probed or re-added
        self.assertEqual(len(idx2), 3)

    def ready(self):
        idx = {}; self.scan(T0 + 1000, idx); return self.scan(T0 + 1030, idx)

    def test_audio_rank_stitches_across_boundary_and_renders(self):
        s = self.ready(); c = R.rank_candidates(s, [], [], [])[0]
        self.assertTrue(16 <= c["a"] + 15 <= 18.5, (c["a"], c["reason"])); self.assertEqual([r["file_name"] for r, _, _ in c["segs"]], ["clip_0001.mp4", "clip_0002.mp4"])
        self.assertIn("не сверено", c["reason"])
        out = os.path.join(tempfile.mkdtemp(), "clip.mp4")
        R.render_candidate(c["segs"], out, [{"start": 1, "end": 2.5, "text": "ору, жесть", "alt": "lmao, insane"}])
        pr = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", out], capture_output=True).stdout)
        v = next(x for x in pr["streams"] if x["codec_type"] == "video"); self.assertEqual((v["width"], v["height"]), (1080, 1920))
        self.assertIn("audio", [x["codec_type"] for x in pr["streams"]]); self.assertAlmostEqual(float(pr["format"]["duration"]), c["b"] - c["a"], delta=0.3)
        subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-i", out, "-f", "null", "-"], check=True)
        # the loud moment sits at ~15 s into the clip (after the setup), proving original audio survived the stitch
        vol = subprocess.run(["ffmpeg", "-ss", "15.3", "-t", "1.5", "-i", out, "-af", "volumedetect", "-vn", "-f", "null", "-"], capture_output=True, text=True).stderr
        self.assertGreater(float(vol.split("mean_volume:")[1].split()[0]), -25)
        self.used = c
        aud = os.path.join(os.path.dirname(out), "a.m4a"); R.render_candidate(c["segs"], aud, audio_only=True); self.assertGreater(os.path.getsize(aud), 1000)

    def test_chat_spike_used_only_with_verified_clock(self):
        s = self.ready(); mons = [{"id": "m1", "channel_title": "xQc", "input": "twitch.tv/xqc"}]
        hl = [{"monitor_id": "m1", "start_at": iso(T0 + 21), "end_at": iso(T0 + 23), "peak_at": iso(T0 + 22), "score": 30}]
        c = R.rank_candidates(s, mons, hl, [])[0]; self.assertIn("всплеск чата", c["reason"])
        self.assertAlmostEqual(c["a"], 1, places=3); self.assertAlmostEqual(c["b"], 38, places=3)  # 20 s before, 15 s after, in session time
        s[("xqc", SESS)][1]["mtime"] += 60; R.timeline(SESS, s[("xqc", SESS)])  # clock no longer matches the files
        self.assertNotIn("всплеск чата", R.rank_candidates(s, mons, hl, [])[0]["reason"])

    def test_used_window_is_not_proposed_again(self):
        s = self.ready(); c = R.rank_candidates(s, [], [], [])[0]
        again = R.rank_candidates(s, [], [], [{"channel": "xqc", "session": SESS, "a": int(c["a"])}])
        self.assertTrue(all(int(x["a"]) != int(c["a"]) for x in again))

if __name__ == "__main__": unittest.main(verbosity=2)
