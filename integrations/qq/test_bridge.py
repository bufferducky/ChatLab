"""Guard against missing late QQ history, duplicates, and unauthenticated reads."""

import json
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from bridge import Cache, convert_message, extract_new_rows, make_server


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.cache = Cache(self.root / "cache")
        self.records = self.root / "records.db"
        with sqlite3.connect(self.records) as db:
            db.executescript("""CREATE TABLE actors(id TEXT,name TEXT);
                CREATE TABLE conversations(id TEXT,name TEXT,kind TEXT);
                CREATE TABLE messages(payload TEXT,created_at TEXT);
                INSERT INTO actors VALUES('u1','Alice');
                INSERT INTO conversations VALUES('c1','Test group','group');""")

    def tearDown(self):
        self.temp.cleanup()

    def add(
        self,
        native_id,
        stamp="2020-01-01T00:00:00Z",
        kind="text",
        text="same text\nsecond line",
    ):
        item = {
            "id": "item-" + str(native_id),
            "conversation_id": "c1",
            "author_id": "u1",
            "created_at": stamp,
            "kind": kind,
            "text": text,
            "provenance": {"table": "group_msg_table", "local_id": str(native_id)},
        }
        with sqlite3.connect(self.records) as db:
            db.execute("INSERT INTO messages VALUES(?,?)", (json.dumps(item), stamp))

    def test_late_lower_ids_duplicate_bodies_and_restart(self):
        self.add(9007199254740993)
        self.add(9007199254740994)
        self.cache.ingest(self.records, "account-a", bootstrap=True, now=1800000000)
        initial = self.cache.messages("c1", limit=1)
        self.assertTrue(initial["sync"]["hasMore"])
        # New native IDs can be smaller and have an old send timestamp.
        self.add(2, stamp="2019-01-01T00:00:00Z", kind="image", text=None)
        result = self.cache.ingest(self.records, "account-a", now=1800000200)
        self.assertEqual(result["changedMessages"], 1)
        tail = self.cache.messages("c1", offset=initial["sync"]["nextOffset"])
        self.assertEqual(len(tail["messages"]), 2)
        self.assertEqual(
            len(
                {m["platformMessageId"] for m in initial["messages"] + tail["messages"]}
            ),
            3,
        )
        late = self.cache.messages("c1", since=1800000000)
        self.assertEqual([m["type"] for m in late["messages"]], [1])
        self.assertEqual(late["messages"][0]["content"], "[QQ image]")
        self.assertEqual(late["messages"][0]["timestamp"], 1546300800)
        restarted = Cache(self.cache.root)
        self.assertEqual(
            restarted.ingest(self.records, "account-a")["changedMessages"], 0
        )
        self.assertEqual(restarted.status()["messages"], 3)
        with self.assertRaises(ValueError):
            restarted.ingest(self.records, "other-account")
        self.assertEqual(restarted.status()["messages"], 3)

    def test_failed_ingest_is_atomic(self):
        self.add(1)
        self.add(2)
        with sqlite3.connect(self.records) as db:
            db.execute(
                "UPDATE messages SET payload=json_set(payload,'$.provenance.local_id','invalid') WHERE rowid=2"
            )
        with self.assertRaises(ValueError):
            self.cache.ingest(self.records, "account-a")
        self.assertFalse(self.cache.status()["ready"])
        self.assertEqual(self.cache.status()["messages"], 0)

    def test_display_uses_body_instead_of_search_identifiers_and_duplicate_segments(
        self,
    ):
        item = {
            "id": "reply",
            "created_at": "2020-01-01T00:00:00Z",
            "kind": "mixed",
            "text": "@Name 大胆点，10分钟",
            "search_text": "@Name 大胆点，10分钟\nu_synthetic\n@Name\n\n 大胆点，10分钟",
            "elements": [
                {"kind": "quote"},
                {"kind": "text", "text": "@Name"},
                {"kind": "text", "text": " 大胆点，10分钟"},
            ],
        }
        result = convert_message(item, "Alice", "account-a")
        self.assertEqual(result["content"], "@Name 大胆点，10分钟")
        self.assertEqual(result["type"], 25)
        item["attachments"] = [{"kind": "image"}]
        self.assertEqual(convert_message(item, "Alice", "account-a")["type"], 1)
        item["attachments"] = []
        item.update(
            kind="text", text="first line\nsecond line", elements=[{"kind": "text"}]
        )
        self.assertEqual(
            convert_message(item, "Alice", "account-a")["content"],
            "first line\nsecond line",
        )

    def test_quote_backfill_resolves_sequence_inside_its_conversation_without_reinserting(
        self,
    ):
        from bridge import backfill_message_content

        def varint(value):
            out = bytearray()
            while value > 127:
                out.append((value & 127) | 128)
                value >>= 7
            return bytes(out + bytes([value]))

        def field(number, value):
            if isinstance(value, str):
                value = value.encode()
            if isinstance(value, int):
                return varint(number << 3) + varint(value)
            return varint((number << 3) | 2) + varint(len(value)) + value

        text = lambda value: field(40800, field(45002, 1) + field(45101, value))
        quote = (
            field(
                40800,
                field(45002, 7)
                + field(47402, 10)
                + field(47404, 1000)
                + field(40020, "u_target"),
            )
            + field(
                40800,
                field(45002, 1) + field(45101, "@Name") + field(45105, "u_target"),
            )
            + text(" reply body")
        )
        for native_id in (100, 101, 200):
            self.add(native_id, kind="mixed", text="old body\nu_target\nrepeated body")
        self.cache.ingest(self.records, "account-a")
        data = self.root / "native"
        data.mkdir()
        with sqlite3.connect(data / "nt_msg.db") as db:
            db.execute("""CREATE TABLE group_msg_table("40001" INTEGER,"40003" INTEGER,
                       "40030" INTEGER,"40020" TEXT,"40050" INTEGER,"40800" BLOB)""")
            db.executemany(
                "INSERT INTO group_msg_table VALUES(?,?,?,?,?,?)",
                [
                    (200, 10, 999, "u_target", 1000, text("other conversation")),
                    (100, 10, 123, "u_target", 1000, text("quoted message")),
                    (101, 11, 123, "u_sender", 1100, quote),
                ],
            )
        self.assertEqual(backfill_message_content(data, self.cache), 3)
        with self.cache.connect() as db:
            row = db.execute(
                "SELECT seq,payload FROM messages WHERE native_id=101"
            ).fetchone()
            payload = json.loads(row["payload"])
            self.assertEqual(payload["content"], "@Name reply body")
            self.assertEqual(payload["type"], 25)
            self.assertEqual(payload["replyToMessageId"], "qq:account-a:item-100")
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM messages").fetchone()[0], 3
            )
        self.assertEqual(backfill_message_content(data, self.cache), 0)
        self.add(102, kind="mixed", text="another old reply")
        self.cache.ingest(self.records, "account-a")
        with sqlite3.connect(data / "nt_msg.db") as db:
            db.execute(
                "INSERT INTO group_msg_table VALUES(?,?,?,?,?,?)",
                (102, 12, 123, "u_sender", 1101, quote),
            )
        self.assertEqual(backfill_message_content(data, self.cache), 1)
        with self.cache.connect() as db:
            payload = json.loads(
                db.execute(
                    "SELECT payload FROM messages WHERE native_id=102"
                ).fetchone()[0]
            )
            self.assertEqual(payload["replyToMessageId"], "qq:account-a:item-100")

    def test_pull_watermark_does_not_outrun_committed_observations(self):
        self.add(1)
        self.cache.ingest(self.records, "account-a", now=1800000000)
        with patch("bridge.time.time", return_value=1900000000):
            page = self.cache.messages("c1")
        self.assertEqual(page["sync"]["nextSince"], 1800000000)

    def test_media_types_match_chatlab_and_plain_text_is_preserved(self):
        for kind, expected in [
            ("text", 0),
            ("image", 1),
            ("voice", 2),
            ("video", 3),
            ("file", 4),
            ("sticker", 5),
            ("forward", 26),
            ("mixed", 99),
        ]:
            with self.subTest(kind=kind):
                converted = convert_message(
                    {
                        "created_at": "2020-01-01T00:00:00Z",
                        "id": "m1",
                        "kind": kind,
                        "text": "line1\nline2",
                    },
                    "Alice",
                    "a",
                )
                self.assertEqual(converted["type"], expected)
                self.assertEqual(converted["content"], "line1\nline2")
        undated = convert_message(
            {"created_at": None, "id": "m0", "kind": "system", "text": None}, None, "a"
        )
        self.assertEqual(undated["timestamp"], 1)

    def test_native_delta_finds_old_ids_and_keeps_source_intact(self):
        self.add(9007199254740993)
        self.cache.ingest(self.records, "account-a")
        data = self.root / "data"
        data.mkdir()
        with sqlite3.connect(data / "nt_msg.db") as db:
            for table in ("group_msg_table", "c2c_msg_table"):
                db.execute(
                    f'CREATE TABLE {table}("40001" INTEGER PRIMARY KEY,"40050" INTEGER)'
                )
            db.executemany(
                "INSERT INTO group_msg_table VALUES(?,?)",
                [(9007199254740993, 10), (2, 1)],
            )
            # IDs are namespaced by table, not assumed globally unique.
            db.execute("INSERT INTO c2c_msg_table VALUES(?,?)", (9007199254740993, 10))
        extract_new_rows(data, self.cache)
        with sqlite3.connect(data / "nt_msg.db") as db:
            self.assertEqual(
                db.execute('SELECT "40001" FROM group_msg_table').fetchall(), [(2,)]
            )
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM c2c_msg_table").fetchone()[0], 1
            )

    def test_http_auth_and_keyset_paging(self):
        self.add(1)
        self.add(2)
        self.cache.ingest(self.records, "account-a")
        server = make_server(self.cache, {"token": "test-token", "port": 0})
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            with self.assertRaises(HTTPError) as caught:
                urlopen(base + "/api/v1/sessions")
            self.assertEqual(caught.exception.code, 401)

            def get(path):
                with urlopen(
                    Request(base + path, headers={"Authorization": "Bearer test-token"})
                ) as response:
                    return json.load(response)

            self.assertEqual(get("/api/v1/sessions")["sessions"][0]["messageCount"], 2)
            first = get("/api/v1/sessions/c1/messages?limit=1")
            second = get(
                "/api/v1/sessions/c1/messages?limit=1&offset="
                + str(first["sync"]["nextOffset"])
            )
            self.assertNotEqual(
                first["messages"][0]["platformMessageId"],
                second["messages"][0]["platformMessageId"],
            )
            self.assertFalse(second["sync"]["hasMore"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
