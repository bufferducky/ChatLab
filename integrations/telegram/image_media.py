"""Persist Telegram media references and prefetch previews into ChatLab's shared cache."""

import asyncio
import base64
import hashlib
import json
import os
import re
import shutil
import threading
import time
from pathlib import Path
from urllib.parse import quote

MAX_IMAGE_BYTES = 50 * 1024 * 1024


def image_metadata(message):
    """Retain the received TL media object; no second message RPC is needed."""
    from telethon import types

    photo = getattr(message, "photo", None)
    document = getattr(message, "document", None)
    if isinstance(photo, types.Photo) and photo.sizes:
        return bytes(photo), message.message or ""
    if (
        isinstance(document, types.Document)
        and document.mime_type in ("image/jpeg", "image/png", "image/webp", "image/gif")
        and not getattr(message, "sticker", None)
        and not getattr(message, "gif", None)
        and not getattr(message, "video", None)
    ):
        return bytes(document), message.message or ""
    return None


class TelegramImages:
    """Share the collector connection and persist only previews, never another original."""

    def __init__(self, cache, client, loop, config=None):
        self.cache, self.client, self.loop = cache, client, loop
        self.config = config or {}
        self.directory = Path(
            self.config.get(
                "imageCacheDir", Path.home() / ".chatlab/cache/message-images"
            )
        ).expanduser()
        self.gate = asyncio.Semaphore(2)
        self.prefetch_gate = asyncio.Lock()
        self.wake = asyncio.Event()
        self.pending = {}

    def manifest_url(self, sid, mid):
        base = self.config.get(
            "imageBaseUrl", f"http://127.0.0.1:{self.config.get('port', 5036)}/api/v1"
        ).rstrip("/")
        return f"{base}/sessions/{quote(sid, safe='')}/messages/{quote(str(mid), safe='')}/images"

    def cached_preview(self, sid, mid):
        key = hashlib.sha256(
            (self.manifest_url(sid, mid) + "/0?size=preview").encode()
        ).hexdigest()
        try:
            ref = json.loads((self.directory / f"{key}.json").read_text())
            if (
                not re.fullmatch(r"[a-f0-9]{64}", ref.get("blob", ""))
                or ref.get("mime") != "image/webp"
            ):
                return None
            path = self.directory / f"{ref['blob']}.bin"
            data = path.read_bytes()
            os.utime(path, None)
            return data
        except FileNotFoundError:
            return None

    def metadata(self, sid, mid):
        with self.cache.connect() as db:
            row = db.execute(
                "SELECT 1 FROM messages WHERE session_id=? AND native_id=?",
                (sid, int(mid)),
            ).fetchone()
            account = db.execute(
                "SELECT value FROM state WHERE key='account'"
            ).fetchone()
            if not row or not account or sid.split(":")[:2] != ["telegram", account[0]]:
                raise KeyError("Unknown image message")
            return db.execute(
                "SELECT media,caption FROM image_metadata WHERE session_id=? AND native_id=?",
                (sid, int(mid)),
            ).fetchone()

    async def fetch_metadata(self, sid, mid):
        if self.cache.status()["retryAfter"] > time.time():
            raise RuntimeError("TelegramRateLimited")
        if not self.client.is_connected():
            await self.client.connect()
        message = await self.client.get_messages(
            int(sid.rsplit(":", 1)[1]), ids=int(mid)
        )
        metadata = image_metadata(message)
        if not metadata:
            raise KeyError("Image unavailable")
        media, caption = metadata
        with self.cache.connect() as db:
            db.execute(
                """INSERT INTO image_metadata(session_id,native_id,media,caption)
                VALUES(?,?,?,?) ON CONFLICT(session_id,native_id)
                DO UPDATE SET media=excluded.media,caption=excluded.caption""",
                (sid, int(mid), media, caption),
            )
        return {"media": media, "caption": caption}

    async def resolve(self, sid, mid, size=None):
        row = self.metadata(sid, mid)
        if size == "preview" and (cached := self.cached_preview(sid, mid)):
            return cached
        if size is None and row:
            return {"images": [{"index": 0}], "caption": row["caption"]}
        key = (sid, str(mid), size)
        if key not in self.pending:

            async def download():
                try:
                    return await asyncio.wait_for(self.download(sid, mid, size), 60)
                finally:
                    self.pending.pop(key, None)

            self.pending[key] = asyncio.create_task(download())
        return await asyncio.shield(self.pending[key])

    async def download(self, sid, mid, size):
        from telethon import errors, types
        from telethon.extensions import BinaryReader

        async with self.gate:
            row = self.metadata(sid, mid)
            if row is None:
                row = await self.fetch_metadata(sid, mid)
            if size is None:
                return {"images": [{"index": 0}], "caption": row["caption"]}
            if self.cache.status()["retryAfter"] > time.time():
                raise RuntimeError("TelegramRateLimited")
            if not self.client.is_connected():
                await self.client.connect()
            for attempt in range(2):
                with BinaryReader(row["media"]) as reader:
                    media = reader.tgread_object()
                if isinstance(media, types.Document) and media.size > MAX_IMAGE_BYTES:
                    raise ValueError("Image too large")
                thumb = None
                if size == "preview":
                    sizes = getattr(media, "sizes", None) or getattr(
                        media, "thumbs", []
                    )
                    sizes = [
                        s
                        for s in sizes
                        if isinstance(
                            s,
                            (
                                types.PhotoSize,
                                types.PhotoCachedSize,
                                types.PhotoSizeProgressive,
                            ),
                        )
                    ]
                    if sizes:
                        small = [s for s in sizes if max(s.w, s.h) <= 640]
                        thumb = (
                            max(small, key=lambda s: s.w * s.h)
                            if small
                            else min(sizes, key=lambda s: s.w * s.h)
                        )
                        # Telethon 1.45 accepts progressive thumbnails by type name,
                        # but not as a PhotoSizeProgressive object.
                        if isinstance(thumb, types.PhotoSizeProgressive):
                            thumb = thumb.type
                    else:
                        stripped = [
                            s
                            for s in getattr(media, "sizes", [])
                            if isinstance(s, types.PhotoStrippedSize)
                        ]
                        if not stripped:
                            raise KeyError("Preview unavailable")
                        thumb = stripped[0]

                def progress(received, _total):
                    if received > MAX_IMAGE_BYTES:
                        raise ValueError("Image too large")

                try:
                    data = await self.client.download_media(
                        media, file=bytes, thumb=thumb, progress_callback=progress
                    )
                except (
                    errors.FileReferenceExpiredError,
                    errors.FileReferenceInvalidError,
                ):
                    if attempt:
                        raise
                    # Telegram file references expire; refresh only when the server asks.
                    row = await self.fetch_metadata(sid, mid)
                    continue
                if not data:
                    raise KeyError("Image unavailable")
                if len(data) > MAX_IMAGE_BYTES:
                    raise ValueError("Image too large")
                return data

    async def store_preview(self, sid, mid, caption, data):
        node = self.config.get("nodeExecutable") or shutil.which("node")
        if not node:
            raise RuntimeError("NodeRuntimeUnavailable")
        script = Path(__file__).with_name("image-cache.mts")
        process = await asyncio.create_subprocess_exec(
            node,
            "--import",
            "tsx",
            str(script),
            str(self.directory),
            cwd=script.parents[2],
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            payload = json.dumps(
                {
                    "manifestUrl": self.manifest_url(sid, mid),
                    "caption": caption,
                    "data": base64.b64encode(data).decode(),
                }
            ).encode()
            await asyncio.wait_for(process.communicate(payload), 30)
            if process.returncode:
                raise RuntimeError("PreviewCacheWriteFailed")
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()

    def wake_prefetch(self):
        self.wake.set()

    async def prefetch_pending(self):
        """Drain committed work only; failed downloads never roll back message checkpoints."""
        async with self.prefetch_gate:
            completed = failed = 0
            while self.cache.status()["retryAfter"] <= time.time():
                with self.cache.connect() as db:
                    row = db.execute(
                        """SELECT session_id,native_id,caption FROM image_metadata
                        WHERE preview_done=0 AND next_retry<=? ORDER BY rowid LIMIT 1""",
                        (time.time(),),
                    ).fetchone()
                if row is None:
                    break
                sid, mid, caption = (
                    row["session_id"],
                    str(row["native_id"]),
                    row["caption"],
                )
                try:
                    if self.cached_preview(sid, mid) is None:
                        data = await self.resolve(sid, mid, "preview")
                        await self.store_preview(sid, mid, caption, data)
                    with self.cache.connect() as db:
                        db.execute(
                            """UPDATE image_metadata SET preview_done=1,next_retry=0,error=''
                            WHERE session_id=? AND native_id=?""",
                            (sid, int(mid)),
                        )
                    completed += 1
                except Exception as error:  # noqa: BLE001 -- Keep collection alive; retry media independently.
                    with self.cache.connect() as db:
                        db.execute(
                            """UPDATE image_metadata SET next_retry=?,error=?
                            WHERE session_id=? AND native_id=?""",
                            (
                                max(
                                    time.time() + 1800,
                                    self.cache.status()["retryAfter"],
                                ),
                                type(error).__name__,
                                sid,
                                int(mid),
                            ),
                        )
                    failed += 1
            if completed or failed:
                print(
                    json.dumps(
                        {
                            "event": "telegramPreviewPrefetch",
                            "completed": completed,
                            "failed": failed,
                        }
                    ),
                    flush=True,
                )

    async def prefetch_loop(self):
        while True:
            self.wake.clear()
            await self.prefetch_pending()
            try:
                await asyncio.wait_for(self.wake.wait(), 30)
            except TimeoutError:
                pass

    def request(self, sid, mid, size=None):
        future = asyncio.run_coroutine_threadsafe(
            self.resolve(sid, mid, size), self.loop
        )
        try:
            return future.result(timeout=65)
        except TimeoutError:
            future.cancel()
            raise


class TelegramWorker:
    """Keep all collector and image requests on a single Telethon connection."""

    def __init__(self, make_client, cache, config=None):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()

        async def start():
            self.client = make_client()
            self.images = TelegramImages(cache, self.client, self.loop, config)
            if cache is not None:
                self.prefetch_task = asyncio.create_task(self.images.prefetch_loop())

        self.run(start(), timeout=30)

    def run(self, coroutine, timeout=None):
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop).result(timeout)

    def close(self):
        async def shutdown():
            tasks = [
                task
                for task in asyncio.all_tasks()
                if task is not asyncio.current_task()
            ]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await self.client.disconnect()

        try:
            self.run(shutdown(), timeout=15)
        finally:
            self.loop.call_soon_threadsafe(self.loop.stop)
            self.thread.join(timeout=5)
