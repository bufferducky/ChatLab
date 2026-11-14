"""Persist Telegram media references and prefetch originals into ChatLab's shared cache."""

import asyncio
import base64
import contextlib
import hashlib
import json
import os
import re
import shutil
import threading
import time
from pathlib import Path
from urllib.parse import quote

from media_scheduler import MediaJob, MediaScheduler, media_job

MAX_IMAGE_BYTES = 50 * 1024 * 1024
RASTER_IMAGE_MIMES = ("image/jpeg", "image/png", "image/webp", "image/gif")


def image_metadata(message):
    """Retain the received TL media object; no second message RPC is needed."""
    from telethon import types

    photo = getattr(message, "photo", None)
    document = getattr(message, "document", None)
    if isinstance(photo, types.Photo) and photo.sizes:
        return bytes(photo), message.message or ""
    # TGS/WebM stickers expose a server-rendered raster thumbnail.
    if (
        isinstance(document, types.Document)
        and getattr(message, "sticker", None)
        and (document.mime_type in RASTER_IMAGE_MIMES or document.thumbs)
    ):
        return bytes(document), message.message or ""
    if (
        isinstance(document, types.Document)
        and document.mime_type in RASTER_IMAGE_MIMES
        and not getattr(message, "gif", None)
        and not getattr(message, "video", None)
    ):
        return bytes(document), message.message or ""
    return None


class TelegramImages:
    """Share the collector connection and its existing preview/original cache."""

    def __init__(self, cache, client, loop, config=None):
        self.cache, self.client, self.loop = cache, client, loop
        self.config = config or {}
        self.directory = Path(
            self.config.get(
                "imageCacheDir", Path.home() / ".chatlab/cache/message-images"
            )
        ).expanduser()
        self.scheduler = getattr(client, "media_scheduler", None) or MediaScheduler(
            cache
        )
        self.requests = {}
        self.cancelled_requests = {}
        self.metadata_batches = {}
        self.metadata_users = {}
        self.metadata_tasks = {}
        self.metadata_jobs = {}
        self.prefetch_gate = asyncio.Lock()
        self.wake = asyncio.Event()
        self.collection_idle = asyncio.Event()
        self.collection_idle.set()

    @contextlib.contextmanager
    def pause_prefetch(self):
        """Finish an in-flight image, then reserve new requests for message collection."""
        self.collection_idle.clear()
        self.scheduler.background_paused = True
        try:
            yield
        finally:
            self.collection_idle.set()
            self.scheduler.background_paused = False
            asyncio.create_task(self.scheduler.changed())
            self.wake_prefetch()

    def manifest_url(self, sid, mid):
        base = self.config.get(
            "imageBaseUrl", f"http://127.0.0.1:{self.config.get('port', 5036)}/api/v1"
        ).rstrip("/")
        return f"{base}/sessions/{quote(sid, safe='')}/messages/{quote(str(mid), safe='')}/images"

    def cached_image(self, sid, mid, size):
        key = hashlib.sha256(
            (self.manifest_url(sid, mid) + "/0?size=" + size).encode()
        ).hexdigest()
        try:
            ref = json.loads((self.directory / f"{key}.json").read_text())
            if not re.fullmatch(r"[a-f0-9]{64}", ref.get("blob", "")) or not ref.get(
                "mime", ""
            ).startswith("image/"):
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

    async def connect(self):
        ensure = getattr(self.client, "ensure_media_connection", None)
        if ensure:
            await ensure()
        elif not self.client.is_connected():
            await self.client.connect()

    async def prepare_transport(self):
        """Warm the latest media DC using Telethon's shared exported sender."""
        from telethon.extensions import BinaryReader

        async def initialize():
            self.scheduler.check_cooldown()
            await self.connect()
            with self.cache.connect() as db:
                row = db.execute(
                    "SELECT media FROM image_metadata ORDER BY rowid DESC LIMIT 1"
                ).fetchone()
            if row:
                with BinaryReader(row["media"]) as reader:
                    dc = getattr(reader.tgread_object(), "dc_id", None)
                if dc and dc != self.client.session.dc_id:
                    sender = await self.client._borrow_exported_sender(dc)
                    await self.client._return_exported_sender(sender)

        started = time.monotonic()
        try:
            await self.scheduler.run(("transport",), 3, initialize)
            print(
                json.dumps(
                    {
                        "event": "telegramMediaTransport",
                        "ready": True,
                        "durationSeconds": round(time.monotonic() - started, 3),
                        "smallConcurrency": self.scheduler.small_limit,
                        "largeConcurrency": self.scheduler.large_limit,
                    }
                ),
                flush=True,
            )
        except Exception as error:  # noqa: BLE001 -- Reading can retry initialization without losing cached data.
            print(
                json.dumps(
                    {
                        "event": "telegramMediaTransport",
                        "ready": False,
                        "error": type(error).__name__,
                    }
                ),
                flush=True,
            )

    async def fetch_metadata(self, sid, mid):
        """Batch concurrent missing/expired references within a peer."""
        key = (sid, str(mid))
        if key not in self.metadata_batches:
            self.metadata_batches[key] = self.loop.create_future()
        self.metadata_users[key] = self.metadata_users.get(key, 0) + 1
        owner = self.metadata_jobs.setdefault(sid, MediaJob(large=False))
        subscription = object()
        owner.subscribers[subscription] = media_job.get() or 1
        await self.scheduler.changed()
        if sid not in self.metadata_tasks:
            self.metadata_tasks[sid] = asyncio.create_task(
                self._fetch_metadata_batch(sid)
            )
        try:
            return await asyncio.shield(self.metadata_batches[key])
        finally:
            owner.subscribers.pop(subscription, None)
            await self.scheduler.changed()
            self.metadata_users[key] -= 1
            if not self.metadata_users[key]:
                self.metadata_users.pop(key, None)
            if not any(k[0] == sid for k in self.metadata_users):
                task = self.metadata_tasks.get(sid)
                if task and not task.done():
                    task.cancel()

    async def _fetch_metadata_batch(self, sid):
        batch = {}
        token = media_job.set(self.metadata_jobs[sid])
        try:
            await asyncio.sleep(0)
            batch = {k: v for k, v in self.metadata_batches.items() if k[0] == sid}
            self.scheduler.check_cooldown()
            await self.connect()
            mids = [int(k[1]) for k in batch]
            messages = await self.client.get_messages(
                int(sid.rsplit(":", 1)[1]), ids=mids if len(mids) > 1 else mids[0]
            )
            if len(mids) == 1:
                messages = [messages]
            results = {}
            for message in messages:
                if metadata := image_metadata(message):
                    media, caption = metadata
                    results[str(message.id)] = {"media": media, "caption": caption}
                    with self.cache.connect() as db:
                        db.execute(
                            """INSERT INTO image_metadata(session_id,native_id,media,caption)
                            VALUES(?,?,?,?) ON CONFLICT(session_id,native_id)
                            DO UPDATE SET media=excluded.media,caption=excluded.caption""",
                            (sid, message.id, media, caption),
                        )
            for key, future in batch.items():
                if future.done():
                    continue
                if key[1] in results:
                    future.set_result(results[key[1]])
                else:
                    future.set_exception(KeyError("Image unavailable"))
        except BaseException as error:  # noqa: BLE001 -- Fan out failures and cancellation to batch subscribers.
            for key, future in batch.items():
                if not future.done():
                    if isinstance(
                        error, asyncio.CancelledError
                    ) or not self.metadata_users.get(key):
                        future.cancel()
                    else:
                        future.set_exception(error)
        finally:
            if not batch:
                batch = {k: v for k, v in self.metadata_batches.items() if k[0] == sid}
                for future in batch.values():
                    future.cancel()
            for key in batch:
                self.metadata_batches.pop(key, None)
            media_job.reset(token)
            self.metadata_tasks.pop(sid, None)
            if any(k[0] == sid for k in self.metadata_batches):
                self.metadata_tasks[sid] = asyncio.create_task(
                    self._fetch_metadata_batch(sid)
                )

    def mark_ready(self, sid, mid, size):
        with self.cache.connect() as db:
            if size == "original":
                db.execute(
                    """UPDATE image_metadata SET original_done=1,original_next_retry=0,
                    original_error='',preview_done=1,next_retry=0,error=''
                    WHERE session_id=? AND native_id=?""",
                    (sid, int(mid)),
                )
            else:
                db.execute(
                    """UPDATE image_metadata SET preview_done=1,next_retry=0,error=''
                    WHERE session_id=? AND native_id=?""",
                    (sid, int(mid)),
                )

    async def resolve(self, sid, mid, size=None, *, priority=None):
        row = self.metadata(sid, mid)
        if size in ("preview", "original") and (
            cached := self.cached_image(sid, mid, size)
        ):
            if size == "original" and self.cached_image(sid, mid, "preview") is None:
                await self.store_image(
                    sid, mid, row["caption"] if row else "", cached, "original"
                )
            self.mark_ready(sid, mid, size)
            return cached
        if size is None and row:
            return {"images": [{"index": 0}], "caption": row["caption"]}
        key = (sid, str(mid), size)
        priority = (
            priority if priority is not None else (0 if size == "original" else 1)
        )

        async def prepare():
            if size == "preview" and (
                original := self.cached_image(sid, mid, "original")
            ):
                await self.store_image(
                    sid, mid, row["caption"] if row else "", original, "original"
                )
                cached = self.cached_image(sid, mid, "preview")
                if cached:
                    self.mark_ready(sid, mid, "original")
                    return cached
            data = await self.download(sid, mid, size)
            if size is not None:
                metadata = self.metadata(sid, mid)
                await self.store_image(sid, mid, metadata["caption"], data, size)
                # Completion follows validated, atomic cache writes only.
                self.mark_ready(sid, mid, size)
                if priority < 2:
                    self.wake_prefetch()
                return self.cached_image(sid, mid, size) or data
            return data

        return await self.scheduler.run(key, priority, prepare)

    async def download(self, sid, mid, size):
        from telethon import errors, types
        from telethon.extensions import BinaryReader

        row = self.metadata(sid, mid)
        if row is None:
            row = await self.fetch_metadata(sid, mid)
        if size is None:
            return {"images": [{"index": 0}], "caption": row["caption"]}
        self.scheduler.check_cooldown()
        await self.connect()
        for attempt in range(2):
            with BinaryReader(row["media"]) as reader:
                media = reader.tgread_object()
            if isinstance(media, types.Document) and media.size > MAX_IMAGE_BYTES:
                raise ValueError("Image too large")
            job = media_job.get()
            if job:
                sizes = getattr(media, "sizes", [])
                known_size = getattr(media, "size", None)
                if known_size is None and sizes:
                    known_size = max(
                        (
                            getattr(v, "size", 0)
                            or max(getattr(v, "sizes", [0]), default=0)
                            for v in sizes
                        ),
                        default=0,
                    )
                job.large = not known_size or known_size > 20 * 1024 * 1024
                if size == "preview":
                    job.large = False
            thumb = None
            animated_sticker = (
                isinstance(media, types.Document)
                and media.mime_type not in RASTER_IMAGE_MIMES
                and any(
                    isinstance(a, types.DocumentAttributeSticker)
                    for a in media.attributes
                )
            )
            if size == "preview" or animated_sticker:
                sizes = getattr(media, "sizes", None) or getattr(media, "thumbs", [])
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
                        for s in (
                            getattr(media, "sizes", None)
                            or getattr(media, "thumbs", [])
                        )
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

    async def store_image(self, sid, mid, caption, data, size):
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
                    "size": size,
                }
            ).encode()
            stdout, _ = await asyncio.wait_for(process.communicate(payload), 30)
            if process.returncode:
                raise RuntimeError("PreviewCacheWriteFailed")
            result = json.loads(stdout)
            if job := media_job.get():
                job.conversion_seconds += result.get("conversionSeconds", 0)
                job.cache_seconds += result.get("cacheSeconds", 0)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()

    def wake_prefetch(self):
        self.wake.set()

    async def prefetch_pending(self):
        """Drain committed work only; failed downloads never roll back message checkpoints."""
        async with self.prefetch_gate:
            completed = originals = failed = 0
            while self.cache.status()["retryAfter"] <= time.time():
                while not self.collection_idle.is_set():
                    await self.collection_idle.wait()
                if self.cache.status()["retryAfter"] > time.time():
                    break
                with self.cache.connect() as db:
                    row = db.execute(
                        """SELECT * FROM image_metadata
                        WHERE (preview_done=0 AND next_retry<=?)
                           OR (original_done=0 AND original_next_retry<=?)
                        ORDER BY preview_done,rowid DESC LIMIT 1""",
                        (time.time(), time.time()),
                    ).fetchone()
                if row is None:
                    break
                sid, mid = row["session_id"], str(row["native_id"])
                size = (
                    "original"
                    if not row["original_done"]
                    and row["original_next_retry"] <= time.time()
                    else "preview"
                )
                try:
                    # One original download also generates its preview locally.
                    await self.resolve(
                        sid, mid, size, priority=2 if not row["preview_done"] else 3
                    )
                    if size == "original":
                        originals += 1
                    completed += 1
                except Exception as error:  # noqa: BLE001 -- Keep collection alive; retry media independently.
                    with self.cache.connect() as db:
                        retry_column, error_column = (
                            ("original_next_retry", "original_error")
                            if size == "original"
                            else ("next_retry", "error")
                        )
                        db.execute(
                            f"""UPDATE image_metadata SET {retry_column}=?,{error_column}=?
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
                            "event": "telegramImagePrefetch",
                            "completed": completed,
                            "originals": originals,
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

    async def subscribe(self, request_id, sid, mid, size):
        now = time.monotonic()
        self.cancelled_requests = {
            k: v for k, v in self.cancelled_requests.items() if v > now
        }
        if request_id in self.cancelled_requests:
            raise asyncio.CancelledError()
        task = asyncio.current_task()
        if request_id:
            self.requests[request_id] = task
        try:
            return await self.resolve(sid, mid, size)
        finally:
            if self.requests.get(request_id) is task:
                self.requests.pop(request_id, None)

    async def cancel(self, request_id):
        self.cancelled_requests[request_id] = time.monotonic() + 70
        task = self.requests.get(request_id)
        if task:
            task.cancel()
        return {"cancelled": True}

    def request(self, sid, mid, size=None, request_id=None):
        future = asyncio.run_coroutine_threadsafe(
            self.subscribe(request_id, sid, mid, size), self.loop
        )
        try:
            return future.result(timeout=62)
        except TimeoutError:
            future.cancel()
            raise

    def cancel_request(self, request_id):
        return asyncio.run_coroutine_threadsafe(
            self.cancel(request_id), self.loop
        ).result(5)


class TelegramWorker:
    """Keep all collector and image requests on a single Telethon connection."""

    def __init__(self, make_client, cache, config=None):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()

        async def start():
            self.client = make_client()
            self.images = TelegramImages(cache, self.client, self.loop, config)
            if cache is not None and hasattr(self.client, "ensure_media_connection"):
                self.transport_task = asyncio.create_task(
                    self.images.prepare_transport()
                )
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
            if not self.thread.is_alive():
                self.loop.close()
