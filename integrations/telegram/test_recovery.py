"""A broken transport must not freeze collection or prevent later rounds."""

import asyncio
import tempfile
import unittest
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from bridge import (
    Cache,
    CollectionController,
    collect_with_retries,
    collection_progress,
    make_client,
    next_collection_delay,
    refresh,
)
from telethon import TelegramClient, functions, types


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_reconnect_callback_burst_cannot_starve_history_collection(self):
        with tempfile.TemporaryDirectory() as root:
            client = make_client(
                root, {"apiId": 1, "apiHash": "test", "requestWaitSeconds": 0.02}
            )
            probes, completed = [], []

            async def rpc(_sender, request, **_kwargs):
                completed.append(type(request).__name__)
                return [types.User(id=1, is_self=True)]

            # Use the exact hook that MTProtoSender schedules on every reconnect.
            with patch.object(TelegramClient, "_call", side_effect=rpc):
                probes = [
                    asyncio.create_task(client._sender._auto_reconnect_callback())
                    for _ in range(30)
                ]
                history = asyncio.create_task(
                    client._call(client._sender, functions.help.GetConfigRequest())
                )
                try:
                    await asyncio.wait({history}, timeout=0.1)
                    self.assertTrue(
                        history.done(), "Reconnect callbacks starved the history lane"
                    )
                    self.assertIsNone(history.exception())
                    await asyncio.wait_for(asyncio.gather(*probes), 0.1)
                finally:
                    for task in [history, *probes]:
                        task.cancel()
                    await asyncio.gather(history, *probes, return_exceptions=True)
                    client.session.close()

    async def test_history_timeout_also_bounds_waiting_for_the_request_gate(self):
        with tempfile.TemporaryDirectory() as root:
            client = make_client(root, {"apiId": 1, "apiHash": "test"})
            await client._request_gate.acquire()
            with patch("bridge.REQUEST_TIMEOUT_SECONDS", 0.02):
                task = asyncio.create_task(
                    client._call(client._sender, functions.help.GetConfigRequest())
                )
                try:
                    await asyncio.wait({task}, timeout=0.1)
                    self.assertTrue(task.done(), "The request gate has no deadline")
                    self.assertIsInstance(task.exception(), TimeoutError)
                    # A waiter timing out must not release another task's lock.
                    self.assertTrue(client._request_gate.locked())
                finally:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                    client._request_gate.release()
                    client.session.close()

    async def test_failed_reconnect_cannot_orphan_a_queued_history_request(self):
        with tempfile.TemporaryDirectory() as root:
            config = {
                "apiId": 1,
                "apiHash": "test",
                "allDialogs": True,
                "requestWaitSeconds": 0,
            }
            cache = Cache(root)
            client = make_client(root, config)
            sender = client._sender
            sender._user_connected = True
            sender._connection = SimpleNamespace(disconnect=AsyncMock())
            sender._delay = 0
            entered, release = asyncio.Event(), asyncio.Event()

            async def fail_connect():
                entered.set()
                await release.wait()
                raise OSError("Synthetic unavailable transport")

            sender._connect = fail_connect
            sender._start_reconnect(ConnectionResetError())
            await entered.wait()
            client.connect = AsyncMock()
            client.get_me = AsyncMock(return_value=SimpleNamespace(id=1))

            async def dialogs():
                yield SimpleNamespace(
                    id=-1,
                    name="Test",
                    is_user=False,
                    entity=types.InputPeerChat(1),
                    message=SimpleNamespace(id=1),
                )

            client.iter_dialogs = dialogs
            with patch("bridge.REQUEST_TIMEOUT_SECONDS", 0.02, create=True):
                task = asyncio.create_task(refresh(root, config, cache, client))
                try:
                    for _ in range(100):
                        if sender._send_queue._deque:
                            break
                        await asyncio.sleep(0)
                    state = sender._send_queue._deque[0]
                    self.assertEqual(
                        type(state.request.query).__name__, "GetHistoryRequest"
                    )
                    release.set()
                    await sender._reconnect_task
                    await asyncio.wait({task}, timeout=0.2)
                    self.assertTrue(
                        task.done(), "The history request still blocks collection"
                    )
                    self.assertIsInstance(task.exception(), TimeoutError)
                    self.assertTrue(state.future.cancelled())
                    self.assertEqual(cache.cursor("telegram:1:-1"), 0)
                finally:
                    release.set()
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                    client.session.close()

    async def test_retry_resumes_committed_messages_and_continues_later_chats(self):
        with tempfile.TemporaryDirectory() as root:
            config = {
                "apiId": 1,
                "apiHash": "test",
                "allDialogs": True,
                "historySince": 1,
                "requestWaitSeconds": 0,
            }
            cache = Cache(root)
            client = make_client(root, config)
            client.connect = AsyncMock()
            client.reconnect = AsyncMock()
            client.get_me = AsyncMock(return_value=SimpleNamespace(id=1))
            cursors, abandoned, updates = [], [], []

            async def dialogs():
                for peer in (-1, -2):
                    yield SimpleNamespace(
                        id=peer,
                        name="Test",
                        is_user=False,
                        entity=peer,
                        message=SimpleNamespace(id=2),
                    )

            async def messages(peer, **options):
                cursors.append((peer, options["min_id"]))
                for mid in range(options["min_id"] + 1, 3):
                    await client._call(None, (peer, mid))
                    yield types.Message(
                        id=mid,
                        peer_id=types.PeerChat(-peer),
                        date=datetime.now(UTC),
                        message="synthetic",
                    )

            async def rpc(_sender, request):
                if request == (-1, 2) and not abandoned:
                    future = asyncio.get_running_loop().create_future()
                    abandoned.append(future)
                    await future

            client.iter_dialogs, client.iter_messages = dialogs, messages
            try:
                with (
                    patch("bridge.REQUEST_TIMEOUT_SECONDS", 0.02),
                    patch("bridge.BATCH_SIZE", 1),
                    patch("bridge.asyncio.sleep", new_callable=AsyncMock),
                    patch.object(TelegramClient, "_call", side_effect=rpc),
                ):
                    result = await collect_with_retries(
                        root,
                        config,
                        cache,
                        client,
                        notify=lambda **update: updates.append(update),
                    )
                self.assertTrue(abandoned[0].cancelled())
                self.assertEqual(cursors, [(-1, 0), (-1, 1), (-2, 0)])
                self.assertEqual(result["changedMessages"], 4)
                self.assertEqual(cache.status()["messages"], 4)
                self.assertEqual(cache.cursor("telegram:1:-1"), 2)
                self.assertEqual(cache.cursor("telegram:1:-2"), 2)
                self.assertEqual(updates[-1]["attempt"], 1)
            finally:
                client.session.close()

    async def test_failed_round_is_released_and_a_later_round_can_succeed(self):
        with tempfile.TemporaryDirectory() as root:
            cache = Cache(root)
            client = SimpleNamespace(reconnect=AsyncMock())
            loop = asyncio.get_running_loop()
            attempts = []

            async def collect_attempt(*_args):
                future = loop.create_future()
                attempts.append(future)
                await future

            def collect():
                try:
                    return asyncio.run_coroutine_threadsafe(
                        collect_with_retries(root, {}, cache, client), loop
                    ).result(2)
                except Exception as error:
                    cache.fail(error)
                    raise

            controller = CollectionController(collect)
            with (
                patch("bridge.NO_PROGRESS_TIMEOUT_SECONDS", 0.02),
                patch("bridge.refresh", side_effect=collect_attempt),
                patch("bridge.asyncio.sleep", new_callable=AsyncMock),
            ):
                await asyncio.to_thread(controller._run)
            self.assertEqual(controller.snapshot()["state"], "failed")
            self.assertEqual(len(attempts), 3)
            self.assertTrue(all(future.cancelled() for future in attempts))
            self.assertEqual(cache.status()["error"], "TimeoutError")
            status = cache.status()
            self.assertLessEqual(
                next_collection_delay(status, controller.snapshot(), 1800), 60
            )

            async def success(*_args):
                cache.finish()
                return {"changedMessages": 0}

            with patch("bridge.refresh", side_effect=success):
                await asyncio.to_thread(controller._run)
            self.assertEqual(controller.snapshot()["state"], "done")
            self.assertEqual(cache.status()["error"], "")

    async def test_normal_progress_and_planned_waits_do_not_expire_collection(self):
        with tempfile.TemporaryDirectory() as root:
            cache = Cache(root)

            async def progressing(*_args):
                for _ in range(6):
                    collection_progress("history")
                    await asyncio.sleep(0.01)
                return {"changedMessages": 0}

            async def cooling_down(*_args):
                collection_progress("waiting", wait_seconds=0.1)
                await asyncio.sleep(0.06)
                return {"changedMessages": 0}

            for operation in (progressing, cooling_down):
                with (
                    patch("bridge.NO_PROGRESS_TIMEOUT_SECONDS", 0.03),
                    patch("bridge.refresh", side_effect=operation),
                ):
                    result = await collect_with_retries(root, {}, cache, None)
                self.assertEqual(result["changedMessages"], 0)

    async def test_connection_timeout_releases_the_gate_and_cancels_unsent_work(self):
        with tempfile.TemporaryDirectory() as root:
            client = make_client(root, {"apiId": 1, "apiHash": "test"})
            client._disconnect_coro = AsyncMock()
            try:
                for operation in (client.connect, client.reconnect):
                    stalled = asyncio.get_running_loop().create_future()

                    async def connect(_self, pending=stalled):
                        await pending

                    with (
                        patch("bridge.CONNECT_TIMEOUT_SECONDS", 0.02),
                        patch.object(TelegramClient, "connect", connect),
                        self.assertRaises(TimeoutError),
                    ):
                        await operation()
                    self.assertTrue(stalled.cancelled())
                    self.assertFalse(client._connection_gate.locked())
                client._sender._user_connected = True
                future = client._sender.send(functions.help.GetConfigRequest())
                with patch.object(TelegramClient, "connect", new_callable=AsyncMock):
                    await client.reconnect()
                self.assertTrue(future.cancelled())
                self.assertFalse(client._sender._send_queue._deque)
            finally:
                client.session.close()

    async def test_media_configuration_cannot_block_collection_connection(self):
        with tempfile.TemporaryDirectory() as root:
            client = make_client(
                root, {"apiId": 1, "apiHash": "test", "requestWaitSeconds": 0}
            )
            client._sender._user_connected = True
            entered = asyncio.Event()
            pending = asyncio.get_running_loop().create_future()

            async def rpc(*_args, **_kwargs):
                entered.set()
                return await pending

            with patch.object(TelegramClient, "_call", side_effect=rpc):
                task = asyncio.create_task(client.ensure_media_connection())
                try:
                    await asyncio.wait_for(entered.wait(), 1)
                    await asyncio.wait_for(client.connect(), 0.1)
                finally:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                    client.session.close()

    async def test_sdk_child_callbacks_cannot_hide_a_stalled_collection(self):
        with tempfile.TemporaryDirectory() as root:
            cache = Cache(root)
            pending = asyncio.get_running_loop().create_future()

            async def stuck(*_args):
                async def callback():
                    while True:
                        collection_progress("received")
                        await asyncio.sleep(0.005)

                child = asyncio.create_task(callback())
                try:
                    await pending
                finally:
                    child.cancel()
                    await asyncio.gather(child, return_exceptions=True)

            with (
                patch("bridge.NO_PROGRESS_TIMEOUT_SECONDS", 0.03),
                patch("bridge.MAX_COLLECTION_RETRIES", 0),
                patch("bridge.refresh", side_effect=stuck),
                self.assertRaises(TimeoutError),
            ):
                await collect_with_retries(root, {}, cache, None)
            self.assertTrue(pending.cancelled())

    def test_failure_retry_cannot_bypass_a_persisted_telegram_cooldown(self):
        status = {
            "lastRefresh": 100,
            "lastAttempt": 200,
            "retryAfter": 900,
            "error": "TimeoutError",
        }
        current = {"state": "failed", "finishedAt": 200}
        self.assertEqual(next_collection_delay(status, current, 1800, now=210), 690)


if __name__ == "__main__":
    unittest.main()
