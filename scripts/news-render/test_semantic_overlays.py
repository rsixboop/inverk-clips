import unittest
from unittest.mock import patch
from semantic_overlays import validate_cues, cue_state
from overlay_assets import ensure_overlays
from render_overlay_news import validate_episode

class OptionalOverlays(unittest.TestCase):
    def test_zero_no_paid_calls(self):
        with patch("overlay_assets.queue", side_effect=AssertionError("Paid call")):
            self.assertEqual(ensure_overlays([],"unused","test"),([],0.0))
        self.assertEqual(validate_cues([],6),[])
    def test_one_timed_object(self):
        c=dict(purpose="download stays locked",speech="not early access",start=1,action=2,after=4,end=5,before="a",active="b",result="c",box=[0,.8,1,.2])
        self.assertEqual(len(validate_cues([c],6)),1)
        self.assertEqual(cue_state(c,3),("active",.5))
        self.assertEqual(cue_state(c,4.1),("result",1))
        self.assertIsNone(cue_state(c,5))
    def test_no_four_scene_or_object_requirement(self):
        ep=dict(mode="overlay",source_url="https://www.rockstargames.com/VI/only-in-leonida",scenes=[dict(background="vc11",narration="test")])
        validate_episode(ep)
        ep["scenes"][0]["overlay"]=dict(animation="rise",anchor=[.5,.5],width=.4)
        validate_episode(ep)
if __name__=="__main__":unittest.main()