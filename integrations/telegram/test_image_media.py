"""Keep collected previews available without requerying messages or duplicating originals."""

import asyncio
import tempfile
import unittest
from datetime import UTC, datetime

from bridge import Cache, refresh
from image_media import TelegramImages, TelegramWorker
from telethon import types


def synthetic_photo(mid=9):
    return types.Message(
        id=mid,
        peer_id=types.PeerChat(2),
        from_id=types.PeerUser(42),
        date=datetime.now(UTC),
        message="caption",
        media=types.MessageMediaPhoto(
            photo=types.Photo(
                id=1,
                access_hash=2,
                file_reference=b"reference",
                date=datetime.now(UTC),
                dc_id=1,
                sizes=[types.PhotoSize(type="m", w=320, h=240, size=20)],
            )
        ),
    )


class ImageTests(unittest.TestCase):
    def test_slow_preview_does_not_block_collecting_the_next_chat(self):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock

        with tempfile.TemporaryDirectory() as root:

            async def run():
                started, release = asyncio.Event(), asyncio.Event()

                class Client:
                    connect = AsyncMock()
                    is_user_authorized = AsyncMock(return_value=True)
                    get_me = AsyncMock(return_value=SimpleNamespace(id=1))

                    def is_connected(self):
                        return True

                    async def iter_dialogs(self):
                        for peer in [-2, -3]:
                            yield SimpleNamespace(
                                id=peer, name="Synthetic", is_user=False, entity=peer
                            )

                    async def iter_messages(self, entity, **_kwargs):
                        if entity == -2:
                            yield synthetic_photo()
                        else:
                            await started.wait()
                            yield types.Message(
                                id=10,
                                peer_id=types.PeerChat(3),
                                date=datetime.now(UTC),
                                message="text",
                            )

                    async def download_media(self, *_args, **_kwargs):
                        started.set()
                        await release.wait()
                        return b"preview"

                cache = Cache(root)
                client = Client()
                images = TelegramImages(cache, client, asyncio.get_running_loop())
                images.store_preview = AsyncMock()
                background = asyncio.create_task(images.prefetch_loop())
                try:
                    result = await asyncio.wait_for(
                        refresh(
                            root, {"selectedPeers": [-2, -3]}, cache, client, images
                        ),
                        1,
                    )
                    self.assertEqual(result["changedMessages"], 2)
                    self.assertFalse(release.is_set())
                    self.assertEqual(cache.cursor("telegram:1:-3"), 10)
                    release.set()
                    await asyncio.wait_for(images.prefetch_pending(), 1)
                    self.assertEqual(images.store_preview.await_count, 1)
                finally:
                    background.cancel()
                    await asyncio.gather(background, return_exceptions=True)

            asyncio.run(run())

    def test_progressive_thumbnail_uses_the_installed_telethon_download_contract(self):
        from bridge import convert_message
        from image_media import image_metadata
        from telethon import TelegramClient

        with tempfile.TemporaryDirectory() as root:
            cache = Cache(root)
            cache.bind_account(1)
            sid = cache.session(1, -2, "Synthetic", "group")
            message = synthetic_photo()
            message.photo.sizes = [
                types.PhotoSizeProgressive(type="x", w=640, h=480, sizes=[10, 20])
            ]
            cache.ingest(
                sid,
                [convert_message(message)],
                images=[("9", *image_metadata(message))],
            )

            class Client:
                def is_connected(self):
                    return True

                async def download_media(self, media, file, thumb, progress_callback):
                    chosen = TelegramClient._get_thumb(media.sizes, thumb)
                    if chosen is None:
                        raise AssertionError("Telethon cannot resolve the preview size")
                    return b"progressive-preview"

            async def run():
                images = TelegramImages(cache, Client(), asyncio.get_running_loop())
                self.assertEqual(
                    await images.resolve(sid, "9", "preview"), b"progressive-preview"
                )

            asyncio.run(run())

    def test_collection_keeps_media_and_prefetch_survives_restart_without_querying_message(
        self,
    ):
        """A newly collected picture must open offline after its preview is prepared."""
        from types import SimpleNamespace
        from unittest.mock import AsyncMock

        with tempfile.TemporaryDirectory() as root:
            stamp = datetime.now(UTC)
            photo = types.Photo(
                id=1,
                access_hash=2,
                file_reference=b"reference",
                date=stamp,
                dc_id=1,
                sizes=[types.PhotoSize(type="m", w=320, h=240, size=20)],
            )
            message = types.Message(
                id=9,
                peer_id=types.PeerChat(2),
                from_id=types.PeerUser(42),
                date=stamp,
                message="caption",
                media=types.MessageMediaPhoto(photo=photo),
            )

            class Client:
                connect = AsyncMock()
                is_user_authorized = AsyncMock(return_value=True)
                get_me = AsyncMock(return_value=SimpleNamespace(id=1))
                get_messages = AsyncMock(side_effect=AssertionError("Redundant query"))
                download_media = AsyncMock(return_value=b"preview")

                def is_connected(self):
                    return True

                async def iter_dialogs(self):
                    yield SimpleNamespace(
                        id=-2, name="Synthetic", is_user=False, entity=-2
                    )

                async def iter_messages(self, *_args, **_kwargs):
                    yield message

            async def run():
                cache = Cache(root)
                client = Client()
                # The persisted download queue must be usable by a fresh service.
                await refresh(root, {"selectedPeers": [-2]}, cache, client)
                restarted = Cache(root)
                images = TelegramImages(restarted, client, asyncio.get_running_loop())
                saved = []

                async def store(sid, mid, caption, data):
                    saved.append((sid, mid, caption, data))

                images.store_preview = store
                await images.prefetch_pending()
                self.assertEqual(saved, [("telegram:1:-2", "9", "caption", b"preview")])
                self.assertEqual(restarted.cursor("telegram:1:-2"), 9)
                self.assertEqual(restarted.status()["messages"], 1)
                self.assertEqual(
                    await images.resolve("telegram:1:-2", "9"),
                    {"images": [{"index": 0}], "caption": "caption"},
                )
                self.assertEqual(client.download_media.await_args.args[0].id, photo.id)
                self.assertEqual(
                    client.download_media.await_args.kwargs["thumb"].w, 320
                )
                self.assertEqual(client.get_messages.await_count, 0)
                await images.prefetch_pending()
                self.assertEqual(len(saved), 1)

            asyncio.run(run())

    def test_failed_prefetch_preserves_messages_and_retries_after_restart(self):
        from unittest.mock import AsyncMock, patch

        from bridge import convert_message
        from image_media import image_metadata

        with tempfile.TemporaryDirectory() as root:
            cache = Cache(root)
            cache.bind_account(1)
            sid = cache.session(1, -2, "Synthetic", "group")
            message = synthetic_photo()
            cache.ingest(
                sid,
                [convert_message(message)],
                images=[("9", *image_metadata(message))],
            )
            cache.finish()

            async def run():
                client = type(
                    "Client",
                    (),
                    {
                        "is_connected": lambda _: True,
                        "download_media": AsyncMock(
                            side_effect=ConnectionError("offline")
                        ),
                    },
                )()
                images = TelegramImages(cache, client, asyncio.get_running_loop())
                await images.prefetch_pending()
                self.assertEqual(cache.cursor(sid), 9)
                self.assertEqual(cache.status()["messages"], 1)
                self.assertEqual(cache.status()["error"], "")
                with cache.connect() as db:
                    row = db.execute(
                        "SELECT preview_done,next_retry FROM image_metadata"
                    ).fetchone()
                self.assertEqual(row["preview_done"], 0)
                self.assertGreater(row["next_retry"], 0)
                # The queue is durable, but a failure cannot create a tight retry loop.
                await images.prefetch_pending()
                self.assertEqual(client.download_media.await_count, 1)
                client.download_media = AsyncMock(return_value=b"preview")
                restarted = TelegramImages(
                    Cache(root), client, asyncio.get_running_loop()
                )
                restarted.store_preview = AsyncMock()
                with patch("image_media.time.time", return_value=row["next_retry"] + 1):
                    await restarted.prefetch_pending()
                self.assertEqual(restarted.store_preview.await_count, 1)

            asyncio.run(run())

    def test_expired_saved_media_refreshes_reference_and_original_stays_on_demand(self):
        from unittest.mock import AsyncMock

        from bridge import convert_message
        from image_media import image_metadata
        from telethon import errors

        with tempfile.TemporaryDirectory() as root:
            cache = Cache(root)
            cache.bind_account(1)
            sid = cache.session(1, -2, "Synthetic", "group")
            message = synthetic_photo()
            cache.ingest(
                sid,
                [convert_message(message)],
                images=[("9", *image_metadata(message))],
            )

            async def run():
                client = type(
                    "Client",
                    (),
                    {
                        "is_connected": lambda _: True,
                        "get_messages": AsyncMock(return_value=message),
                        "download_media": AsyncMock(
                            side_effect=[
                                errors.FileReferenceExpiredError(request=None),
                                b"preview",
                                b"original",
                            ]
                        ),
                    },
                )()
                images = TelegramImages(cache, client, asyncio.get_running_loop())
                images.store_preview = AsyncMock()
                await images.prefetch_pending()
                self.assertEqual(client.get_messages.await_count, 1)
                self.assertTrue(
                    all(
                        c.kwargs["thumb"].w == 320
                        for c in client.download_media.await_args_list
                    )
                )
                self.assertEqual(
                    await images.resolve(sid, "9", "original"), b"original"
                )
                self.assertIsNone(client.download_media.await_args.kwargs["thumb"])

            asyncio.run(run())

    def test_old_message_resolves_preview_and_original_without_reimport(self):
        with tempfile.TemporaryDirectory() as root:
            cache = Cache(root)
            cache.bind_account(1)
            sid = cache.session(1, -2, "Synthetic", "group")
            cache.ingest(
                sid,
                [
                    {
                        "platformMessageId": "9",
                        "sender": "42",
                        "timestamp": 100,
                        "type": 1,
                        "content": "[photo]",
                    }
                ],
            )
            cache.finish()
            downloaded = []

            class Client:
                def is_connected(self):
                    return True

                async def get_messages(self, peer, ids):
                    self.last_request = (peer, ids)
                    return types.Message(
                        id=ids,
                        peer_id=types.PeerChat(2),
                        date=datetime.now(UTC),
                        message="caption",
                        media=types.MessageMediaPhoto(
                            photo=types.Photo(
                                id=1,
                                access_hash=2,
                                file_reference=b"x",
                                date=datetime.now(UTC),
                                dc_id=1,
                                sizes=[
                                    types.PhotoSize(type="m", w=320, h=240, size=20),
                                    types.PhotoSize(type="x", w=1280, h=960, size=200),
                                ],
                            )
                        ),
                    )

                async def download_media(self, message, file, thumb, progress_callback):
                    downloaded.append(thumb)
                    progress_callback(10, 10)
                    return b"synthetic-image"

            async def run():
                client = Client()
                images = TelegramImages(cache, client, asyncio.get_running_loop())
                self.assertEqual(
                    await images.resolve(sid, "9"),
                    {"images": [{"index": 0}], "caption": "caption"},
                )
                self.assertEqual(downloaded, [])
                self.assertEqual(
                    await images.resolve(sid, "9", "preview"), b"synthetic-image"
                )
                self.assertEqual(downloaded[-1].w, 320)
                await images.resolve(sid, "9", "original")
                self.assertIsNone(downloaded[-1])
                self.assertEqual(client.last_request, (-2, 9))
                with self.assertRaises(KeyError):
                    await images.resolve("telegram:other:-2", "9")

            asyncio.run(run())

    def test_worker_starts_offline_and_shares_one_client(self):
        class Client:
            async def disconnect(self):
                self.disconnected = True

        client = Client()
        worker = TelegramWorker(lambda: client, None)
        try:

            async def same_loop():
                return (
                    asyncio.get_running_loop() is worker.loop
                    and worker.images.client is client
                )

            self.assertTrue(worker.run(same_loop()))
        finally:
            worker.close()
        self.assertTrue(client.disconnected)


if __name__ == "__main__":
    unittest.main()
