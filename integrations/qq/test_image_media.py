"""Verify cache-backed image identity without reading personal QQ data."""

import hashlib
import importlib.util
import json
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from bridge import Cache, backfill_image_metadata, make_server
from image_media import QQImages


@unittest.skipUnless(
    importlib.util.find_spec("qq_local_interface"), "Run with the QQ reader virtualenv"
)
class ImageTests(unittest.TestCase):
    def test_duplicate_originals_and_thumbnail_only_messages_remain_viewable(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            account = root / "account"
            original = b"\x89PNG\r\n\x1a\noriginal"
            digest = hashlib.md5(original).hexdigest()
            files = []
            for directory in ("nt_data/Pic/2026-11/Ori", "nt_data/Emoji/Ori"):
                file = account / directory / (digest + ".png")
                file.parent.mkdir(parents=True)
                file.write_bytes(original)
                files.append(file)
            thumb = account / "nt_data/Pic/2026-11/Thumb" / (digest + "_720.png")
            thumb.parent.mkdir(parents=True)
            thumb.write_bytes(b"\x89PNG\r\n\x1a\nthumbnail")
            impostor = account / "nt_temp" / (digest + ".png")
            impostor.parent.mkdir()
            impostor.write_bytes(b"\x89PNG\r\n\x1a\nwrong-image")
            reencoded = files[0].parent / ("f" * 32 + ".jpg")
            reencoded.write_bytes(b"\xff\xd8\xffreencoded-original")
            cache = Cache(root / "bridge")
            with cache.connect() as db:
                db.execute("INSERT INTO state VALUES('bootstrapped','1')")
                db.execute(
                    "INSERT INTO messages(id,session_id,payload) VALUES('mid','sid','{}')"
                )
                db.execute(
                    "INSERT INTO image_metadata VALUES('mid',?)",
                    (
                        json.dumps(
                            {"attachments": [{"kind": "image", "name": digest + ".png"}]}
                        ),
                    ),
                )
                db.execute(
                    "INSERT INTO messages(id,session_id,payload) VALUES('reencoded','sid','{}')"
                )
                db.execute(
                    "INSERT INTO image_metadata VALUES('reencoded',?)",
                    (
                        json.dumps(
                            {"attachments": [{"kind": "image", "name": reencoded.name}]}
                        ),
                    ),
                )
            images = QQImages(
                SimpleNamespace(
                    cache=cache,
                    vault=SimpleNamespace(
                        config=lambda: {"database_dir": str(account / "db")}
                    ),
                )
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
                self.assertEqual(caught.exception.code, 404)
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

    def test_cached_images_use_paths_and_never_guess_by_filename(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            account = root / "account"
            media = account / "nt_data"
            media.mkdir(parents=True)
            image = media / "image.png"
            image.write_bytes(b"\x89PNG\r\n\x1a\nsynthetic")
            cache = Cache(root / "bridge")
            source = SimpleNamespace(
                cache=cache,
                vault=SimpleNamespace(
                    config=lambda: {"database_dir": str(account / "db")},
                    source_id="test",
                ),
            )
            images = QQImages(source)
            with cache.connect() as db:
                db.execute(
                    "INSERT INTO messages(id,session_id,payload) VALUES('mid','sid','{}')"
                )
                item = {
                    "text": "caption",
                    "attachments": [
                        {
                            "kind": "image",
                            "name": "image.png",
                            "native_paths": [str(image)],
                        }
                    ],
                }
                db.execute(
                    "INSERT INTO image_metadata VALUES('mid',?)", (json.dumps(item),)
                )
            self.assertEqual(
                images.resolve("sid", "mid"),
                {"images": [{"index": 0}], "caption": "caption"},
            )
            self.assertEqual(images.resolve("sid", "mid", 0), image.read_bytes())
            with self.assertRaises(KeyError):
                images.resolve("wrong-session", "mid", 0)
            item["attachments"][0]["native_paths"] = []
            with cache.connect() as db:
                db.execute(
                    "UPDATE image_metadata SET payload=? WHERE id='mid'",
                    (json.dumps(item),),
                )
            with self.assertRaises(KeyError):
                images.resolve("sid", "mid", 0)
            item["attachments"][0]["native_paths"] = [str(root / "outside.png")]
            with cache.connect() as db:
                db.execute(
                    "UPDATE image_metadata SET payload=? WHERE id='mid'",
                    (json.dumps(item),),
                )
            with self.assertRaises(KeyError):
                images.resolve("sid", "mid", 0)


if __name__ == "__main__":
    unittest.main()
