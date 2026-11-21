"""Manual update must collect new Telegram messages, not just reread the archive."""

import json
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from bridge import Cache, CollectionController, make_server
from test_bridge import payload


class ManualCollectionTests(unittest.TestCase):
    def test_http_collect_waits_for_new_messages_and_joins_the_running_round(self):
        with tempfile.TemporaryDirectory() as root:
            cache = Cache(root)
            cache.bind_account(1)
            sid = cache.session(1, -1002, "Test", "group")
            started, release, finished = (threading.Event() for _ in range(3))

            def collect():
                started.set()
                if not release.wait(5):
                    raise TimeoutError()
                changed = cache.ingest(sid, [payload(1)])
                cache.finish()
                return {"changedMessages": changed}

            controller = CollectionController(collect)
            original_run = controller._run

            def run():
                try:
                    original_run()
                finally:
                    finished.set()

            controller._run = run
            server = make_server(
                cache, {"token": "test", "port": 0}, collection=controller
            )
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"

            def request(path, method="GET", token="test"):
                with urlopen(
                    Request(
                        base + path,
                        method=method,
                        headers={"Authorization": "Bearer " + token},
                    )
                ) as response:
                    return json.load(response)

            try:
                self.assertIn("collect", request("/health")["capabilities"])
                for method in ("GET", "POST"):
                    with self.assertRaises(HTTPError) as caught:
                        request("/api/v1/collect", method, token="wrong")
                    self.assertEqual(caught.exception.code, 401)
                first = request("/api/v1/collect", "POST")
                self.assertTrue(started.wait(2))
                second = request("/api/v1/collect", "POST")
                self.assertEqual(second["collectId"], first["collectId"])
                self.assertTrue(second["alreadyRunning"])
                self.assertEqual(request("/api/v1/collect")["state"], "running")
                release.set()
                self.assertTrue(finished.wait(2))
                status = request("/api/v1/collect")
                self.assertEqual((status["state"], status["changed"]), ("done", 1))
                self.assertTrue(request("/health")["fresh"])
                with patch("bridge.time.time", return_value=time.time() + 3601):
                    health = request("/health")
                self.assertTrue(health["ready"])
                self.assertFalse(health["fresh"])
                self.assertGreater(health["refreshAgeSeconds"], 3600)
                messages = request(f"/api/v1/sessions/{sid}/messages")["messages"]
                self.assertEqual(messages, [payload(1)])
            finally:
                release.set()
                finished.wait(2)
                server.shutdown()
                server.server_close()
                thread.join()

    def test_failure_or_telegram_cooldown_cannot_report_success(self):
        for callback, error in (
            (lambda: {"deferred": True}, "TelegramRateLimited"),
            (lambda: (_ for _ in ()).throw(ConnectionError()), "ConnectionError"),
        ):
            controller = CollectionController(callback)
            # Exercise the same completion path without timing-dependent polling.
            controller._run()
            self.assertEqual(controller.snapshot()["state"], "failed")
            self.assertEqual(controller.snapshot()["error"], error)
