"""Reliability fixtures; no live/provider inference, no production clips."""
import base64, os, shutil, subprocess, sys, tempfile, time, unittest
from unittest.mock import patch
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'recorder'))
import recorder as R
class Reliability(unittest.TestCase):
    def test_unknown_never_starts_but_retains_recent_capture(self):
        m={'id':'m','media_mode':'recorder','record_url':'https://twitch.tv/x','enabled':True,'capture_eligible':False,'observation':'unknown','confirmed_live_at':R.utc(time.time()-30)}
        self.assertFalse(R.should_capture(m));self.assertTrue(R.should_capture(m,existing=True));self.assertFalse(R.should_capture(m,existing=True,now=time.time()+301))
    def test_pause_and_archive_override_live(self):
        m={'media_mode':'recorder','record_url':'https://twitch.tv/x','capture_eligible':True}
        self.assertFalse(R.should_capture(m,paused=True));self.assertFalse(R.should_capture({**m,'archived_at':'2026-11-27T21:48:00Z'}))
    def test_api_failure_preserves_sessions(self):
        sentinel=object();old=R.procs;R.procs={'m':sentinel}
        try:
            with patch.object(R,'api',return_value={'error':'api/monitors: network timeout'}):R.sync_monitors()
            self.assertIs(R.procs.get('m'),sentinel)
        finally:R.procs=old
    def test_fresh_mp4_extraction_uses_exact_file_and_timestamps(self):
        R.FFMPEG=shutil.which('ffmpeg')
        with tempfile.TemporaryDirectory() as t:
            mp4=os.path.join(t,'fresh.mp4')
            subprocess.run([R.FFMPEG,'-loglevel','error','-f','lavfi','-i','testsrc2=s=320x180:r=30:d=3','-f','lavfi','-i','sine=f=700:d=3','-c:v','libx264','-c:a','aac',mp4],check=True)
            class Response:
                def __enter__(self):self.f=open(mp4,'rb');return self
                def __exit__(self,*a):self.f.close()
                def read(self,n):return self.f.read(n)
            sent=[]
            def api(action,**kw):sent.append((action,kw));return {'ok':True}
            with patch.object(R.urllib.request,'urlopen',return_value=Response()),patch.object(R,'api',side_effect=api):
                duration,count=R.analyze_file({'id':'a','claim':'c','url':'https://owned.test/fresh.mp4'})
            self.assertAlmostEqual(duration,3,delta=.1);self.assertEqual(count,8)
            action,data=sent[0];self.assertEqual(action,'analysis_media')
            wav=base64.b64decode(data['audio']);self.assertEqual(wav[:4],b'RIFF');self.assertEqual(wav[8:12],b'WAVE');self.assertGreater(len(wav),90000)
            frames=data['frames'];self.assertTrue(all(0<f['second']<duration for f in frames));self.assertNotEqual(frames[0]['jpeg'],frames[-1]['jpeg'])
if __name__=='__main__':unittest.main(verbosity=2)
