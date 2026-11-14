"""Protect reading responsiveness, shared downloads, and real server cooldowns."""

import asyncio
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from bridge import Cache, make_client
from media_scheduler import MediaRateLimited, MediaScheduler, media_job
from telethon import TelegramClient, errors, functions


async def turns():
    for _ in range(8):
        await asyncio.sleep(0)


class SchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def test_foreground_runs_before_the_next_background_chunk(self):
        scheduler = MediaScheduler(None)
        first = asyncio.Event()
        release = asyncio.Event()
        order = []

        async def background():
            async with scheduler.rpc():
                order.append("background-first")
                first.set()
                await release.wait()
            async with scheduler.rpc():
                order.append("background-second")

        async def foreground():
            async with scheduler.rpc():
                order.append("visible-preview")

        bg = asyncio.create_task(scheduler.run("bg", 3, background))
        await first.wait()
        fg = asyncio.create_task(scheduler.run("fg", 1, foreground))
        await turns()
        release.set()
        await asyncio.gather(bg, fg)
        self.assertEqual(
            order, ["background-first", "visible-preview", "background-second"]
        )

    async def test_click_promotes_the_same_original_and_one_cancel_keeps_other_reader(
        self,
    ):
        scheduler = MediaScheduler(None)
        scheduler.background_paused = True
        started = asyncio.Event()
        finish = asyncio.Event()
        calls = 0

        async def download():
            nonlocal calls
            async with scheduler.rpc():
                calls += 1
                started.set()
                await finish.wait()
                return b"original"

        bg = asyncio.create_task(scheduler.run("same-image", 3, download))
        await turns()
        clicked = asyncio.create_task(scheduler.run("same-image", 0, download))
        await asyncio.wait_for(started.wait(), 1)
        other_reader = asyncio.create_task(scheduler.run("same-image", 0, download))
        await turns()
        clicked.cancel()
        await asyncio.gather(clicked, return_exceptions=True)
        finish.set()
        self.assertEqual(await other_reader, b"original")
        self.assertEqual(await bg, b"original")
        self.assertEqual(calls, 1)
        self.assertEqual(scheduler.promotions, 1)

    async def test_last_reader_cancels_a_download_and_releases_capacity(self):
        scheduler = MediaScheduler(None)
        started = asyncio.Event()
        stopped = asyncio.Event()

        async def download():
            try:
                async with scheduler.rpc():
                    started.set()
                    await asyncio.Event().wait()
            finally:
                stopped.set()

        reader = asyncio.create_task(scheduler.run("abandoned", 1, download))
        await started.wait()
        reader.cancel()
        await asyncio.gather(reader, return_exceptions=True)
        self.assertTrue(stopped.is_set())
        self.assertFalse(scheduler.active)
        self.assertFalse(scheduler.jobs)

    async def test_runtime_caps_bound_all_rpc_senders_and_background_requests(self):
        scheduler = MediaScheduler(None)
        scheduler.configure(5, 2)
        release = asyncio.Event()
        active = []
        peak = background_peak = 0

        async def download():
            nonlocal peak, background_peak
            media_job.get().large = False
            async with scheduler.rpc():
                active.append(media_job.get())
                peak = max(peak, len(active))
                background_peak = max(
                    background_peak, sum(j.priority >= 2 for j in active)
                )
                await release.wait()
                active.remove(media_job.get())

        tasks = [
            asyncio.create_task(scheduler.run(i, 3 if i < 3 else 1, download))
            for i in range(8)
        ]
        await turns()
        self.assertEqual(peak, 2)
        release.set()
        await asyncio.gather(*tasks)
        self.assertEqual(background_peak, 1)

    async def test_media_ignores_history_interval_and_both_flood_types_persist(self):
        for error_type in (errors.FloodWaitError, errors.FloodPremiumWaitError):
            with (
                self.subTest(error=error_type),
                tempfile.TemporaryDirectory() as directory,
            ):
                client = make_client(directory, {"apiId": 1, "apiHash": "test"})
                request = functions.upload.GetCdnFileRequest(
                    file_token=b"test", offset=0, limit=4096
                )
                with patch.object(
                    TelegramClient, "_call", new_callable=AsyncMock
                ) as rpc:
                    rpc.return_value = b"chunk"
                    with patch("bridge.asyncio.sleep", new_callable=AsyncMock) as sleep:
                        await client._call(None, request)
                        await client._call(None, request)
                    sleep.assert_not_awaited()
                    rpc.side_effect = error_type(request=request, capture=12)
                    with self.assertRaises(MediaRateLimited) as result:
                        await client._call(None, request)
                    self.assertEqual(result.exception.retry_after, 12)
                    restarted = MediaScheduler(Cache(directory))
                    with self.assertRaises(MediaRateLimited):
                        restarted.check_cooldown()
                    calls = rpc.await_count
                    with self.assertRaises(MediaRateLimited):
                        await client._call(None, request)
                    self.assertEqual(rpc.await_count, calls)

    async def test_cdn_client_reuses_the_account_scheduler(self):
        with tempfile.TemporaryDirectory() as directory:
            client = make_client(directory, {"apiId": 1, "apiHash": "test"})
            cdn = SimpleNamespace(flood_sleep_threshold=60)
            with patch.object(
                TelegramClient, "_get_cdn_client", AsyncMock(return_value=cdn)
            ):
                result = await client._get_cdn_client(None)
            self.assertIs(result.media_scheduler, client.media_scheduler)
            self.assertEqual(result.flood_sleep_threshold, 0)
