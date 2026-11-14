"""Prevent lost history on restart, duplicate imports, and unprotected reads."""

import asyncio
import json
import tempfile
import threading
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from bridge import Cache, convert_message, make_client, make_server, refresh
from telethon import TelegramClient, errors, functions, types


def payload(mid, stamp=100):
    return {
        "platformMessageId": str(mid),
        "sender": "42",
        "accountName": "Alice",
        "timestamp": stamp,
        "type": 0,
        "content": "same text\nsecond line",
    }


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.cache = Cache(Path(self.temp.name) / "cache")
        self.cache.bind_account(1)
        self.sid = self.cache.session(1, -1002, "Test", "group")

    def tearDown(self):
        self.temp.cleanup()

    def test_replay_restart_and_cross_peer_ids(self):
        big = 9007199254740993
        self.assertEqual(
            self.cache.ingest(self.sid, [payload(big), payload(big + 1)], now=1000), 2
        )
        restarted = Cache(self.cache.root)
        self.assertEqual(restarted.cursor(self.sid), big + 1)
        self.assertEqual(
            restarted.ingest(self.sid, [payload(big), payload(big + 1)], now=1001), 0
        )
        other = restarted.session(1, -1003, "Other", "group")
        self.assertEqual(restarted.ingest(other, [payload(big)]), 1)
        with self.assertRaises(ValueError):
            restarted.bind_account(2)
        self.assertEqual(restarted.status()["messages"], 3)

    def test_failed_batch_does_not_advance_checkpoint(self):
        self.cache.ingest(self.sid, [payload(1)])
        with self.assertRaises(ValueError):
            self.cache.ingest(self.sid, [payload(2), payload("invalid")])
        self.assertEqual(self.cache.cursor(self.sid), 1)
        self.assertEqual(self.cache.status()["messages"], 1)

    def test_media_schema_upgrade_keeps_messages_and_failed_batch_cannot_orphan_media(
        self,
    ):
        self.cache.ingest(self.sid, [payload(1)])
        # A pre-prefetch archive has messages and checkpoints but no media table.
        with self.cache.connect() as db:
            db.execute("DROP TABLE image_metadata")
        upgraded = Cache(self.cache.root)
        self.assertEqual(upgraded.cursor(self.sid), 1)
        self.assertEqual(upgraded.status()["messages"], 1)
        with self.assertRaises(ValueError):
            upgraded.ingest(
                self.sid,
                [payload(2), payload("invalid")],
                images=[("2", b"synthetic-reference", "caption")],
            )
        with upgraded.connect() as db:
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM image_metadata").fetchone()[0], 0
            )
        self.assertEqual(upgraded.cursor(self.sid), 1)
        self.assertEqual(upgraded.status()["messages"], 1)

    def test_week_boundary_migration_keeps_existing_messages_and_checkpoint(self):
        self.cache.ingest(self.sid, [payload(42)])
        with self.cache.connect() as db:
            db.execute("ALTER TABLE sessions DROP COLUMN history_since")
        restarted = Cache(self.cache.root)
        restarted.session(1, -1002, "Test", "group", history_since=100)
        self.assertEqual(restarted.cursor(self.sid), 42)
        self.assertEqual(restarted.status()["messages"], 1)
        self.assertEqual(restarted.history_since(self.sid), 100)

    def test_scan_and_original_queue_upgrade_preserves_saved_messages_and_previews(
        self,
    ):
        self.cache.ingest(self.sid, [payload(5)], images=[("5", b"media", "caption")])
        self.cache.finish_session(self.sid)
        with self.cache.connect() as db:
            db.execute("UPDATE image_metadata SET preview_done=1")
            db.execute("ALTER TABLE sessions DROP COLUMN last_scanned_id")
            for column in ("original_done", "original_next_retry", "original_error"):
                db.execute(f"ALTER TABLE image_metadata DROP COLUMN {column}")
        upgraded = Cache(self.cache.root)
        self.assertEqual(upgraded.messages(self.sid)["messages"], [payload(5)])
        self.assertTrue(upgraded.is_current(self.sid, 5))
        with upgraded.connect() as db:
            row = db.execute("SELECT * FROM image_metadata").fetchone()
        self.assertEqual(
            (row["preview_done"], row["media"], row["caption"]),
            (1, b"media", "caption"),
        )
        self.assertEqual(
            (row["original_done"], row["original_next_retry"], row["original_error"]),
            (0, 0, ""),
        )

    def test_keyset_paging_and_late_history_use_committed_observations(self):
        self.cache.ingest(self.sid, [payload(5), payload(6), payload(7)], now=1000)
        first = self.cache.messages(self.sid, limit=1)
        self.assertTrue(first["sync"]["hasMore"])
        self.cache.ingest(self.sid, [payload(2, stamp=1)], now=1000)
        page = self.cache.messages(
            self.sid, offset=first["sync"]["nextOffset"], limit=5
        )
        self.assertEqual(
            [m["platformMessageId"] for m in page["messages"]], ["6", "7", "2"]
        )
        self.assertEqual(page["sync"]["nextSince"], 1001)
        with patch("bridge.time.time", return_value=9000):
            self.assertEqual(self.cache.messages(self.sid)["sync"]["nextSince"], 1001)
        self.assertEqual(
            self.cache.messages(self.sid, since=1001)["messages"], [payload(2, stamp=1)]
        )

    def test_http_auth_paging_and_invalid_cursor(self):
        self.cache.ingest(self.sid, [payload(1), payload(2)])
        self.cache.finish()
        server = make_server(self.cache, {"token": "test-token", "port": 0})
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"

        def get(path):
            with urlopen(
                Request(base + path, headers={"Authorization": "Bearer test-token"})
            ) as response:
                return json.load(response)

        try:
            with self.assertRaises(HTTPError) as caught:
                urlopen(base + "/api/v1/sessions")
            self.assertEqual(caught.exception.code, 401)
            self.assertEqual(get("/api/v1/sessions")["sessions"][0]["messageCount"], 2)
            prefix = f"/api/v1/sessions/{self.sid}/messages?limit=1"
            first = get(prefix)
            second = get(prefix + "&offset=" + str(first["sync"]["nextOffset"]))
            self.assertEqual(
                [
                    first["messages"][0]["platformMessageId"],
                    second["messages"][0]["platformMessageId"],
                ],
                ["1", "2"],
            )
            with self.assertRaises(HTTPError) as caught:
                get(prefix + "&offset=-1")
            self.assertEqual(caught.exception.code, 400)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


class ConversionTests(unittest.TestCase):
    def test_text_reply_service_and_channel_sender(self):
        stamp = datetime(2025, 1, 1, tzinfo=UTC)
        message = types.Message(
            id=8,
            peer_id=types.PeerChat(2),
            from_id=types.PeerUser(42),
            date=stamp,
            message="line1\nline2",
            reply_to=types.MessageReplyHeader(reply_to_msg_id=7),
        )
        value = convert_message(message, "Alice")
        self.assertEqual(
            (value["sender"], value["content"], value["replyToMessageId"]),
            ("42", "line1\nline2", "7"),
        )
        service = types.MessageService(
            id=9,
            peer_id=types.PeerChat(2),
            from_id=types.PeerUser(42),
            date=stamp,
            action=types.MessageActionChatCreate(title="Test", users=[42]),
        )
        self.assertEqual(convert_message(service)["type"], 80)
        post = types.Message(
            id=1, peer_id=types.PeerChannel(3), date=stamp, message="post", post=True
        )
        self.assertEqual(convert_message(post)["sender"], "-1000000000003")
        message.reply_to = types.MessageReplyHeader(
            reply_to_msg_id=7, reply_to_peer_id=types.PeerChannel(3)
        )
        self.assertNotIn("replyToMessageId", convert_message(message))

    def test_media_labels_preserve_captions(self):
        stamp = datetime(2025, 1, 1, tzinfo=UTC)
        photo = types.Message(
            id=1,
            peer_id=types.PeerChat(2),
            from_id=types.PeerUser(42),
            date=stamp,
            message="caption",
            media=types.MessageMediaPhoto(photo=types.PhotoEmpty(id=1)),
        )
        value = convert_message(photo)
        self.assertEqual((value["type"], value["content"]), (1, "[photo] caption"))


class RequestControlTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_telethon_rpc_retries_after_the_server_wait(self):
        with tempfile.TemporaryDirectory() as directory:
            client = make_client(directory, {"apiId": 1, "apiHash": "test"})
            clock = SimpleNamespace(now=1000.0)
            request = functions.help.GetConfigRequest()
            response = types.User(id=42)
            sent_at = []

            async def sleep(seconds):
                clock.now += seconds

            def send(request, **kwargs):
                sent_at.append(clock.now)
                result = asyncio.get_running_loop().create_future()
                if len(sent_at) == 1:
                    result.set_exception(errors.FloodWaitError(request, capture=6))
                else:
                    result.set_result(response)
                return result

            virtual_time = SimpleNamespace(
                time=lambda: clock.now, monotonic=lambda: clock.now
            )
            with (
                patch("bridge.time", virtual_time),
                patch("telethon.client.users.time", virtual_time),
                patch("bridge.asyncio.sleep", side_effect=sleep),
            ):
                result = await client._call(SimpleNamespace(send=send), request)
            self.assertIs(result, response)
            self.assertEqual(sent_at, [1000, 1006])

    async def test_requests_across_chats_share_the_configured_interval(self):
        with tempfile.TemporaryDirectory() as directory:
            client = make_client(directory, {"apiId": 1, "apiHash": "test"})
            clock = SimpleNamespace(now=0.0)
            starts = []

            async def sleep(seconds):
                clock.now += seconds

            async def call(*args, **kwargs):
                starts.append(clock.now)
                return "ok"

            with (
                patch(
                    "bridge.time",
                    SimpleNamespace(
                        monotonic=lambda: clock.now, time=lambda: clock.now
                    ),
                ),
                patch("bridge.asyncio.sleep", side_effect=sleep),
                patch.object(TelegramClient, "_call", side_effect=call),
            ):
                await asyncio.gather(
                    client._call(None, "chat-one"),
                    client._call(None, "chat-two"),
                    client._call(None, "next-page"),
                )
            self.assertEqual(starts, [0, 3, 6])

    async def test_flood_wait_continues_the_current_batch_and_later_chats(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Cache(directory)
            config = {"apiId": 1, "apiHash": "test", "allDialogs": True}
            client = make_client(directory, config)
            clock = SimpleNamespace(now=0.0)
            attempts = []
            waits = []
            stamp = datetime(2025, 1, 1, tzinfo=UTC)

            async def sleep(seconds):
                waits.append(seconds)
                clock.now += seconds

            async def call(sender, request, **kwargs):
                attempts.append((request, clock.now))
                if len(attempts) == 2:
                    raise errors.FloodWaitError(request=None, capture=6)

            async def dialogs():
                for peer in (1, 2):
                    yield SimpleNamespace(
                        id=peer, name=str(peer), is_user=True, entity=peer
                    )

            async def messages(peer, **kwargs):
                for mid in (1, 2):
                    await client._call(None, (peer, mid))
                    yield types.Message(
                        id=mid,
                        peer_id=types.PeerUser(peer),
                        from_id=types.PeerUser(peer),
                        date=stamp,
                        message="synthetic",
                    )

            client.connect = AsyncMock()
            client.is_user_authorized = AsyncMock(return_value=True)
            client.get_me = AsyncMock(return_value=SimpleNamespace(id=42))
            client.iter_dialogs = dialogs
            client.iter_messages = messages
            with (
                patch(
                    "bridge.time",
                    SimpleNamespace(
                        monotonic=lambda: clock.now,
                        time=lambda: stamp.timestamp() + clock.now,
                    ),
                ),
                patch("bridge.asyncio.sleep", side_effect=sleep),
                patch.object(TelegramClient, "_call", side_effect=call),
            ):
                result = await refresh(directory, config, cache, client)
            self.assertEqual(result["changedMessages"], 4)
            self.assertEqual(result["historyComplete"], 2)
            self.assertEqual(result["error"], "")
            self.assertEqual(cache.status()["retryAfter"], 0)
            self.assertEqual(attempts[1][0], attempts[2][0])
            self.assertGreaterEqual(attempts[2][1] - attempts[1][1], 6)
            self.assertIn(6, waits)
            for peer in (1, 2):
                sid = f"telegram:42:{peer}"
                self.assertEqual(cache.cursor(sid), 2)
                self.assertEqual(
                    [m["platformMessageId"] for m in cache.messages(sid)["messages"]],
                    ["1", "2"],
                )

    async def test_nested_entity_lookup_can_complete_without_locking_itself(self):
        with tempfile.TemporaryDirectory() as directory:
            client = make_client(directory, {"apiId": 1, "apiHash": "test"})
            clock = SimpleNamespace(now=0.0)

            async def sleep(seconds):
                clock.now += seconds

            async def call(sender, request):
                if request == "history":
                    return await client._call(sender, "resolve-peer")
                return request

            with (
                patch(
                    "bridge.time",
                    SimpleNamespace(
                        monotonic=lambda: clock.now, time=lambda: clock.now
                    ),
                ),
                patch("bridge.asyncio.sleep", side_effect=sleep),
                patch.object(TelegramClient, "_call", side_effect=call),
            ):
                result = await asyncio.wait_for(client._call(None, "history"), 1)
            self.assertEqual(result, "resolve-peer")
            self.assertEqual(clock.now, 3)

    async def test_stopping_during_flood_wait_preserves_the_retry_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            client = make_client(directory, {"apiId": 1, "apiHash": "test"})

            async def stop(seconds):
                raise asyncio.CancelledError()

            with (
                patch("bridge.asyncio.sleep", side_effect=stop),
                patch.object(
                    TelegramClient,
                    "_call",
                    side_effect=errors.FloodWaitError(request=None, capture=600),
                ),
                self.assertRaises(asyncio.CancelledError),
            ):
                await client._call(None, "history")
            state = Cache(directory).status()
            self.assertEqual(state["error"], "")
            self.assertGreaterEqual(
                state["retryAfter"], int(datetime.now(UTC).timestamp()) + 598
            )
            clock = SimpleNamespace(now=datetime.now(UTC).timestamp())
            resumed_at = clock.now

            async def sleep(seconds):
                clock.now += seconds

            with (
                patch(
                    "bridge.time",
                    SimpleNamespace(
                        time=lambda: clock.now, monotonic=lambda: clock.now
                    ),
                ),
                patch("bridge.asyncio.sleep", side_effect=sleep),
                patch.object(TelegramClient, "_call", return_value="resumed"),
            ):
                restarted = make_client(directory, {"apiId": 1, "apiHash": "test"})
                self.assertEqual(await restarted._call(None, "history"), "resumed")
            self.assertGreaterEqual(clock.now - resumed_at, 598)


class CollectionTests(unittest.TestCase):
    def test_empty_chat_scan_watermark_survives_restart_and_new_messages_still_arrive(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            cache = Cache(directory)
            heads = {1: 5}
            queried = []

            class Client:
                connect = AsyncMock()
                get_me = AsyncMock(return_value=SimpleNamespace(id=42))

                async def iter_dialogs(self):
                    yield SimpleNamespace(
                        id=1,
                        name="Empty",
                        is_user=True,
                        entity=1,
                        message=SimpleNamespace(id=heads[1]),
                    )

                async def iter_messages(self, peer, **kwargs):
                    queried.append(kwargs["min_id"])
                    if heads[1] > 5:
                        yield types.Message(
                            id=6,
                            peer_id=types.PeerUser(1),
                            date=datetime.fromtimestamp(200, UTC),
                            message="new",
                        )

            client = Client()
            config = {"selectedPeers": [1], "historySince": 100}
            asyncio.run(refresh(directory, config, cache, client))
            self.assertEqual(cache.cursor("telegram:42:1"), 0)
            restarted = Cache(directory)
            asyncio.run(refresh(directory, config, restarted, client))
            self.assertEqual(queried, [0])
            heads[1] = 6
            result = asyncio.run(refresh(directory, config, restarted, client))
            self.assertEqual(queried, [0, 5])
            self.assertEqual(result["changedMessages"], 1)
            self.assertEqual(restarted.cursor("telegram:42:1"), 6)

    def test_snapshot_head_stops_before_an_extra_page_and_defers_later_arrivals(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Cache(directory)
            head = 2
            visited = []

            class Client:
                connect = AsyncMock()
                get_me = AsyncMock(return_value=SimpleNamespace(id=42))

                async def iter_dialogs(self):
                    yield SimpleNamespace(
                        id=1,
                        name="Active",
                        is_user=True,
                        entity=1,
                        message=SimpleNamespace(id=head),
                    )

                async def iter_messages(self, peer, **kwargs):
                    for mid in range(kwargs["min_id"] + 1, 4):
                        visited.append(mid)
                        yield types.Message(
                            id=mid,
                            peer_id=types.PeerUser(1),
                            date=datetime.fromtimestamp(200, UTC),
                            message="new",
                        )
                    raise AssertionError("An unnecessary end-of-history request")

            client = Client()
            config = {"selectedPeers": [1], "historySince": 100}
            first = asyncio.run(refresh(directory, config, cache, client))
            self.assertEqual((visited, first["changedMessages"]), ([1, 2], 2))
            head = 3
            second = asyncio.run(refresh(directory, config, cache, client))
            self.assertEqual(second["changedMessages"], 1)
            self.assertEqual(cache.cursor("telegram:42:1"), 3)

    def test_confirmed_empty_remote_dialog_skips_queries_but_unknown_head_does_not(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            cache = Cache(directory)
            for peer in (1, 2):
                sid = cache.session(42, peer, "Empty", "private", 100)
                cache.finish_session(sid)
            queried = []

            class Client:
                connect = AsyncMock()
                get_me = AsyncMock(return_value=SimpleNamespace(id=42))

                async def iter_dialogs(self):
                    for peer in (1, 2):
                        yield SimpleNamespace(
                            id=peer,
                            name="Empty",
                            is_user=True,
                            entity=peer,
                            message=None,
                            dialog=SimpleNamespace(top_message=0)
                            if peer == 1
                            else None,
                        )

                async def iter_messages(self, peer, **kwargs):
                    queried.append(peer)
                    return
                    yield

            asyncio.run(refresh(directory, {"selectedPeers": [1, 2]}, cache, Client()))
            self.assertEqual(queried, [2])

    def test_missing_current_account_stops_collection_without_changing_saved_messages(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            cache = Cache(directory)
            sid = cache.session(42, 1, "Saved", "private")
            cache.ingest(sid, [payload(5)])
            client = SimpleNamespace(
                connect=AsyncMock(),
                is_user_authorized=AsyncMock(return_value=True),
                get_me=AsyncMock(return_value=None),
            )
            with self.assertRaisesRegex(RuntimeError, "^LoginRequired$"):
                asyncio.run(refresh(directory, {"selectedPeers": [1]}, cache, client))
            self.assertEqual(cache.cursor(sid), 5)
            self.assertEqual(cache.messages(sid)["messages"], [payload(5)])

    def test_unchanged_dialogs_skip_history_and_later_new_messages_are_collected(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Cache(directory)
            # Include interrupted history, a missing head, a new chat and a deleted head.
            heads = {1: 5, 2: 6, 3: 5, 4: None, 5: 1, 6: 4}
            for peer in (1, 2, 3, 4, 6):
                sid = cache.session(42, peer, str(peer), "private", 100)
                cache.ingest(sid, [payload(5)])
                if peer != 3:
                    cache.finish_session(sid)

            class Client:
                def __init__(self):
                    self.queried = []

                async def connect(self):
                    pass

                async def is_user_authorized(self):
                    return True

                async def get_me(self):
                    return SimpleNamespace(id=42)

                async def iter_dialogs(self):
                    for peer, head in heads.items():
                        yield SimpleNamespace(
                            id=peer,
                            name=f"renamed-{peer}",
                            is_user=True,
                            entity=peer,
                            message=SimpleNamespace(id=head) if head else None,
                        )

                async def iter_messages(self, peer, **kwargs):
                    self.queried.append(peer)
                    for mid in range(kwargs["min_id"] + 1, (heads[peer] or 5) + 1):
                        yield types.Message(
                            id=mid,
                            peer_id=types.PeerUser(peer),
                            from_id=types.PeerUser(peer),
                            date=datetime.fromtimestamp(100, UTC),
                            message="synthetic",
                        )

            client = Client()
            config = {"selectedPeers": list(heads), "historySince": 100}
            result = asyncio.run(refresh(directory, config, cache, client))
            self.assertEqual(client.queried, [2, 3, 4, 5])
            self.assertEqual(result["changedMessages"], 2)
            self.assertEqual(result["historyComplete"], 6)
            self.assertEqual(cache.cursor("telegram:42:2"), 6)
            self.assertEqual(cache.cursor("telegram:42:5"), 1)
            self.assertEqual(
                next(s for s in cache.sessions() if s["id"] == "telegram:42:1")["name"],
                "renamed-1",
            )

            heads[1] = 6
            client.queried.clear()
            result = asyncio.run(refresh(directory, config, cache, client))
            self.assertEqual(client.queried, [1, 4])
            self.assertEqual(result["changedMessages"], 1)
            self.assertEqual(
                [
                    m["platformMessageId"]
                    for m in cache.messages("telegram:42:1")["messages"]
                ],
                ["5", "6"],
            )

    def test_all_dialogs_discovers_new_chats_with_a_fixed_week_start(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Cache(directory)
            now = 1800000000

            class Client:
                peers = (1, 2)

                async def connect(self):
                    pass

                async def disconnect(self):
                    pass

                async def is_user_authorized(self):
                    return True

                async def get_me(self):
                    return SimpleNamespace(id=42)

                async def iter_dialogs(self):
                    for peer in self.peers:
                        yield SimpleNamespace(
                            id=peer, name=str(peer), is_user=True, entity=peer
                        )

                async def iter_messages(self, entity, **kwargs):
                    if kwargs["min_id"] == 0:
                        expected = now - 7 * 86400 + (86400 if entity == 3 else 0)
                        assert kwargs["offset_date"].timestamp() == expected - 1
                    yield types.Message(
                        id=1,
                        peer_id=types.PeerUser(entity),
                        from_id=types.PeerUser(entity),
                        date=datetime.fromtimestamp(now, UTC),
                        message="synthetic",
                    )

            client = Client()
            with (
                patch("bridge.make_client", return_value=client),
                patch("bridge.time.time", return_value=now),
            ):
                asyncio.run(refresh(directory, {"allDialogs": True}, cache))
            self.assertEqual(cache.status()["messages"], 2)
            client.peers = [1, 2, 3]
            with (
                patch("bridge.make_client", return_value=client),
                patch("bridge.time.time", return_value=now + 86400),
            ):
                asyncio.run(refresh(directory, {"allDialogs": True}, cache))
            self.assertEqual(cache.status()["messages"], 3)
            self.assertEqual(cache.history_since("telegram:42:1"), now - 7 * 86400)
            self.assertEqual(cache.history_since("telegram:42:3"), now - 6 * 86400)

    def test_interrupted_history_resumes_after_last_committed_page(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Cache(directory)
            sid = cache.session(1, -2, "Test", "group")
            stamp = datetime(2025, 1, 1, tzinfo=UTC)

            class Client:
                def __init__(self):
                    self.fail = True
                    self.cursors = []

                async def connect(self):
                    pass

                async def disconnect(self):
                    pass

                async def is_user_authorized(self):
                    return True

                async def get_me(self):
                    return SimpleNamespace(id=1)

                async def iter_dialogs(self):
                    yield SimpleNamespace(
                        id=-2,
                        name="Test",
                        is_user=False,
                        entity="test",
                        message=SimpleNamespace(id=5),
                    )

                async def iter_messages(
                    self, entity, min_id, reverse, limit, wait_time, offset_date
                ):
                    self.cursors.append(min_id)
                    assert reverse and limit is None and wait_time == 3
                    assert (offset_date is not None) == (min_id == 0)
                    if offset_date is not None:
                        assert offset_date.timestamp() == stamp.timestamp() - 1
                    for mid in range(min_id + 1, 6):
                        if self.fail and mid == 4:
                            raise ConnectionError("interrupted")
                        yield types.Message(
                            id=mid,
                            peer_id=types.PeerChat(2),
                            from_id=types.PeerUser(42),
                            date=stamp - timedelta(days=10) if mid == 1 else stamp,
                            message="same",
                        )

            client = Client()
            with (
                patch("bridge.make_client", return_value=client),
                patch("bridge.BATCH_SIZE", 2),
            ):
                with self.assertRaises(ConnectionError):
                    asyncio.run(
                        refresh(
                            directory,
                            {
                                "selectedPeers": ["-2"],
                                "historySince": int(stamp.timestamp()),
                            },
                            cache,
                        )
                    )
                self.assertEqual(cache.cursor(sid), 3)
                self.assertEqual(cache.scan_cursor(sid), 3)
                with cache.connect() as db:
                    self.assertEqual(
                        db.execute(
                            "SELECT last_scanned_id FROM sessions WHERE id=?", (sid,)
                        ).fetchone()[0],
                        0,
                    )
                self.assertEqual(cache.status()["historyComplete"], 0)
                client.fail = False
                result = asyncio.run(
                    refresh(
                        directory,
                        {
                            "selectedPeers": ["-2"],
                            "historySince": int(stamp.timestamp()),
                        },
                        cache,
                    )
                )
                self.assertEqual(client.cursors, [0, 3])
                self.assertEqual(
                    (result["messages"], result["historyComplete"]), (4, 1)
                )


if __name__ == "__main__":
    unittest.main()


class ImageProtocolTests(unittest.TestCase):
    def test_cancellation_is_authenticated_idempotent_and_rate_limit_seconds_survive_http(
        self,
    ):
        from media_scheduler import MediaRateLimited

        with tempfile.TemporaryDirectory() as directory:
            cache = Cache(directory)
            cache.bind_account(1)
            sid = cache.session(1, -2, "Synthetic", "group")
            cache.ingest(sid, [payload(9)])
            images = SimpleNamespace(
                request=lambda *args, **kwargs: (_ for _ in ()).throw(
                    MediaRateLimited(37)
                ),
                cancel_request=lambda _request_id: {"cancelled": True},
            )
            server = make_server(
                cache, {"token": "synthetic-secret", "port": 0}, images
            )
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_address[1]}"
            try:
                with self.assertRaises(HTTPError) as unauthorized:
                    urlopen(
                        Request(base + "/api/v1/image-requests/test", method="DELETE")
                    )
                self.assertEqual(unauthorized.exception.code, 401)
                headers = {"Authorization": "Bearer synthetic-secret"}
                for _ in range(2):
                    with urlopen(
                        Request(
                            base + "/api/v1/image-requests/test",
                            method="DELETE",
                            headers=headers,
                        )
                    ) as response:
                        self.assertEqual(json.load(response), {"cancelled": True})
                with self.assertRaises(HTTPError) as limited:
                    urlopen(
                        Request(
                            base + f"/api/v1/sessions/{sid}/messages/9/images/0",
                            headers=headers,
                        )
                    )
                self.assertEqual(limited.exception.code, 429)
                self.assertEqual(limited.exception.headers["Retry-After"], "37")
                self.assertEqual(json.load(limited.exception)["retryAfterSeconds"], 37)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(2)
