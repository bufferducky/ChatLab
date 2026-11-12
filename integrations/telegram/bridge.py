#!/usr/bin/env python3
"""Collect selected Telegram histories and expose a local ChatLab Pull source."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import fcntl
import getpass
import hmac
import json
import os
import signal
import sqlite3
import tempfile
import threading
import time
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

DEFAULT_HOME = Path.home() / ".local/share/chatlab-telegram"
BATCH_SIZE = 500


def private_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextlib.contextmanager
def collector_lock(root):
    """Only one process may advance Telegram collection or use its session."""
    with (Path(root) / "collector.lock").open("a") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("CollectorBusy") from None
        yield


def make_client(root, config):
    from telethon import TelegramClient

    return TelegramClient(
        str(Path(root) / "telegram"),
        config["apiId"],
        config["apiHash"],
        proxy=config.get("proxy"),
        timeout=15,
        connection_retries=2,
        request_retries=2,
        flood_sleep_threshold=0,
        receive_updates=False,
    )


def convert_message(message, sender_name=None):
    """Keep native message/reply IDs within one peer; do not download media."""
    from telethon import types, utils

    sender_id = getattr(message, "sender_id", None)
    if sender_id is None and getattr(message, "from_id", None):
        sender_id = utils.get_peer_id(message.from_id)
    if sender_id is None and getattr(message, "post", False):
        sender_id = utils.get_peer_id(message.peer_id)
    sender = str(sender_id) if sender_id is not None else "telegram:unknown"
    content = getattr(message, "message", None) or ""
    kind = 0
    label = None
    if getattr(message, "action", None):
        kind, label = 80, type(message.action).__name__
    elif getattr(message, "sticker", None):
        kind, label = 5, "sticker"
    elif isinstance(getattr(message, "media", None), types.MessageMediaPhoto):
        kind, label = 1, "photo"
    elif getattr(message, "voice", None):
        kind, label = 2, "voice"
    elif getattr(message, "video", None) or getattr(message, "video_note", None):
        kind, label = 3, "video"
    elif getattr(message, "gif", None):
        kind, label = 1, "animation"
    elif isinstance(getattr(message, "media", None), types.MessageMediaDocument):
        kind, label = 4, "file"
    elif getattr(message, "media", None):
        media_type = type(message.media).__name__
        if media_type != "MessageMediaWebPage":
            kind, label = 99, media_type
    if label:
        content = f"[{label}] {content}".rstrip()
    result = {
        "platformMessageId": str(message.id),
        "sender": sender,
        "accountName": sender_name or sender,
        "timestamp": max(1, int(message.date.timestamp())),
        "type": kind,
        "content": content or None,
    }
    reply = getattr(message, "reply_to", None)
    # A reply into another peer cannot be resolved in this ChatLab session.
    if reply and reply.reply_to_msg_id and not getattr(reply, "reply_to_peer_id", None):
        result["replyToMessageId"] = str(reply.reply_to_msg_id)
    return result


class Cache:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)
        self.path = self.root / "messages.sqlite3"
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT);
                CREATE TABLE IF NOT EXISTS sessions(
                    id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,
                    last_id INTEGER NOT NULL DEFAULT 0,history_complete INTEGER NOT NULL DEFAULT 0,
                    history_since INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS messages(
                    seq INTEGER PRIMARY KEY,session_id TEXT NOT NULL,native_id INTEGER NOT NULL,
                    observed INTEGER NOT NULL,stamp INTEGER NOT NULL,sender TEXT NOT NULL,
                    payload TEXT NOT NULL,UNIQUE(session_id,native_id));
                CREATE INDEX IF NOT EXISTS session_seq ON messages(session_id,seq);
                CREATE INDEX IF NOT EXISTS session_observed ON messages(session_id,observed,seq);
            """)
            if "history_since" not in {
                row[1] for row in db.execute("PRAGMA table_info(sessions)")
            }:
                db.execute(
                    "ALTER TABLE sessions ADD COLUMN history_since INTEGER NOT NULL DEFAULT 0"
                )
        self.path.chmod(0o600)

    @contextlib.contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def bind_account(self, account):
        with self.connect() as db:
            row = db.execute("SELECT value FROM state WHERE key='account'").fetchone()
            if row and row[0] != str(account):
                raise ValueError("AccountChanged")
            db.execute(
                "INSERT OR REPLACE INTO state VALUES('account',?)", (str(account),)
            )

    def session(self, account, peer, name, kind, history_since=0):
        sid = f"telegram:{account}:{peer}"
        with self.connect() as db:
            db.execute(
                """INSERT INTO sessions(id,name,kind,history_since) VALUES(?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,
                    history_since=CASE WHEN sessions.history_since=0
                        THEN excluded.history_since ELSE sessions.history_since END""",
                (sid, name, kind, history_since),
            )
        return sid

    def history_since(self, sid):
        with self.connect() as db:
            return db.execute(
                "SELECT history_since FROM sessions WHERE id=?", (sid,)
            ).fetchone()[0]

    def cursor(self, sid):
        with self.connect() as db:
            row = db.execute(
                "SELECT last_id FROM sessions WHERE id=?", (sid,)
            ).fetchone()
            if row is None:
                raise KeyError(sid)
            return row[0]

    def ingest(self, sid, payloads, *, now=None):
        """Commit rows and the Telegram ID checkpoint in the same transaction."""
        with self.connect() as db:
            if not db.execute("SELECT 1 FROM sessions WHERE id=?", (sid,)).fetchone():
                raise KeyError(sid)
            clock = db.execute("SELECT value FROM state WHERE key='clock'").fetchone()
            observed = max(
                int(time.time() if now is None else now),
                int(clock[0]) + 1 if clock else 1,
            )
            changed = 0
            for payload in payloads:
                native_id = int(payload["platformMessageId"])
                if native_id <= 0 or payload["timestamp"] <= 0:
                    raise ValueError("InvalidMessage")
                changed += db.execute(
                    """INSERT OR IGNORE INTO messages
                    (session_id,native_id,observed,stamp,sender,payload) VALUES(?,?,?,?,?,?)""",
                    (
                        sid,
                        native_id,
                        observed,
                        payload["timestamp"],
                        payload["sender"],
                        json.dumps(payload, ensure_ascii=False),
                    ),
                ).rowcount
                db.execute(
                    "UPDATE sessions SET last_id=MAX(last_id,?) WHERE id=?",
                    (native_id, sid),
                )
            db.execute(
                "INSERT OR REPLACE INTO state VALUES('clock',?)", (str(observed),)
            )
        return changed

    def finish_session(self, sid):
        with self.connect() as db:
            db.execute("UPDATE sessions SET history_complete=1 WHERE id=?", (sid,))

    def finish(self):
        with self.connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO state VALUES('lastRefresh',?)",
                (str(int(time.time())),),
            )
            db.execute("INSERT OR REPLACE INTO state VALUES('lastError','')")
            db.execute("INSERT OR REPLACE INTO state VALUES('retryAfter', '0')")

    def record_attempt(self):
        with self.connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO state VALUES('lastAttempt',?)",
                (str(int(time.time())),),
            )

    def fail(self, error):
        with self.connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO state VALUES('lastAttempt',?)",
                (str(int(time.time())),),
            )
            db.execute(
                "INSERT OR REPLACE INTO state VALUES('lastError',?)",
                (type(error).__name__,),
            )
            seconds = int(getattr(error, "seconds", 0))
            if seconds > 0:
                db.execute(
                    "INSERT OR REPLACE INTO state VALUES('retryAfter',?)",
                    (str(int(time.time()) + seconds),),
                )

    def status(self):
        with self.connect() as db:
            state = dict(db.execute("SELECT key,value FROM state"))
            count = db.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
            return {
                "ready": bool(count or state.get("lastRefresh")),
                "conversations": db.execute("SELECT COUNT(*) FROM sessions").fetchone()[
                    0
                ],
                "messages": count,
                "historyComplete": db.execute(
                    "SELECT COUNT(*) FROM sessions WHERE history_complete=1"
                ).fetchone()[0],
                "lastRefresh": int(state.get("lastRefresh", 0)),
                "lastAttempt": int(state.get("lastAttempt", 0)),
                "error": state.get("lastError", ""),
                "retryAfter": int(state.get("retryAfter", 0)),
            }

    def sessions(self):
        with self.connect() as db:
            return [
                dict(row)
                for row in db.execute("""SELECT s.id,s.name,'telegram' AS platform,s.kind AS type,
                COUNT(m.seq) AS messageCount,MAX(m.stamp) AS lastMessageAt,
                COUNT(DISTINCT m.sender) AS memberCount
                FROM sessions s JOIN messages m ON m.session_id=s.id
                GROUP BY s.id ORDER BY lastMessageAt DESC,s.id""")
            ]

    def messages(self, sid, since=0, offset=0, limit=1000):
        with self.connect() as db:
            db.execute("BEGIN")
            session = db.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
            if session is None:
                raise KeyError(sid)
            # Keyset paging retains same-second messages and late historical rows.
            rows = db.execute(
                """SELECT seq,observed,payload FROM messages
                WHERE session_id=? AND observed>=? AND seq>? ORDER BY seq LIMIT ?""",
                (sid, since, offset, limit + 1),
            ).fetchall()
            selected, more = rows[:limit], len(rows) > limit
            messages = [json.loads(row["payload"]) for row in selected]
            sync = {"hasMore": more}
            if more:
                sync["nextOffset"] = selected[-1]["seq"]
            else:
                clock = db.execute(
                    "SELECT value FROM state WHERE key='clock'"
                ).fetchone()
                sync["nextSince"] = max(since, int(clock[0]) if clock else 0)
            return {
                "chatlab": {
                    "version": "0.0.2",
                    "exportedAt": int(time.time()),
                    "generator": "telegram-chatlab",
                },
                "meta": {
                    "name": session["name"],
                    "platform": "telegram",
                    "type": session["kind"],
                    "groupId": sid,
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


async def login(root, config):
    from telethon.errors import SessionPasswordNeededError

    client = make_client(root, config)
    try:
        await client.connect()
        if not await client.is_user_authorized():
            phone = input("Telegram 手机号（含国家区号，例如 +86）：").strip()
            await client.send_code_request(phone)
            try:
                await client.sign_in(
                    phone=phone,
                    code=getpass.getpass("请输入 Telegram 登录验证码（输入隐藏）："),
                )
            except SessionPasswordNeededError:
                await client.sign_in(
                    password=getpass.getpass(
                        "请输入 Telegram 两步验证密码（输入隐藏）："
                    )
                )
        account = await client.get_me()
        Cache(root).bind_account(account.id)
        private_json(
            Path(root) / "login-status.json",
            {"authorized": True, "updatedAt": int(time.time())},
        )
        print(
            "登录完成，授权已保存在本机。可以回到 Codex，继续选择要采集的会话。",
            flush=True,
        )
    finally:
        await client.disconnect()


async def discover(root, config):
    client = make_client(root, config)
    try:
        await client.connect()
        if not await client.is_user_authorized():
            raise RuntimeError("LoginRequired")
        account = await client.get_me()
        Cache(root).bind_account(account.id)
        dialogs = []
        async for dialog in client.iter_dialogs():
            dialogs.append(
                {
                    "id": str(dialog.id),
                    "name": dialog.name or str(dialog.id),
                    "type": "private" if dialog.is_user else "group",
                }
            )
        private_json(Path(root) / "dialogs.json", dialogs)
        print(json.dumps({"discoveredConversations": len(dialogs)}, ensure_ascii=False))
        return dialogs
    finally:
        await client.disconnect()


async def refresh(root, config, cache):
    from telethon import utils

    selected = config.get("selectedPeers", [])
    if not selected and not config.get("allDialogs"):
        raise RuntimeError("NoConversationsSelected")
    if cache.status()["retryAfter"] > time.time():
        return {"deferred": True, **cache.status()}
    cache.record_attempt()
    client = make_client(root, config)
    changed = 0
    history_since = config.get("historySince", int(time.time()) - 7 * 86400)
    try:
        await client.connect()
        if not await client.is_user_authorized():
            raise RuntimeError("LoginRequired")
        account = await client.get_me()
        cache.bind_account(account.id)
        # Refresh entities once, so IDs and names are resolved without per-message RPCs.
        dialogs = {str(d.id): d async for d in client.iter_dialogs()}
        if config.get("allDialogs"):
            selected = list(dialogs)
            history_since = int(time.time()) - 7 * 86400
        for peer in selected:
            dialog = dialogs.get(str(peer))
            if dialog is None:
                raise RuntimeError("SelectedConversationUnavailable")
            sid = cache.session(
                account.id,
                peer,
                dialog.name or str(peer),
                "private" if dialog.is_user else "group",
                history_since,
            )
            session_since = cache.history_since(sid)
            cursor = cache.cursor(sid)
            batch = []
            async for message in client.iter_messages(
                dialog.entity,
                min_id=cursor,
                reverse=True,
                limit=None,
                wait_time=config.get("requestWaitSeconds", 3),
                offset_date=datetime.fromtimestamp(session_since - 1, UTC)
                if cursor == 0
                else None,
            ):
                # MessageEmpty does not have a date or content to archive.
                if not getattr(message, "date", None):
                    continue
                if message.date.timestamp() < session_since:
                    continue
                sender = getattr(message, "sender", None)
                batch.append(
                    convert_message(
                        message, utils.get_display_name(sender) if sender else None
                    )
                )
                if len(batch) >= BATCH_SIZE:
                    changed += cache.ingest(sid, batch)
                    batch.clear()
                    if changed % 10000 == 0:
                        print(json.dumps({"collectedMessages": changed}), flush=True)
            if batch:
                changed += cache.ingest(sid, batch)
            cache.finish_session(sid)
        cache.finish()
        return {"changedMessages": changed, **cache.status()}
    finally:
        await client.disconnect()


def make_server(cache, config):
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
                    503, {"error": "Initial collection pending; inspect /health"}
                )
            try:
                query = parse_qs(path.query)
                limit = max(1, min(5000, int(query.get("limit", ["1000"])[0])))
                if path.path == "/api/v1/sessions":
                    sessions = cache.sessions()
                    keyword = query.get("keyword", [""])[0].casefold()
                    sessions = [s for s in sessions if keyword in s["name"].casefold()]
                    cursor = int(query.get("cursor", ["0"])[0])
                    if cursor < 0:
                        raise ValueError("Negative cursor")
                    return self.reply(
                        200,
                        {
                            "sessions": sessions[cursor : cursor + limit],
                            "page": {
                                "hasMore": cursor + limit < len(sessions),
                                "nextCursor": str(cursor + limit),
                            },
                        },
                    )
                parts = path.path.strip("/").split("/")
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "sessions"]
                    and parts[4] == "messages"
                ):
                    since, offset = (
                        int(query.get("since", ["0"])[0]),
                        int(query.get("offset", ["0"])[0]),
                    )
                    if min(since, offset) < 0:
                        raise ValueError("Negative cursor")
                    return self.reply(
                        200, cache.messages(unquote(parts[3]), since, offset, limit)
                    )
                return self.reply(404, {"error": "Not found"})
            except KeyError:
                return self.reply(404, {"error": "Unknown conversation"})
            except ValueError:
                return self.reply(400, {"error": "Invalid request"})

        def reply(self, status, value):
            body = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
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
        "command", choices=["login", "discover", "select", "refresh", "serve", "status"]
    )
    parser.add_argument("--home", type=Path, default=DEFAULT_HOME)
    parser.add_argument("--peer", action="append", default=[])
    args = parser.parse_args()
    root = args.home.resolve()
    config_path = root / "config.json"
    config = json.loads(config_path.read_text())
    cache = Cache(root)
    if args.command == "status":
        print(json.dumps(cache.status()))
        return
    with collector_lock(root):
        if args.command == "login":
            asyncio.run(login(root, config))
            return
        if args.command == "discover":
            asyncio.run(discover(root, config))
            return
        if args.command == "select":
            known = {d["id"] for d in json.loads((root / "dialogs.json").read_text())}
            if not args.peer or not set(args.peer) <= known:
                raise ValueError("Select known peer IDs discovered after login")
            # Adding sessions is supported; removal requires a separate explicit decision.
            config["selectedPeers"] = sorted(
                set(config.get("selectedPeers", [])) | set(args.peer)
            )
            private_json(config_path, config)
            print(json.dumps({"selectedConversations": len(config["selectedPeers"])}))
            return

        def collect():
            started = time.monotonic()
            try:
                result = asyncio.run(refresh(root, config, cache))
                print(
                    json.dumps(
                        {
                            **result,
                            "durationSeconds": round(time.monotonic() - started, 2),
                        }
                    ),
                    flush=True,
                )
                return True
            except Exception as error:  # noqa: BLE001 -- Persist safe error categories and retain the cache.
                cache.fail(error)
                print(
                    json.dumps({"refreshFailed": True, "error": type(error).__name__}),
                    flush=True,
                )
                return False

        if args.command == "refresh":
            raise SystemExit(0 if collect() else 1)
        stop = threading.Event()
        server = make_server(cache, config)

        def loop():
            # A service restart must not cause another Telegram scan inside the interval.
            status = cache.status()
            last_attempt = max(status["lastRefresh"], status["lastAttempt"])
            delay = (
                max(0, config["interval"] - (time.time() - last_attempt))
                if last_attempt
                else 0
            )
            if delay and stop.wait(delay):
                return
            while not stop.is_set():
                collect()
                if stop.wait(max(30, config["interval"])):
                    break

        signal.signal(
            signal.SIGTERM,
            lambda *_: threading.Thread(target=server.shutdown, daemon=True).start(),
        )
        threading.Thread(target=loop, daemon=True).start()
        try:
            server.serve_forever()
        finally:
            stop.set()
            server.server_close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 -- Never expose upstream credentials in a traceback.
        # Upstream exceptions can contain phone numbers or request data.
        print(json.dumps({"success": False, "error": type(error).__name__}), flush=True)
        raise SystemExit(1) from None
