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
unittest.main()
