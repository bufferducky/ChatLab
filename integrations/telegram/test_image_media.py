"""Prevent eager media downloads and preserve access to existing archived messages."""

import asyncio
import tempfile
import unittest
from datetime import UTC, datetime

from bridge import Cache
from image_media import TelegramImages, TelegramWorker
from telethon import types


class ImageTests(unittest.TestCase):
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
