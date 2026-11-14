#!/usr/bin/env python3
"""Expose authenticated local QQ snapshots through the ChatLab Pull protocol."""

from __future__ import annotations

import argparse
import contextlib
import hmac
import json
import os
import secrets
import sqlite3
import sys
import tempfile
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

DEFAULT_HOME = Path.home() / ".local/share/chatlab-qq"
TYPE_MAP = {
    "text": 0,
    "image": 1,
    "voice": 2,
    "video": 3,
    "file": 4,
    "sticker": 5,
    "card": 7,
    "forward": 26,
    "quote": 25,
    "call": 23,
    "location": 8,
    "system": 80,
}
CORE_DATABASES = ("nt_msg.db", "profile_info.db", "group_info.db")


@contextlib.contextmanager
def readonly(path):
    db = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        yield db
    finally:
        db.close()


def message_content(item):
    """Search text includes native identifiers and must not replace the body."""
    return (
        item.get("text")
        or item.get("search_text")
        or item.get("title")
        or f"[QQ {item['kind']}]"
    )


def message_type(item):
    if any(element.get("kind") == "quote" for element in item.get("elements", [])):
        attachments = item.get("attachments", [])
        if attachments and all(
            attachment.get("kind") == "image" for attachment in attachments
        ):
            return 1
        if not attachments:
            return 25
    return TYPE_MAP.get(item["kind"], 99)


def convert_message(item, name, origin):
    # ChatLab incremental imports require positive timestamps. One second after
    # epoch is the explicit unknown-time sentinel, not an inferred send date.
    stamp = (
        int(datetime.fromisoformat(item["created_at"]).timestamp())
        if item["created_at"]
        else 1
    )
    content = message_content(item)
    return {
        "platformMessageId": f"qq:{origin}:{item['id']}",
        "sender": item.get("author_id") or "qq:unknown",
        "accountName": name or item.get("author_id") or "QQ",
        "timestamp": stamp,
        "type": message_type(item),
        "content": content,
    }


def native_peer(conversation):
    """Return the QQ-native conversation id used by getMsgsByMsgId/downloadRichMedia."""
    try:
        payload = json.loads(conversation["payload"])
    except (IndexError, KeyError, TypeError, ValueError):
        return None
    value = payload.get("native_id") if isinstance(payload, dict) else None
    return str(value) if value not in (None, "") else None


class Cache:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.root / "messages.sqlite3"
        self.lock = threading.RLock()
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT);
                CREATE TABLE IF NOT EXISTS sessions(
                    id TEXT PRIMARY KEY,name TEXT,kind TEXT,message_count INTEGER DEFAULT 0,
                    last_stamp INTEGER,member_count INTEGER DEFAULT 0,native_id TEXT);
                CREATE TABLE IF NOT EXISTS messages(
                    seq INTEGER PRIMARY KEY,id TEXT UNIQUE,session_id TEXT,observed INTEGER,
                    stamp INTEGER,sender TEXT,payload TEXT,native_table TEXT,native_id INTEGER,
                    UNIQUE(native_table,native_id));
                CREATE INDEX IF NOT EXISTS session_seq ON messages(session_id,seq);
                CREATE INDEX IF NOT EXISTS session_observed ON messages(session_id,observed,seq);
                CREATE TABLE IF NOT EXISTS image_metadata(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
            """)
            if "native_id" not in {
                row[1] for row in db.execute("PRAGMA table_info(sessions)")
            }:
                db.execute("ALTER TABLE sessions ADD COLUMN native_id TEXT")
        self.path.chmod(0o600)

    @contextlib.contextmanager
    def connect(self):
        db = sqlite3.connect(self.path.as_uri(), uri=True, timeout=120)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def ingest(self, records, origin, *, bootstrap=False, now=None):
        changed = 0
        with self.lock, self.connect() as db, readonly(records) as source:
            state = dict(db.execute("SELECT key,value FROM state"))
            if state.get("origin", origin) != origin:
                raise ValueError("QQ account changed; use a separate bridge directory")
            clock = max(
                int(time.time() if now is None else now), int(state.get("clock", 0)) + 1
            )
            latest = source.execute(
                "SELECT created_at FROM messages ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            if latest and latest[0]:
                latest_stamp = int(datetime.fromisoformat(latest[0]).timestamp())
                clock = max(clock, latest_stamp + (120 if bootstrap else 0))
            actors = dict(source.execute("SELECT id,name FROM actors"))
            columns = {
                row[1] for row in source.execute("PRAGMA table_info(conversations)")
            }
            selector = (
                "id,name,kind,payload" if "payload" in columns else "id,name,kind"
            )
            conversations = {
                r["id"]: r
                for r in source.execute(f"SELECT {selector} FROM conversations")
            }
            affected = set()
            for row in source.execute("SELECT payload FROM messages ORDER BY rowid"):
                item = json.loads(row[0])
                payload = convert_message(
                    item, actors.get(item.get("author_id")), origin
                )
                if item.get("attachments"):
                    db.execute(
                        "INSERT OR REPLACE INTO image_metadata VALUES(?,?)",
                        (
                            payload["platformMessageId"],
                            json.dumps(
                                {
                                    "text": item.get("text"),
                                    "attachments": item["attachments"],
                                },
                                ensure_ascii=False,
                            ),
                        ),
                    )
                # Old bootstrap history sits outside the pull engine's overlap window.
                observed = clock - 120 if bootstrap else clock
                cid = item["conversation_id"]
                if cid not in affected:
                    conv = conversations[cid]
                    db.execute(
                        """INSERT INTO sessions(id,name,kind,native_id) VALUES(?,?,?,?)
                        ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,
                        native_id=COALESCE(excluded.native_id,sessions.native_id)""",
                        (
                            cid,
                            conv["name"] or cid,
                            "group" if conv["kind"] == "group" else "private",
                            native_peer(conv),
                        ),
                    )
                    affected.add(cid)
                native = item["provenance"]
                result = db.execute(
                    """INSERT OR IGNORE INTO messages
                    (id,session_id,observed,stamp,sender,payload,native_table,native_id)
                    VALUES(?,?,?,?,?,?,?,?)""",
                    (
                        payload["platformMessageId"],
                        cid,
                        observed,
                        payload["timestamp"],
                        payload["sender"],
                        json.dumps(payload, ensure_ascii=False),
                        native["table"],
                        int(native["local_id"]),
                    ),
                )
                changed += result.rowcount
            for cid in affected:
                stats = db.execute(
                    "SELECT COUNT(*),MAX(stamp),COUNT(DISTINCT sender) FROM messages WHERE session_id=?",
                    (cid,),
                ).fetchone()
                db.execute(
                    "UPDATE sessions SET message_count=?,last_stamp=?,member_count=? WHERE id=?",
                    (*stats, cid),
                )
            for key, value in {
                "origin": origin,
                "clock": str(clock),
                "lastRefresh": str(int(time.time())),
                "lastError": "",
                "bootstrapped": "1",
            }.items():
                db.execute("INSERT OR REPLACE INTO state VALUES(?,?)", (key, value))
        return {"changedMessages": changed, **self.status()}

    def status(self):
        with self.connect() as db:
            state = dict(db.execute("SELECT key,value FROM state"))
            counts = db.execute(
                "SELECT COUNT(*),COALESCE(SUM(message_count),0) FROM sessions"
            ).fetchone()
            return {
                "ready": state.get("bootstrapped") == "1",
                "conversations": counts[0],
                "messages": counts[1],
                "lastRefresh": int(state.get("lastRefresh", 0)),
                "error": state.get("lastError", ""),
            }

    def fail(self, error):
        with self.connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO state VALUES('lastError',?)",
                (type(error).__name__,),
            )

    def sessions(self):
        with self.connect() as db:
            return [
                dict(r)
                for r in db.execute("""SELECT id,name,'qq' AS platform,kind AS type,
                message_count AS messageCount,last_stamp AS lastMessageAt,member_count AS memberCount
                FROM sessions WHERE message_count>0 ORDER BY last_stamp DESC,id""")
            ]

    def messages(self, session_id, since=0, offset=0, limit=5000):
        with self.connect() as db:
            db.execute("BEGIN")
            conv = db.execute(
                "SELECT * FROM sessions WHERE id=?", (session_id,)
            ).fetchone()
            if not conv:
                raise KeyError("Unknown conversation")
            # Observations and sequence numbers only increase. Keyset pagination also
            # preserves same-second insertions and avoids quadratic OFFSET scans.
            lower = db.execute(
                """SELECT seq FROM messages WHERE session_id=? AND observed>=?
                ORDER BY observed,seq LIMIT 1""",
                (session_id, since),
            ).fetchone()
            start = max(offset, lower[0] - 1) if lower else None
            rows = (
                []
                if start is None
                else db.execute(
                    """SELECT seq,observed,payload FROM messages
                WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?""",
                    (session_id, start, limit + 1),
                ).fetchall()
            )
            selected, more = rows[:limit], len(rows) > limit
            messages = [json.loads(r["payload"]) for r in selected]
            sync = {"hasMore": more}
            if more:
                sync["nextOffset"] = selected[-1]["seq"]
            else:
                clock = db.execute(
                    "SELECT value FROM state WHERE key='clock'"
                ).fetchone()
                # Never outrun committed observations while a refresh is in flight.
                sync["nextSince"] = max(since, int(clock[0]) if clock else 0)
            return {
                "chatlab": {
                    "version": "0.0.2",
                    "exportedAt": int(time.time()),
                    "generator": "qq-local-chatlab",
                },
                "meta": {
                    "name": conv["name"],
                    "platform": "qq",
                    "type": conv["kind"],
                    "groupId": session_id,
                },
                "members": list(
                    {
                        m["sender"]: {
                            "platformId": m["sender"],
                            "accountName": m["accountName"],
                        }
                        for m in messages
                    }.values()
                ),
                "messages": messages,
                "sync": sync,
            }


def extract_new_rows(data, cache):
    """Build a small detached QQ database containing all unseen native IDs."""
    original = data / "nt_msg.db"
    delta = data / "delta.db"
    with sqlite3.connect(delta, uri=True) as db:
        db.execute("ATTACH DATABASE ? AS raw", (original.as_uri() + "?mode=ro",))
        db.execute("ATTACH DATABASE ? AS known", (cache.path.as_uri() + "?mode=ro",))
        for table in ("c2c_msg_table", "group_msg_table"):
            db.execute(
                f'''CREATE TABLE "{table}" AS SELECT r.* FROM raw."{table}" r
                WHERE NOT EXISTS(SELECT 1 FROM known.messages m
                    WHERE m.native_table=? AND m.native_id=r."40001")''',
                (table,),
            )
    os.replace(delta, original)


def backfill_image_metadata(data, cache):
    """Enrich existing bridge messages while the regular decrypted snapshot is available."""
    from qq_local_interface.protobuf import decode_body

    with cache.connect() as db:
        db.execute(
            "ATTACH DATABASE ? AS native", ((data / "nt_msg.db").as_uri() + "?mode=ro",)
        )
        for table in ("c2c_msg_table", "group_msg_table"):
            columns = {
                row[1] for row in db.execute(f'PRAGMA native.table_info("{table}")')
            }
            if "40001" not in columns:
                continue
            body = "40800" if "40800" in columns else "40080"
            # Scan native rows once; 40001 is not guaranteed to be indexed in QQ.
            # CROSS JOIN fixes the outer loop to the native scan and uses our
            # existing (native_table,native_id) index for each lookup.
            pending = db.execute(
                f'''SELECT m.id,r."{body}" AS body
                FROM native."{table}" r CROSS JOIN messages m
                ON m.native_table=? AND m.native_id=r."40001"
                WHERE json_extract(m.payload,'$.type') IN (1,5,99)
                AND NOT EXISTS(SELECT 1 FROM image_metadata i WHERE i.id=m.id)''',
                (table,),
            )
            for message in pending:
                decoded = decode_body(message["body"])
                db.execute(
                    "INSERT OR IGNORE INTO image_metadata VALUES(?,?)",
                    (
                        message["id"],
                        json.dumps(
                            {
                                "text": decoded.get("text"),
                                "attachments": decoded["attachments"],
                            },
                            ensure_ascii=False,
                        ),
                    ),
                )


def backfill_message_content(data, cache):
    """Normalize stored display text and resolve QQ quote sequences in one scan.

    The source cache keeps stable message IDs and pull cursors. This also runs
    after each delta ingest so newly collected replies use existing target IDs.
    """
    from qq_local_interface.protobuf import decode_body

    changed = set()
    with cache.connect() as db:
        last = db.execute("SELECT COALESCE(MAX(seq),0) FROM messages").fetchone()[0]
        row = db.execute(
            "SELECT value FROM state WHERE key='messageContentV1ThroughSeq'"
        ).fetchone()
        through = int(row[0]) if row else 0
        if through >= last:
            return 0
        db.execute(
            "ATTACH DATABASE ? AS native", ((data / "nt_msg.db").as_uri() + "?mode=ro",)
        )
        db.execute("""CREATE TEMP TABLE quote_requests(message_id TEXT PRIMARY KEY,session_id TEXT,
            native_table TEXT,peer TEXT,sequence INTEGER,stamp INTEGER,sender_uid TEXT)""")
        db.execute(
            "CREATE INDEX quote_target ON quote_requests(native_table,peer,sequence)"
        )
        for table in ("c2c_msg_table", "group_msg_table"):
            columns = {
                row[1] for row in db.execute(f'PRAGMA native.table_info("{table}")')
            }
            if "40001" not in columns:
                continue
            body = "40800" if "40800" in columns else "40080"
            peer = "40030" if table == "group_msg_table" else "40021"
            can_quote = {peer, "40003", "40050", "40020"} <= columns
            peer_expression = f'r."{peer}"' if can_quote else "NULL"
            pending = db.execute(
                f'''SELECT m.id,m.session_id,m.payload,r."{body}" AS body,
                    {peer_expression} AS peer
                FROM native."{table}" r CROSS JOIN messages m
                ON m.native_table=? AND m.native_id=r."40001"
                WHERE m.seq>? AND m.seq<=? AND (
                    json_extract(m.payload,'$.type') IN (25,99)
                    OR instr(json_extract(m.payload,'$.content'),char(10)||'u_')>0)''',
                (table, through, last),
            )
            for message in pending:
                decoded = decode_body(message["body"])
                if decoded["quality"]["status"] in ("decode_error", "unsupported"):
                    continue
                payload = json.loads(message["payload"])
                normalized = {
                    **payload,
                    "content": message_content(decoded),
                    "type": message_type(decoded),
                }
                if normalized != payload:
                    db.execute(
                        "UPDATE messages SET payload=? WHERE id=?",
                        (json.dumps(normalized, ensure_ascii=False), message["id"]),
                    )
                    changed.add(message["id"])
                if not can_quote or message["peer"] is None:
                    continue
                quotes = [
                    element
                    for element in decoded["elements"]
                    if element["kind"] == "quote"
                ]
                if len(quotes) != 1:
                    continue
                fields = {
                    field["number"]: field for field in quotes[0]["native_fields"]
                }
                sequence = fields.get(47402, {}).get("value")
                if sequence is None:
                    continue
                stamp = fields.get(47404, {}).get("value")
                db.execute(
                    "INSERT INTO quote_requests VALUES(?,?,?,?,?,?,?)",
                    (
                        message["id"],
                        message["session_id"],
                        table,
                        str(message["peer"]),
                        int(sequence),
                        int(stamp) if stamp is not None else None,
                        fields.get(40020, {}).get("text"),
                    ),
                )
            if not can_quote:
                continue
            # QQ's native ID is not its quote sequence. Resolve the sequence
            # with the peer, timestamp and author, then reuse our stable ID.
            references = db.execute(
                f'''SELECT q.message_id,MIN(target.id) AS target_id
                FROM native."{table}" r CROSS JOIN quote_requests q
                ON q.native_table=? AND q.peer=CAST(r."{peer}" AS TEXT) AND q.sequence=r."40003"
                CROSS JOIN messages target ON target.native_table=? AND target.native_id=r."40001"
                    AND target.session_id=q.session_id
                WHERE (q.stamp IS NULL OR q.stamp=r."40050")
                    AND (q.sender_uid IS NULL OR q.sender_uid=r."40020")
                GROUP BY q.message_id HAVING COUNT(DISTINCT target.id)=1''',
                (table, table),
            )
            for reference in references:
                row = db.execute(
                    "SELECT payload FROM messages WHERE id=?",
                    (reference["message_id"],),
                ).fetchone()
                payload = json.loads(row[0])
                if payload.get("replyToMessageId") == reference["target_id"]:
                    continue
                payload["replyToMessageId"] = reference["target_id"]
                db.execute(
                    "UPDATE messages SET payload=? WHERE id=?",
                    (json.dumps(payload, ensure_ascii=False), reference["message_id"]),
                )
                changed.add(reference["message_id"])
        db.execute(
            "INSERT OR REPLACE INTO state VALUES('messageContentV1ThroughSeq',?)",
            (str(last),),
        )
    return len(changed)


class QQSource:
    def __init__(self, config, cache):
        from qq_local_interface.vault import QQVault

        self.vault = QQVault(root=config["vaultRoot"], source_id=config["sourceId"])
        self.cache = cache
        self.signature = None

    def bootstrap(self):
        if not self.cache.status()["ready"]:
            snapshot, manifest = self.vault.current()
            return self.cache.ingest(
                snapshot / "records.db", manifest["origin"], bootstrap=True
            )

    def refresh(self):
        from qq_local_interface.index import build_index
        from snapshot_cache import SnapshotStore

        config = self.vault.config()
        source = Path(config["database_dir"])
        paths = [
            source / (name + suffix)
            for name in CORE_DATABASES
            for suffix in ("", "-wal", "-journal")
        ]
        signature = [
            self.vault._signature(p) for p in paths + [Path(config["key_file"])]
        ]
        if signature == self.signature:
            return {"unchanged": True, **self.cache.status()}
        with (
            self.vault._writer(),
            tempfile.TemporaryDirectory(
                prefix=".refresh-", dir=self.cache.root
            ) as temp,
        ):
            temp = Path(temp)
            store = SnapshotStore(self.cache.root / "snapshots")
            with store.stage(self.vault, config, CORE_DATABASES) as snapshot:
                backfill_image_metadata(snapshot.data, self.cache)
                # extract_new_rows replaces nt_msg.db; its files must be detached
                # from the persistent full snapshot used by the next refresh.
                data = temp / "data"
                snapshot.export(data)
                extract_new_rows(data, self.cache)
                build_index(
                    data,
                    temp / "records.db",
                    self.vault.source_id,
                    config["account"],
                    "chatlab-delta",
                )
                result = self.cache.ingest(temp / "records.db", config["origin"])
                result["normalizedMessages"] = backfill_message_content(
                    snapshot.data, self.cache
                )
                snapshot.commit()
                result["snapshot"] = snapshot.metrics
        self.signature = signature
        return result


def image_error(error):
    """Project a duck-typed controlled image error without importing that module.

    The deployed service can run through a signed runpy launcher whose import
    path is not prepared at module load, so this layer never imports
    image_media itself.
    """
    status = getattr(error, "status", None)
    code = getattr(error, "code", None)
    if not isinstance(status, int) or not isinstance(code, str):
        return None
    return status, {
        "error": str(error),
        "code": code,
        "retryable": bool(getattr(error, "retryable", False)),
    }


def make_server(cache, config, images=None):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            path = urlsplit(self.path)
            if path.path == "/health":
                return self.reply(200, cache.status())
            if not hmac.compare_digest(
                self.headers.get("Authorization", ""), "Bearer " + config["token"]
            ):
                return self.reply(401, {"error": "Unauthorized"})
            if not cache.status()["ready"]:
                return self.reply(
                    503, {"error": "QQ snapshot unavailable; inspect /health"}
                )
            try:
                query = parse_qs(path.query)
                limit = max(1, min(5000, int(query.get("limit", ["5000"])[0])))
                if path.path == "/api/v1/sessions":
                    sessions = cache.sessions()
                    keyword = query.get("keyword", [""])[0].casefold()
                    sessions = [s for s in sessions if keyword in s["name"].casefold()]
                    offset = int(query.get("cursor", ["0"])[0])
                    if offset < 0:
                        raise ValueError("Negative cursor")
                    return self.reply(
                        200,
                        {
                            "sessions": sessions[offset : offset + limit],
                            "page": {
                                "hasMore": offset + limit < len(sessions),
                                "nextCursor": str(offset + limit),
                            },
                        },
                    )
                parts = path.path.strip("/").split("/")
                if (
                    len(parts) in (7, 8)
                    and parts[:3] == ["api", "v1", "sessions"]
                    and parts[4] == "messages"
                    and parts[6] == "images"
                ):
                    if images is None:
                        return self.reply(
                            503,
                            {
                                "error": "Image support is not enabled",
                                "code": "QQ_BRIDGE_UNAVAILABLE",
                                "retryable": True,
                            },
                        )
                    sid, mid = unquote(parts[3]), unquote(parts[5])
                    try:
                        index = int(parts[7]) if len(parts) == 8 else None
                    except ValueError:
                        return self.reply(
                            400,
                            {
                                "error": "Invalid image request",
                                "code": "INVALID_IMAGE_REQUEST",
                                "retryable": False,
                            },
                        )
                    size = query.get("size", ["preview"])[0]
                    if size not in ("preview", "original"):
                        return self.reply(
                            400,
                            {
                                "error": "Invalid image request",
                                "code": "INVALID_IMAGE_REQUEST",
                                "retryable": False,
                            },
                        )
                    try:
                        return self.reply(200, images.resolve(sid, mid, index, size))
                    except (KeyError, FileNotFoundError):
                        return self.reply(
                            404,
                            {
                                "error": "Image not available",
                                "code": "IMAGE_NOT_FOUND",
                                "retryable": False,
                            },
                        )
                    except Exception as error:
                        failure = image_error(error)
                        if failure is None:
                            raise
                        status, payload = failure
                        return self.reply(
                            status,
                            payload,
                            {"Retry-After": "2"} if status == 429 else None,
                        )
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "sessions"]
                    and parts[4] == "messages"
                ):
                    since, offset = (
                        int(query.get("since", ["0"])[0]),
                        int(query.get("offset", ["0"])[0]),
                    )
                    if since < 0 or offset < 0:
                        raise ValueError("Negative cursor")
                    return self.reply(
                        200, cache.messages(unquote(parts[3]), since, offset, limit)
                    )
                return self.reply(404, {"error": "Not found"})
            except (KeyError, FileNotFoundError):
                return self.reply(404, {"error": "Image or conversation unavailable"})
            except ValueError:
                return self.reply(400, {"error": "Invalid request"})
            except Exception:  # noqa: BLE001 -- Keep upstream details out of HTTP responses.
                return self.reply(503, {"error": "Image source unavailable"})

        def reply(self, status, value, headers=None):
            body = (
                value
                if isinstance(value, bytes)
                else json.dumps(value, ensure_ascii=False).encode()
            )
            self.send_response(status)
            self.send_header(
                "Content-Type",
                "application/octet-stream"
                if isinstance(value, bytes)
                else "application/json; charset=utf-8",
            )
            self.send_header("Cache-Control", "no-store")
            for name, header in (headers or {}).items():
                self.send_header(name, header)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    return ThreadingHTTPServer(("127.0.0.1", config["port"]), Handler)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command", choices=["init", "bootstrap", "refresh", "serve", "status"]
    )
    parser.add_argument("--home", type=Path, default=DEFAULT_HOME)
    parser.add_argument(
        "--vault-root",
        type=Path,
        default=Path.home() / "Library/Application Support/qq-local-interface",
    )
    parser.add_argument("--source-id", default="personal-qq")
    parser.add_argument("--port", type=int, default=5035)
    parser.add_argument("--interval", type=int, default=300)
    args = parser.parse_args()
    config_path = args.home / "config.json"
    if args.command == "init":
        from qq_local_interface.util import atomic_json

        if config_path.exists():
            raise SystemExit(
                "Bridge already configured; existing source and token preserved"
            )
        atomic_json(
            config_path,
            {
                "vaultRoot": str(args.vault_root.resolve()),
                "sourceId": args.source_id,
                "port": args.port,
                "interval": args.interval,
                "token": secrets.token_urlsafe(32),
            },
        )
        print(json.dumps({"configured": True, "port": args.port}))
        return
    config = json.loads(config_path.read_text())
    cache = Cache(args.home)
    if args.command == "status":
        print(json.dumps(cache.status()))
        return
    source = QQSource(config, cache)
    result = source.bootstrap()
    if result:
        print(json.dumps(result), flush=True)
    if args.command == "bootstrap":
        return

    def refresh():
        from snapshot_cache import process_write_bytes

        started = time.monotonic()
        before_writes = process_write_bytes()
        try:
            result = source.refresh()
            if not result.get("unchanged"):
                after_writes = process_write_bytes()
                if before_writes is not None and after_writes is not None:
                    result["processWriteMiB"] = round(
                        (after_writes - before_writes) / 2**20, 3
                    )
                print(
                    json.dumps(
                        {
                            **result,
                            "durationSeconds": round(time.monotonic() - started, 2),
                        }
                    ),
                    flush=True,
                )
        except Exception as error:  # noqa: BLE001 -- Retain checkpoints and record a safe failure category.
            cache.fail(error)
            print(
                json.dumps({"refreshFailed": True, "error": type(error).__name__}),
                flush=True,
            )
            if args.command == "refresh":
                raise SystemExit(1) from None

    if args.command == "refresh":
        refresh()
        return
    stop = threading.Event()

    def loop():
        refresh()
        while not stop.wait(max(30, config["interval"])):
            refresh()

    # This service also runs through a signed runpy launcher, which does not
    # automatically put the integration directory on Python's module path.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from image_media import QQImages

    server = make_server(cache, config, QQImages(source))
    threading.Thread(target=loop, daemon=True).start()
    try:
        server.serve_forever()
    finally:
        stop.set()
        server.server_close()


if __name__ == "__main__":
    main()
