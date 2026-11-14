"""Verify cache-backed image identity and controlled online bridge completion."""

import hashlib
import importlib.util
import json
import sqlite3
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from bridge import Cache, backfill_image_metadata, make_server
from image_media import QQImageError, QQImages

TOKEN = "t" * 43
ORIGIN = "synthetic-origin"
ACCOUNT = {"uin": "100000000", "uid": "u_synthetic"}


def digest(data):
    return hashlib.md5(data).hexdigest()


class FakeBridge:
    """A loopback stand-in for the in-QQ image bridge protocol."""

    def __init__(
        self,
        home,
        *,
        data_dir=None,
        image=b"\x89PNG\r\n\x1a\noriginal",
        health=None,
        failure=None,
        headers=None,
    ):
        self.token = TOKEN
        self.image = image
        self.failure = failure
        self.headers = headers or {}
        self.requests = []
        self.health = {
            "protocolVersion": "1",
            "instanceId": "instance-1",
            "ready": True,
            "sessionCaptured": True,
            "loggedIn": True,
            "accountUin": ACCOUNT["uin"],
            "accountDataDir": None,
            "qqVersion": "7.0.1-52892",
            "electronVersion": "40.0.0",
            "capabilities": ["fetch-image-original"],
        }
        self.health.update(health or {})
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def authorized(self):
                if self.headers.get("Authorization") != "Bearer " + outer.token:
                    self.reply(
                        401,
                        {
                            "error": "Unauthorized",
                            "code": "UNAUTHORIZED",
                            "retryable": False,
                        },
                    )
                    return False
                return True

            def do_GET(self):
                if not self.authorized():
                    return
                if self.path != "/v1/health":
                    return self.reply(
                        404,
                        {
                            "error": "Not found",
                            "code": "IMAGE_NOT_FOUND",
                            "retryable": False,
                        },
                    )
                return self.reply(200, outer.health)

            def do_POST(self):
                if not self.authorized():
                    return
                length = int(self.headers.get("Content-Length") or 0)
                payload = json.loads(self.rfile.read(length) or b"{}")
                outer.requests.append(payload)
                if self.path != "/v1/images/fetch":
                    return self.reply(
                        404,
                        {
                            "error": "Not found",
                            "code": "IMAGE_NOT_FOUND",
                            "retryable": False,
                        },
                    )
                if outer.failure:
                    return self.reply(*outer.failure)
                return self.reply(200, outer.image)

            def reply(self, status, value):
                body = value if isinstance(value, bytes) else json.dumps(value).encode()
                self.send_response(status)
                self.send_header(
                    "Content-Type",
                    "application/octet-stream"
                    if isinstance(value, bytes)
                    else "application/json",
                )
                self.send_header("Content-Length", str(len(body)))
                for key, header_value in outer.headers.items():
                    self.send_header(key, header_value)
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.health["accountDataDir"] = str(Path(data_dir or home).resolve())
        runtime = Path(home) / "runtime"
        runtime.mkdir(parents=True, mode=0o700, exist_ok=True)
        self.discovery = runtime / "image-bridge.json"
        self.discovery.write_text(
            json.dumps(
                {
                    "protocolVersion": "1",
                    "baseUrl": f"http://127.0.0.1:{self.server.server_port}",
                    "token": self.token,
                    "pid": 1,
                    "instanceId": "instance-1",
                }
            )
        )
        self.discovery.chmod(0o600)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class ImageTests(unittest.TestCase):
    def make_source(
        self, root, account, *, native_id="28070330", kind="group", snapshot=None
    ):
        root = Path(root)
        cache = Cache(root / "bridge")
        with cache.connect() as db:
            db.execute("INSERT INTO state VALUES('bootstrapped','1')")
            db.execute(
                "INSERT INTO sessions(id,name,kind,native_id) VALUES('sid','Synthetic',?,?)",
                (kind, native_id),
            )
            db.execute(
                "INSERT INTO messages(id,session_id,payload,native_id) VALUES('mid','sid','{\"type\":1}',?)",
                (9007199254740993,),
            )
        vault = SimpleNamespace(
            config=lambda: {
                "database_dir": str(account / "nt_db"),
                "account": dict(ACCOUNT),
            },
            current=self.current,
        )
        return QQImages(SimpleNamespace(cache=cache, vault=vault)), cache

    @staticmethod
    def current():
        raise FileNotFoundError("no snapshot")

    def add_metadata(self, cache, item, message="mid"):
        with cache.connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO image_metadata VALUES(?,?)",
                (message, json.dumps(item)),
            )

    def test_duplicate_originals_and_thumbnail_only_messages_remain_viewable(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            account = root / "account"
            original = b"\x89PNG\r\n\x1a\noriginal"
            value = digest(original)
            files = []
            for directory in ("nt_data/Pic/2026-11/Ori", "nt_data/Emoji/Ori"):
                file = account / directory / (value + ".png")
                file.parent.mkdir(parents=True)
                file.write_bytes(original)
                files.append(file)
            thumb = account / "nt_data/Pic/2026-11/Thumb" / (value + "_720.png")
            thumb.parent.mkdir(parents=True)
            thumb.write_bytes(b"\x89PNG\r\n\x1a\nthumbnail")
            impostor = account / "nt_temp" / (value + ".png")
            impostor.parent.mkdir()
            impostor.write_bytes(b"\x89PNG\r\n\x1a\nwrong-image")
            reencoded = files[0].parent / ("f" * 32 + ".jpg")
            reencoded.write_bytes(b"\xff\xd8\xffreencoded-original")
            images, cache = self.make_source(root, account)
            self.add_metadata(
                cache, {"attachments": [{"kind": "image", "name": value + ".png"}]}
            )
            self.add_metadata(
                cache,
                {"attachments": [{"kind": "image", "name": reencoded.name}]},
                "reencoded",
            )
            with cache.connect() as db:
                db.execute(
                    "INSERT INTO messages(id,session_id,payload) VALUES('reencoded','sid','{}')"
                )
            # Multiple cache copies with the same verified digest are one image.
            self.assertEqual(images.resolve("sid", "mid", 0), original)
            self.assertEqual(
                images.resolve("sid", "reencoded", 0), reencoded.read_bytes()
            )
            for file in files:
                file.unlink()
            server = make_server(cache, {"token": "test-token", "port": 0}, images)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            url = f"http://127.0.0.1:{server.server_port}/api/v1/sessions/sid/messages/mid/images/0"

            def get(size):
                return urlopen(
                    Request(
                        url + "?size=" + size,
                        headers={"Authorization": "Bearer test-token"},
                    ),
                    timeout=5,
                )

            try:
                # A QQ thumbnail can render a preview, but cannot become an original.
                with get("preview") as response:
                    self.assertEqual(response.read(), thumb.read_bytes())
                with self.assertRaises(HTTPError) as caught:
                    get("original")
                # The thumbnail is never promoted to an original: with no bridge
                # running the request reports the online capability as unavailable.
                self.assertEqual(caught.exception.code, 503)
                self.assertEqual(
                    json.loads(caught.exception.read())["code"], "QQ_BRIDGE_UNAVAILABLE"
                )
                caught.exception.close()
                with self.assertRaises(HTTPError) as caught:
                    get("invalid")
                self.assertEqual(caught.exception.code, 400)
                caught.exception.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_existing_images_gain_metadata_without_changing_messages(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            cache = Cache(root / "bridge")
            data = root / "decrypted"
            data.mkdir()

            def varint(value):
                result = bytearray()
                while value > 127:
                    result.append((value & 127) | 128)
                    value >>= 7
                return bytes(result + bytes([value]))

            def field(number, value):
                if isinstance(value, int):
                    return varint(number << 3) + varint(value)
                return varint((number << 3) | 2) + varint(len(value)) + value

            body = field(40800, field(45002, 2) + field(45403, b"/synthetic/image.png"))
            with sqlite3.connect(data / "nt_msg.db") as db:
                db.execute('CREATE TABLE group_msg_table("40001" INTEGER,"40800" BLOB)')
                db.execute(
                    "INSERT INTO group_msg_table VALUES(?,?)", (9007199254740993, body)
                )
            with cache.connect() as db:
                db.execute(
                    "INSERT INTO messages(id,session_id,payload,native_table,native_id) VALUES('mid','sid',?, 'group_msg_table',?)",
                    (
                        json.dumps({"type": 1, "content": "old image marker"}),
                        9007199254740993,
                    ),
                )
            backfill_image_metadata(data, cache)
            backfill_image_metadata(data, cache)
            with cache.connect() as db:
                metadata = json.loads(
                    db.execute(
                        "SELECT payload FROM image_metadata WHERE id='mid'"
                    ).fetchone()[0]
                )
                self.assertEqual(
                    metadata["attachments"][0]["native_paths"], ["/synthetic/image.png"]
                )
                self.assertEqual(
                    db.execute("SELECT COUNT(*) FROM messages").fetchone()[0], 1
                )
                self.assertEqual(
                    json.loads(
                        db.execute("SELECT payload FROM messages").fetchone()[0]
                    )["content"],
                    "old image marker",
                )
            # A conversation ingest records the native peer id used by the bridge.
            records = root / "records.db"
            with sqlite3.connect(records) as db:
                db.executescript(
                    """CREATE TABLE actors(id TEXT,name TEXT);
                       CREATE TABLE conversations(id TEXT,name TEXT,kind TEXT,payload TEXT);
                       CREATE TABLE messages(payload TEXT,created_at TEXT);"""
                )
                db.execute(
                    "INSERT INTO conversations VALUES('cid','Group','group',?)",
                    (json.dumps({"native_id": "28070330"}),),
                )
                item = {
                    "id": "item-1",
                    "conversation_id": "cid",
                    "author_id": "u1",
                    "created_at": "2020-01-01T00:00:00Z",
                    "kind": "image",
                    "text": None,
                    "provenance": {
                        "table": "group_msg_table",
                        "local_id": "9007199254740993",
                    },
                }
                db.execute(
                    "INSERT INTO messages VALUES(?,?)",
                    (json.dumps(item), item["created_at"]),
                )
            cache.ingest(records, "account-a", bootstrap=True, now=1800000000)
            with cache.connect() as db:
                self.assertEqual(
                    db.execute(
                        "SELECT native_id FROM sessions WHERE id='cid'"
                    ).fetchone()[0],
                    "28070330",
                )

    def test_cached_images_use_paths_and_never_guess_by_filename(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            account = root / "account"
            media = account / "nt_data"
            media.mkdir(parents=True)
            image = media / "image.png"
            image.write_bytes(b"\x89PNG\r\n\x1a\nsynthetic")
            images, cache = self.make_source(root, account)
            self.add_metadata(
                cache,
                {
                    "text": "caption",
                    "attachments": [
                        {
                            "kind": "image",
                            "name": "image.png",
                            "native_paths": [str(image)],
                        }
                    ],
                },
            )
            self.assertEqual(
                images.resolve("sid", "mid"),
                {"images": [{"index": 0}], "caption": "caption"},
            )
            self.assertEqual(images.resolve("sid", "mid", 0), image.read_bytes())
            with self.assertRaises(QQImageError) as caught:
                images.resolve("wrong-session", "mid", 0)
            self.assertEqual(
                (caught.exception.status, caught.exception.code),
                (404, "MESSAGE_NOT_FOUND"),
            )
            # Without a cached path or original checksum the bridge must not guess.
            with cache.connect() as db:
                db.execute(
                    "UPDATE image_metadata SET payload=? WHERE id='mid'",
                    (
                        json.dumps(
                            {
                                "text": "",
                                "attachments": [
                                    {
                                        "kind": "image",
                                        "name": "image.png",
                                        "native_paths": [],
                                    }
                                ],
                            }
                        ),
                    ),
                )
            with self.assertRaises(QQImageError) as caught:
                images.resolve("sid", "mid", 0)
            self.assertEqual(
                (caught.exception.status, caught.exception.code),
                (409, "IMAGE_REFERENCE_MISMATCH"),
            )
            with cache.connect() as db:
                db.execute(
                    "UPDATE image_metadata SET payload=? WHERE id='mid'",
                    (
                        json.dumps(
                            {
                                "text": "",
                                "attachments": [
                                    {
                                        "kind": "image",
                                        "name": "image.png",
                                        "native_paths": [str(root / "outside.png")],
                                    }
                                ],
                            }
                        ),
                    ),
                )
            with self.assertRaises(QQImageError) as caught:
                images.resolve("sid", "mid", 0)
            self.assertEqual(caught.exception.code, "IMAGE_REFERENCE_MISMATCH")


@unittest.skipUnless(
    importlib.util.find_spec("qq_local_interface"), "Run with the QQ reader virtualenv"
)
class OnlineBridgeTests(unittest.TestCase):
    ORIGINAL = b"\x89PNG\r\n\x1a\nbridge-download"
    MD5 = hashlib.md5(ORIGINAL).hexdigest()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.account = self.root / "account"
        (self.account / "nt_data").mkdir(parents=True)
        self.cache = Cache(self.root / "bridge")
        with self.cache.connect() as db:
            db.execute("INSERT INTO state VALUES('bootstrapped','1')")
            db.execute(
                "INSERT INTO sessions(id,name,kind,native_id) VALUES('sid','Group','group','28070330')"
            )
            db.execute(
                "INSERT INTO messages(id,session_id,payload,native_id) VALUES('mid','sid','{}',?)",
                (9007199254740993,),
            )
        self.vault = SimpleNamespace(
            config=lambda: {
                "database_dir": str(self.account / "nt_db"),
                "account": dict(ACCOUNT),
            },
            current=lambda: (self.root / "records", {"origin": ORIGIN}),
        )
        self.images = QQImages(SimpleNamespace(cache=self.cache, vault=self.vault))
        self.bridge = None

    def tearDown(self):
        if self.bridge:
            self.bridge.close()
        self.temp.cleanup()

    def attach(self, attachment=None):
        item = {
            "text": "",
            "attachments": [
                attachment
                or {
                    "kind": "image",
                    "name": self.MD5.upper() + ".png",
                    "native_paths": [],
                    "native_identifiers": {"45406": _base64(self.MD5)},
                }
            ],
        }
        with self.cache.connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO image_metadata VALUES('mid',?)",
                (json.dumps(item),),
            )

    def bridge_start(self, **options):
        self.bridge = FakeBridge(
            self.cache.root,
            data_dir=self.account,
            image=options.pop("image", self.ORIGINAL),
            **options,
        )
        return self.bridge

    def test_cache_miss_downloads_original_and_reports_native_identity(self):
        self.attach()
        bridge = self.bridge_start()
        self.assertEqual(self.images.resolve("sid", "mid", 0), self.ORIGINAL)
        self.assertEqual(
            bridge.requests[0],
            {
                "chatType": 2,
                "peerUid": "28070330",
                "msgId": "9007199254740993",
                "imageIndex": 0,
                "expectedMd5": self.MD5,
            },
        )

    def test_manifest_and_local_hits_never_touch_the_bridge(self):
        self.attach()
        cached = self.account / "nt_data" / "Pic" / (self.MD5 + ".png")
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(self.ORIGINAL)
        bridge = self.bridge_start()
        self.assertEqual(self.images.resolve("sid", "mid")["images"], [{"index": 0}])
        self.assertEqual(self.images.resolve("sid", "mid", 0), self.ORIGINAL)
        self.assertEqual(bridge.requests, [])

    def test_account_and_data_source_mismatches_block_downloads(self):
        self.attach()
        self.bridge_start(health={"accountUin": "999999999"})
        with self.assertRaises(QQImageError) as caught:
            self.images.resolve("sid", "mid", 0)
        self.assertEqual(
            (caught.exception.status, caught.exception.code),
            (409, "QQ_ACCOUNT_MISMATCH"),
        )
        self.assertEqual(self.bridge.requests, [])

    def test_data_directory_mismatch_blocks_downloads(self):
        self.attach()
        self.bridge_start()
        self.images.source.vault.config = lambda: {
            "database_dir": str(self.root / "other" / "nt_db"),
            "account": dict(ACCOUNT),
        }
        with self.assertRaises(QQImageError) as caught:
            self.images.resolve("sid", "mid", 0)
        self.assertEqual(
            (caught.exception.status, caught.exception.code),
            (409, "QQ_DATA_SOURCE_MISMATCH"),
        )
        self.assertEqual(self.bridge.requests, [])

    def test_offline_and_incompatible_bridges_are_explicit(self):
        self.attach()
        self.bridge_start(
            health={"ready": False, "loggedIn": False, "accountUin": None}
        )
        with self.assertRaises(QQImageError) as caught:
            self.images.resolve("sid", "mid", 0)
        self.assertEqual(
            (caught.exception.status, caught.exception.code), (503, "QQ_OFFLINE")
        )
        self.bridge.close()
        self.bridge_start(health={"capabilities": []})
        with self.assertRaises(QQImageError) as caught:
            self.images.resolve("sid", "mid", 0)
        self.assertEqual(caught.exception.code, "QQ_BRIDGE_INCOMPATIBLE")

    def test_missing_or_stale_discovery_is_unavailable(self):
        self.attach()
        with self.assertRaises(QQImageError) as caught:
            self.images.resolve("sid", "mid", 0)
        self.assertEqual(
            (caught.exception.status, caught.exception.code),
            (503, "QQ_BRIDGE_UNAVAILABLE"),
        )
        bridge = self.bridge_start()
        bridge.discovery.chmod(0o644)
        with self.assertRaises(QQImageError) as caught:
            self.images.resolve("sid", "mid", 0)
        self.assertEqual(caught.exception.code, "QQ_BRIDGE_INCOMPATIBLE")

    def test_bridge_business_errors_and_integrity_failures_are_controlled(self):
        self.attach()
        self.bridge_start(
            failure=(
                429,
                {
                    "error": "QQ image download is busy",
                    "code": "QQ_IMAGE_BUSY",
                    "retryable": True,
                },
            )
        )
        with self.assertRaises(QQImageError) as caught:
            self.images.resolve("sid", "mid", 0)
        self.assertEqual(
            (
                caught.exception.status,
                caught.exception.code,
                caught.exception.retryable,
            ),
            (429, "QQ_IMAGE_BUSY", True),
        )
        self.bridge.close()
        self.bridge_start(image=b"\x89PNG\r\n\x1a\nother")
        with self.assertRaises(QQImageError) as caught:
            self.images.resolve("sid", "mid", 0)
        self.assertEqual(
            (caught.exception.status, caught.exception.code),
            (502, "IMAGE_INTEGRITY_FAILED"),
        )

    def test_expected_md5_comes_from_native_identifiers_before_name(self):
        self.attach()
        bridge = self.bridge_start()
        self.images.resolve("sid", "mid", 0)
        self.assertEqual(bridge.requests[0]["expectedMd5"], self.MD5)

    def test_native_variant_requires_both_reference_and_actual_byte_verification(self):
        self.attach()
        variant = b"\x89PNG\r\n\x1a\nQQ-full-size-variant"
        valid = {
            "X-QQ-Image-Verification": "native-image-v1",
            "X-QQ-Image-Reference-MD5": self.MD5,
            "X-QQ-Image-Content-MD5": digest(variant),
        }
        bridge = self.bridge_start(image=variant, headers=valid.copy())
        self.assertEqual(self.images.resolve("sid", "mid", 0), variant)
        for key, value in [
            ("X-QQ-Image-Reference-MD5", digest(b"other-message")),
            ("X-QQ-Image-Content-MD5", digest(b"corrupted-body")),
            ("X-QQ-Image-Verification", "unknown-mode"),
        ]:
            with self.subTest(header=key):
                bridge.headers = {**valid, key: value}
                with self.assertRaises(QQImageError) as caught:
                    self.images.resolve("sid", "mid", 0)
                self.assertEqual(caught.exception.code, "IMAGE_INTEGRITY_FAILED")
        bridge.headers = {}
        with self.assertRaises(QQImageError) as caught:
            self.images.resolve("sid", "mid", 0)
        self.assertEqual(caught.exception.code, "IMAGE_INTEGRITY_FAILED")

    def test_collector_returns_controlled_error_to_chatlab(self):
        class Failing:
            def resolve(self, *_args, **_kwargs):
                raise QQImageError(409, "QQ_ACCOUNT_MISMATCH")

        server = make_server(self.cache, {"token": "test-token", "port": 0}, Failing())
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"http://127.0.0.1:{server.server_port}/api/v1/sessions/sid/messages/mid/images/0"
            request = Request(url, headers={"Authorization": "Bearer test-token"})
            with self.assertRaises(HTTPError) as caught:
                urlopen(request, timeout=5)
            self.assertEqual(caught.exception.code, 409)
            self.assertEqual(
                json.loads(caught.exception.read()),
                {
                    "error": "QQ account differs from the data source account",
                    "code": "QQ_ACCOUNT_MISMATCH",
                    "retryable": False,
                },
            )
            caught.exception.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


def _base64(md5_hex):
    import base64

    return base64.b64encode(bytes.fromhex(md5_hex)).decode()


if __name__ == "__main__":
    unittest.main()
