"""Offline Buffer contract tests only: never contact Buffer or publish a real post."""
import importlib.util, os, tempfile, unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("agent", os.path.join(os.path.dirname(__file__), "../../public/vps/inverk_agent.py"))
A = importlib.util.module_from_spec(spec); spec.loader.exec_module(A)
CHANNEL = "6b00651cece6dfde5f33640c"

class TikTok(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.saved = A.STATE_DIR; A.STATE_DIR = self.temp.name
        self.args = {"job_id": "22222222-2222-4222-8222-222222222222", "channel_id": CHANNEL, "authorized_channel_id": CHANNEL, "text": "ready", "video_url": "https://example.org/clip.mp4", "mode": "publish"}
    def tearDown(self): A.STATE_DIR = self.saved; self.temp.cleanup()
    def test_explicit_account_and_connected_tiktok(self):
        with patch.object(A, "gql") as gql:
            with self.assertRaises(RuntimeError): A.op_ready_post({}, {**self.args, "authorized_channel_id": "other"}, "1", {"done": {}})
            gql.assert_not_called()
        with patch.object(A, "gql", return_value={"channel": {"id": CHANNEL, "service": "tiktok", "isDisconnected": True, "isLocked": False}}) as gql:
            with self.assertRaises(RuntimeError): A.op_ready_post({}, self.args, "1", {"done": {}})
            self.assertEqual(gql.call_count, 1)
    def test_publish_schedule_and_draft_modes(self):
        for mode, expected in [("publish", "shareNow"), ("schedule", "customScheduled"), ("draft", "addToQueue")]:
            inputs = []
            def gql(c, q, v=None, timeout=30):
                if q == A.Q_CHANNEL: return {"channel": {"id": CHANNEL, "service": "tiktok", "isDisconnected": False, "isLocked": False}}
                inputs.append(v["input"]); return {"createPost": {"post": {"id": "p1"}}}
            with patch.object(A, "gql", side_effect=gql):
                r = A.op_ready_post({}, {**self.args, "mode": mode, "due_at": "2099-01-01T00:00:00Z"}, mode, {"done": {}})
            self.assertEqual(inputs[0]["mode"], expected); self.assertEqual(inputs[0]["saveToDraft"], mode == "draft")
            self.assertFalse(r["publication_confirmed"])
    def test_timeout_barrier_survives_restart(self):
        with patch.object(A, "gql", side_effect=TimeoutError):
            with self.assertRaisesRegex(RuntimeError, "ambiguous"): A.op_buffer_draft({}, self.args, "timeout", {"done": {}})
        with patch.object(A, "gql") as gql:
            with self.assertRaisesRegex(RuntimeError, "ambiguous"): A.op_buffer_draft({}, self.args, "timeout", A.load_state())
            gql.assert_not_called()
    def test_real_metrics_only_and_statuses_mirrored(self):
        mirror = {}
        def gql(c, q, v=None, timeout=30):
            if q == A.Q_ORGS: return {"account": {"organizations": [{"id": "o1"}]}}
            if q == A.Q_CHANNELS: return {"channels": [{"id": CHANNEL, "service": "tiktok", "name": "test"}]}
            status = next(s for s in ("sent", "draft", "scheduled") if "status: [%s]" % s in q)
            return {"posts": {"edges": [{"node": {"id": status, "status": status, "channelId": CHANNEL, "metrics": [{"type": "views", "name": "Views", "value": 123, "unit": "count"}], "unexpected_secret": "never mirror"}}], "pageInfo": {"hasNextPage": False}}}
        def call(c, b, tok): mirror[b["kind"]] = b["rows"]
        with patch.object(A, "gql", side_effect=gql), patch.object(A, "call", side_effect=call), patch.object(A, "buffer_key", return_value="test"):
            r = A.mirror_buffer({}, "test")
        self.assertEqual(r["posts"], 3)
        self.assertIsNone(mirror["buffer:channels"][0]["data"]["followers"])
        self.assertEqual(mirror["buffer:posts"][0]["data"]["metrics"][0]["value"], 123)
        self.assertNotIn("never mirror", str(mirror))
    def test_refresh_429_is_failure_not_fake_success(self):
        import urllib.error
        with patch.object(A, "gql", side_effect=urllib.error.HTTPError(A.BUFFER_URL, 429, "rate limit", {}, None)), patch.object(A, "call"), patch.object(A, "buffer_key", return_value="test"):
            with self.assertRaisesRegex(RuntimeError, "HTTP 429"): A.mirror_buffer({}, "test")
    def test_check_actual_status_is_read_only(self):
        with patch.object(A, "gql", return_value={"post": {"id": CHANNEL, "status": "error", "error": {"message": "disconnected"}}}) as gql:
            r = A.op_check_post({}, {"post_id": CHANNEL}, "test")
        self.assertTrue(gql.call_args.args[1].startswith("query Status"))
        self.assertEqual(r["status"], "error"); self.assertEqual(r["error"], "disconnected")

if __name__ == "__main__": unittest.main()