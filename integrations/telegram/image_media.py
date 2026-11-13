"""Resolve archived Telegram image messages without downloading history."""

import asyncio
import threading
import time

MAX_IMAGE_BYTES = 50 * 1024 * 1024


class TelegramImages:
    """Use the collector's event loop and client, including its entity cache."""

    def __init__(self, cache, client, loop):
        self.cache, self.client, self.loop = cache, client, loop
        self.gate = asyncio.Semaphore(2)

    async def resolve(self, sid, mid, size=None):
        from telethon import types

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
        if self.cache.status()["retryAfter"] > time.time():
            raise RuntimeError("TelegramRateLimited")
        async with self.gate:
            if not self.client.is_connected():
                await self.client.connect()
            message = await self.client.get_messages(
                int(sid.rsplit(":", 1)[1]), ids=int(mid)
            )
            photo = getattr(message, "photo", None)
            document = getattr(message, "document", None)
            is_image = photo or (
                document
                and document.mime_type
                in ("image/jpeg", "image/png", "image/webp", "image/gif")
            )
            if not is_image:
                raise KeyError("Image unavailable")
            if size is None:
                return {"images": [{"index": 0}], "caption": message.message or ""}
            if document and document.size > MAX_IMAGE_BYTES:
                raise ValueError("Image too large")
            thumb = None
            if size == "preview":
                sizes = getattr(photo, "sizes", None) or getattr(document, "thumbs", [])
                sizes = [
                    s
                    for s in sizes
                    if isinstance(s, (types.PhotoSize, types.PhotoCachedSize))
                ]
                if sizes:
                    small = [s for s in sizes if max(s.w, s.h) <= 640]
                    thumb = (
                        max(small, key=lambda s: s.w * s.h)
                        if small
                        else min(sizes, key=lambda s: s.w * s.h)
                    )

            def progress(received, _total):
                if received > MAX_IMAGE_BYTES:
                    raise ValueError("Image too large")

            data = await self.client.download_media(
                message, file=bytes, thumb=thumb, progress_callback=progress
            )
            if not data:
                raise KeyError("Image unavailable")
            if len(data) > MAX_IMAGE_BYTES:
                raise ValueError("Image too large")
            return data

    def request(self, sid, mid, size=None):
        future = asyncio.run_coroutine_threadsafe(
            self.resolve(sid, mid, size), self.loop
        )
        try:
            return future.result(timeout=60)
        except TimeoutError:
            future.cancel()
            raise


class TelegramWorker:
    """Keep all collector and image requests on a single Telethon connection."""

    def __init__(self, make_client, cache):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()

        async def start():
            self.client = make_client()

        self.run(start(), timeout=30)
        self.images = TelegramImages(cache, self.client, self.loop)

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
