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
import math
import os
import signal
import sqlite3
import tempfile
import threading
import time
from contextvars import ContextVar
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

DEFAULT_HOME = Path.home() / ".local/share/chatlab-telegram"
BATCH_SIZE = 500
_collection_metrics = ContextVar("telegram_collection_metrics", default=None)


@contextlib.contextmanager
def measure_collection():
    """Attribute RPC waits to collection, excluding concurrent image tasks."""
    metrics = {
        "startedAt": int(time.time()),
        "scannedDialogs": 0,
        "skippedDialogs": 0,
        "rpcCalls": {},
        "pacingWaitSeconds": 0.0,
        "floodWaitEvents": 0,
        "floodWaitRequestedSeconds": 0,
    }
    token = _collection_metrics.set(metrics)
    started = time.monotonic()
    error_type = ""
    try:
        yield metrics
    except BaseException as error:
        error_type = type(error).__name__
        raise
    finally:
        _collection_metrics.reset(token)
        print(
            json.dumps(
                {
                    "event": "telegramCollection",
                    **{
                        key: round(value, 3) if isinstance(value, float) else value
                        for key, value in metrics.items()
                    },
                    "totalSeconds": round(time.monotonic() - started, 3),
                    "error": error_type,
                }
            ),
            flush=True,
        )


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
    from telethon import TelegramClient, errors

    cache = Cache(root)

    from media_scheduler import MediaRateLimited, MediaScheduler, media_job

    class PacedClient(TelegramClient):
        """Separate history pacing from account-wide media RPC admission."""

        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._request_gate = asyncio.Lock()
            self._connection_gate = asyncio.Lock()
            self._next_request_at = 0
            self.media_scheduler = MediaScheduler(cache)
            self._app_config_at = 0

        async def connect(self):
            async with self._connection_gate:
                if not self.is_connected():
                    await super().connect()

        async def ensure_media_connection(self):
            from telethon import functions, types

            async with self._connection_gate:
                if not self.is_connected():
                    await super().connect()
                if time.monotonic() < self._app_config_at:
                    return
                self.media_scheduler.check_cooldown()

                def decode(value):
                    if isinstance(value, types.JsonObject):
                        return {v.key: decode(v.value) for v in value.value}
                    return getattr(value, "value", None)

                try:
                    result = await self(functions.help.GetAppConfigRequest(hash=0))
                    values = decode(result.config)
                    self.media_scheduler.configure(
                        values.get("small_queue_max_active_operations_count"),
                        values.get("large_queue_max_active_operations_count"),
                    )
                    self._app_config_at = time.monotonic() + 3600
                except MediaRateLimited:
                    raise
                except (
                    OSError,
                    TimeoutError,
                    errors.RPCError,
                    AttributeError,
                    TypeError,
                ):
                    # One-at-a-time is the fallback until configuration is available.
                    self._app_config_at = time.monotonic() + 60

        async def _get_cdn_client(self, redirect):
            client = await super()._get_cdn_client(redirect)
            client.media_scheduler = self.media_scheduler
            client.flood_sleep_threshold = 0
            return client

        async def _call(self, *args, **kwargs):
            request = args[1] if len(args) > 1 else kwargs.get("request")
            requests = request if isinstance(request, (list, tuple)) else [request]
            media = media_job.get() is not None or any(
                type(r).__module__.endswith(".upload") for r in requests
            )
            metrics = _collection_metrics.get()
            while True:
                started = time.monotonic()
                if media:
                    self.media_scheduler.check_cooldown()
                else:
                    # No media request holds or waits for the history gate.
                    async with self._request_gate:
                        while (
                            remaining := max(
                                self._next_request_at - time.monotonic(),
                                cache.status()["retryAfter"] - time.time(),
                            )
                        ) > 0:
                            await asyncio.sleep(remaining)
                        self._next_request_at = time.monotonic() + max(
                            0, config.get("requestWaitSeconds", 3)
                        )
                if metrics is not None:
                    metrics["pacingWaitSeconds"] += time.monotonic() - started
                    kind = type(request).__name__
                    metrics["rpcCalls"][kind] = metrics["rpcCalls"].get(kind, 0) + 1
                try:
                    if media:
                        async with self.media_scheduler.rpc():
                            return await super()._call(*args, **kwargs)
                    return await super()._call(*args, **kwargs)
                except (errors.FloodWaitError, errors.FloodPremiumWaitError) as error:
                    seconds = max(1, error.seconds)
                    cache.record_rate_limit(seconds)
                    await self.media_scheduler.changed()
                    if metrics is not None:
                        metrics["floodWaitEvents"] += 1
                        metrics["floodWaitRequestedSeconds"] += seconds
                    print(
                        json.dumps(
                            {
                                "event": "telegramFloodWait",
                                "errorType": type(error).__name__,
                                "waitSeconds": seconds,
                                "requestType": type(error.request).__name__,
                                "dc": getattr(args[0], "dc_id", self.session.dc_id)
                                if args
                                else self.session.dc_id,
                            }
                        ),
                        flush=True,
                    )
                    if media:
                        raise MediaRateLimited(seconds) from None

    return PacedClient(
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
                CREATE TABLE IF NOT EXISTS image_metadata(
                    session_id TEXT NOT NULL,native_id INTEGER NOT NULL,
                    media BLOB NOT NULL,caption TEXT NOT NULL,
                    preview_done INTEGER NOT NULL DEFAULT 0,
                    next_retry REAL NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY(session_id,native_id));
            """)
            if "history_since" not in {
                row[1] for row in db.execute("PRAGMA table_info(sessions)")
            }:
                db.execute(
                    "ALTER TABLE sessions ADD COLUMN history_since INTEGER NOT NULL DEFAULT 0"
                )
            if "last_scanned_id" not in {
                row[1] for row in db.execute("PRAGMA table_info(sessions)")
            }:
                db.execute(
                    "ALTER TABLE sessions ADD COLUMN last_scanned_id INTEGER NOT NULL DEFAULT 0"
                )
            media_columns = {
                row[1] for row in db.execute("PRAGMA table_info(image_metadata)")
            }
            for column, declaration in (
                ("original_done", "INTEGER NOT NULL DEFAULT 0"),
                ("original_next_retry", "REAL NOT NULL DEFAULT 0"),
                ("original_error", "TEXT NOT NULL DEFAULT ''"),
            ):
                if column not in media_columns:
                    db.execute(
                        f"ALTER TABLE image_metadata ADD COLUMN {column} {declaration}"
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

    def is_current(self, sid, latest_id):
        """Only skip known heads after the initial history scan has finished."""
        if not isinstance(latest_id, int) or latest_id < 0:
            return False
        with self.connect() as db:
            row = db.execute(
                "SELECT last_id,last_scanned_id,history_complete FROM sessions WHERE id=?",
                (sid,),
            ).fetchone()
            return bool(
                row
                and row["history_complete"]
                and max(row["last_id"], row["last_scanned_id"]) >= latest_id
            )

    def scan_cursor(self, sid):
        with self.connect() as db:
            row = db.execute(
                "SELECT last_id,last_scanned_id,history_complete FROM sessions WHERE id=?",
                (sid,),
            ).fetchone()
            return (
                max(row["last_id"], row["last_scanned_id"])
                if row["history_complete"]
                else row["last_id"]
            )

    def ingest(self, sid, payloads, *, now=None, images=()):
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
            for mid, media, caption in images:
                db.execute(
                    """INSERT INTO image_metadata(session_id,native_id,media,caption)
                    VALUES(?,?,?,?) ON CONFLICT(session_id,native_id)
                    DO UPDATE SET media=excluded.media,caption=excluded.caption""",
                    (sid, int(mid), media, caption),
                )
        return changed

    def finish_session(self, sid, latest_id=0):
        with self.connect() as db:
            db.execute(
                """UPDATE sessions SET history_complete=1,
                last_scanned_id=MAX(last_scanned_id,?) WHERE id=?""",
                (latest_id or 0, sid),
            )

    def finish(self):
        with self.connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO state VALUES('lastRefresh',?)",
                (str(int(time.time())),),
            )
            db.execute("INSERT OR REPLACE INTO state VALUES('lastError','')")
            db.execute(
                "UPDATE state SET value='0' WHERE key='retryAfter' AND CAST(value AS REAL)<=?",
                (time.time(),),
            )

    def record_attempt(self):
        with self.connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO state VALUES('lastAttempt',?)",
                (str(int(time.time())),),
            )

    def record_rate_limit(self, seconds):
        with self.connect() as db:
            db.execute(
                """INSERT INTO state VALUES('retryAfter',?)
                ON CONFLICT(key) DO UPDATE SET value=MAX(
                    CAST(state.value AS INTEGER), CAST(excluded.value AS INTEGER))""",
                (str(math.ceil(time.time() + seconds)),),
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
                    """INSERT INTO state VALUES('retryAfter',?)
                    ON CONFLICT(key) DO UPDATE SET value=MAX(
                    CAST(state.value AS INTEGER), CAST(excluded.value AS INTEGER))""",
                    (str(math.ceil(time.time() + seconds)),),
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


async def refresh(root, config, cache, shared_client=None, image_service=None):
    from image_media import image_metadata
    from telethon import utils

    selected = config.get("selectedPeers", [])
    if not selected and not config.get("allDialogs"):
        raise RuntimeError("NoConversationsSelected")
    if cache.status()["retryAfter"] > time.time():
        return {"deferred": True, **cache.status()}
    with (
        measure_collection() as metrics,
        image_service.pause_prefetch() if image_service else contextlib.nullcontext(),
    ):
        cache.record_attempt()
        client = shared_client or make_client(root, config)
        changed = 0
        history_since = config.get("historySince", int(time.time()) - 7 * 86400)
        try:
            started = time.monotonic()
            await client.connect()
            account = await client.get_me()
            if account is None:
                raise RuntimeError("LoginRequired")
            cache.bind_account(account.id)
            metrics["connectionSeconds"] = time.monotonic() - started
            # Refresh entities once, so IDs and names are resolved without per-message RPCs.
            started = time.monotonic()
            dialogs = {str(d.id): d async for d in client.iter_dialogs()}
            metrics["dialogsSeconds"] = time.monotonic() - started
            metrics["discoveredDialogs"] = len(dialogs)
            if config.get("allDialogs"):
                selected = list(dialogs)
                history_since = int(time.time()) - 7 * 86400
            started = time.monotonic()
            metrics["cacheWriteSeconds"] = 0.0
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
                latest_id = getattr(getattr(dialog, "message", None), "id", None)
                if not isinstance(latest_id, int) or latest_id < 0:
                    latest_id = getattr(
                        getattr(dialog, "dialog", None), "top_message", None
                    )
                if not isinstance(latest_id, int) or latest_id < 0:
                    latest_id = None
                if cache.is_current(sid, latest_id):
                    metrics["skippedDialogs"] += 1
                    continue
                metrics["scannedDialogs"] += 1
                session_since = cache.history_since(sid)
                cursor = cache.scan_cursor(sid)
                batch = []
                media_batch = []
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
                    if latest_id and message.id > latest_id:
                        break
                    # MessageEmpty does not have a date or content to archive.
                    if not getattr(message, "date", None):
                        if latest_id and message.id == latest_id:
                            break
                        continue
                    if message.date.timestamp() < session_since:
                        if latest_id and message.id == latest_id:
                            break
                        continue
                    sender = getattr(message, "sender", None)
                    batch.append(
                        convert_message(
                            message, utils.get_display_name(sender) if sender else None
                        )
                    )
                    if metadata := image_metadata(message):
                        media_batch.append((str(message.id), *metadata))
                    if len(batch) >= BATCH_SIZE:
                        write_started = time.monotonic()
                        changed += cache.ingest(sid, batch, images=media_batch)
                        metrics["cacheWriteSeconds"] += time.monotonic() - write_started
                        batch.clear()
                        media_batch.clear()
                        if image_service:
                            image_service.wake_prefetch()
                        if changed % 10000 == 0:
                            print(
                                json.dumps({"collectedMessages": changed}), flush=True
                            )
                    if latest_id and message.id == latest_id:
                        break
                if batch:
                    write_started = time.monotonic()
                    changed += cache.ingest(sid, batch, images=media_batch)
                    metrics["cacheWriteSeconds"] += time.monotonic() - write_started
                    if image_service:
                        image_service.wake_prefetch()
                cache.finish_session(sid, latest_id)
            cache.finish()
            metrics["historySeconds"] = time.monotonic() - started
            return {"changedMessages": changed, **cache.status()}
        finally:
            if shared_client is None:
                await client.disconnect()


def make_server(cache, config, images=None):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_DELETE(self):
            from urllib.parse import unquote

            if not hmac.compare_digest(
                self.headers.get("Authorization", ""), "Bearer " + config["token"]
            ):
                return self.reply(401, {"error": "Unauthorized"})
            prefix = "/api/v1/image-requests/"
            path = urlsplit(self.path).path
            if images is None or not path.startswith(prefix):
                return self.reply(404, {"error": "Not found"})
            request_id = unquote(path[len(prefix) :])
            if not request_id or len(request_id) > 128:
                return self.reply(400, {"error": "Invalid request ID"})
            return self.reply(200, images.cancel_request(request_id))

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
                if path.path == "/api/v1/image-capabilities":
                    return self.reply(200, {"cancellation": 1})
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
                    len(parts) in (7, 8)
                    and parts[:3] == ["api", "v1", "sessions"]
                    and parts[4] == "messages"
                    and parts[6] == "images"
                ):
                    if images is None:
                        return self.reply(404, {"error": "Images unavailable"})
                    size = query.get("size", ["preview"])[0]
                    if size not in ("preview", "original"):
                        raise ValueError("Invalid image size")
                    if len(parts) == 8 and parts[7] != "0":
                        raise KeyError("Unknown image")
                    return self.reply(
                        200,
                        images.request(
                            unquote(parts[3]),
                            unquote(parts[5]),
                            size if len(parts) == 8 else None,
                            request_id=self.headers.get("X-Image-Request-Id"),
                        ),
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
            except Exception as error:  # noqa: BLE001 -- Keep upstream details private.
                from concurrent.futures import CancelledError

                from media_scheduler import MediaRateLimited, MediaTimeout

                if isinstance(error, MediaRateLimited):
                    return self.reply(
                        429,
                        {
                            "error": "Telegram media cooling down",
                            "code": "IMAGE_RATE_LIMITED",
                            "retryable": True,
                            "retryAfterSeconds": error.retry_after,
                        },
                    )
                if isinstance(error, (MediaTimeout, TimeoutError)):
                    return self.reply(
                        504,
                        {
                            "error": "Image request timed out",
                            "code": "IMAGE_TIMEOUT",
                            "retryable": True,
                            "phase": getattr(error, "phase", "processing"),
                        },
                    )
                if isinstance(error, CancelledError):
                    return self.reply(499, {"error": "Image request cancelled"})
                return self.reply(
                    503,
                    {
                        "error": "Image source unavailable",
                        "code": "IMAGE_SOURCE_UNAVAILABLE",
                        "retryable": True,
                    },
                )

        def reply(self, status, value):
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
            if images is not None:
                self.send_header("X-Image-Cancel-Protocol", "1")
            if (
                status == 429
                and isinstance(value, dict)
                and value.get("retryAfterSeconds")
            ):
                self.send_header("Retry-After", str(value["retryAfterSeconds"]))
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

        worker = None
        if args.command in ("serve", "refresh"):
            from image_media import TelegramWorker

            worker = TelegramWorker(lambda: make_client(root, config), cache, config)

        def collect():
            started = time.monotonic()
            try:
                result = (
                    worker.run(
                        refresh(root, config, cache, worker.client, worker.images)
                    )
                    if worker
                    else asyncio.run(refresh(root, config, cache))
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
                return True
            except Exception as error:  # noqa: BLE001 -- Persist safe error categories and retain the cache.
                cache.fail(error)
                print(
                    json.dumps({"refreshFailed": True, "error": type(error).__name__}),
                    flush=True,
                )
                return False

        if args.command == "refresh":
            try:
                success = collect()
                if success:
                    worker.run(worker.images.prefetch_pending())
                raise SystemExit(0 if success else 1)
            finally:
                worker.close()
        stop = threading.Event()
        server = make_server(cache, config, worker.images)

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
            worker.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 -- Never expose upstream credentials in a traceback.
        # Upstream exceptions can contain phone numbers or request data.
        print(json.dumps({"success": False, "error": type(error).__name__}), flush=True)
        raise SystemExit(1) from None
