import sys, os, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../public/recorder"))
from speech_select import Utterance as U, stitch_utterances, score_windows, pick_cut

class T(unittest.TestCase):
    def test_stitch_across_boundary(self):
        r = stitch_utterances([U(8, 9.9, "смотри что"), U(10.1, 11, "он сделал?")])
        self.assertEqual(len(r), 1); self.assertEqual(r[0].text, "смотри что он сделал?")
    def test_reaction_selected_silence_not(self):
        hot = [U(0, 3, "look at this?"), U(4, 6, "what? no way"), U(6, 8, "omg wow lol")]
        w = score_windows(hot)[0]; self.assertIsNotNone(pick_cut(w))
        dull = [U(0, 2, "ok driving now")]
        self.assertIsNone(pick_cut(score_windows(dull)[0]))
    def test_speech_chunk_skips_active_and_done(self):
        sys.argv = ["x"]; import importlib.util as iu
        spec = iu.spec_from_file_location("rec", os.path.join(os.path.dirname(__file__), "../../public/recorder/recorder.py")); rec = iu.module_from_spec(spec); spec.loader.exec_module(rec)
        segs = [("a", 0, 10), ("b", 10, 20), ("c", 20, 30)]
        self.assertEqual(rec.speech_chunk(segs, set()), (["a", "b"], 0))
        self.assertEqual(rec.speech_chunk(segs, {"a"}), (["b"], 10))
        self.assertEqual(rec.speech_chunk(segs, {"a", "b"}), ([], None))
    def test_judge_prefilter(self):
        from speech_select import Window
        import importlib.util as iu
        spec = iu.spec_from_file_location("rec2", os.path.join(os.path.dirname(__file__), "../../public/recorder/recorder.py")); rec = iu.module_from_spec(spec); spec.loader.exec_module(rec)
        ws = [Window(0, 30, score=0.1), Window(10, 40, score=0.5)]
        self.assertEqual(rec.judge_pick(ws, set()).start, 10)
        self.assertIsNone(rec.judge_pick(ws, {10}))
unittest.main()
