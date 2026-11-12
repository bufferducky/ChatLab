import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from bridge import Cache, make_server


def row(lid, *, cid='g', stamp=100, body='hello', code=0):
    return {'local_id': lid, 'conv_id': cid, 'conversation': 'Same name',
            'sender_id': 123456789123456789, 'sender': 'Alice',
            'send_time': stamp, 'type_code': code, '_raw': body}


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cache = Cache(self.temp.name)
        self.conversations = [{'id': 'g', 'name': 'Same name', 'kind': 'group'},
                              {'id': 'p', 'name': 'Same name', 'kind': 'private'}]

    def ingest(self, rows, now=200):
        return self.cache.ingest('account', self.conversations, rows, lambda code, raw: raw, now=now)

    def test_same_name_conversations_stay_separate_and_ids_are_strings(self):
        self.ingest([row(1), row(2, cid='p', stamp=1000000000000)])
        self.assertEqual({s['type'] for s in self.cache.sessions()}, {'group', 'private'})
        payload = self.cache.messages('account-g')
        self.assertEqual(payload['members'][0]['platformId'], '123456789123456789')
        self.assertEqual(payload['messages'][0]['platformMessageId'], 'wecom:account:g:1')
        self.assertEqual(self.cache.messages('account-p')['messages'][0]['timestamp'], 1000000000)

    def test_same_second_pages_preserve_all_records_and_repeated_content(self):
        self.ingest([row(i) for i in range(13)])
        offset, ids = 0, []
        while True:
            page = self.cache.messages('account-g', offset=offset, limit=3)
            ids.extend(m['platformMessageId'] for m in page['messages'])
            if not page['sync']['hasMore']:
                self.assertGreaterEqual(page['sync']['nextSince'], 200)
                break
            self.assertNotIn('nextSince', page['sync'])
            offset = page['sync']['nextOffset']
        self.assertEqual(len(ids), 13)
        self.assertEqual(len(set(ids)), 13)

    def test_late_history_and_restart_do_not_lose_or_duplicate_messages(self):
        self.ingest([row(50)], now=200)
        cache = Cache(self.temp.name)
        result = cache.ingest('account', self.conversations, [row(50), row(2, stamp=50)],
                              lambda code, raw: raw, now=300)
        self.assertEqual(result['changedMessages'], 1)
        new = cache.messages('account-g', since=250)
        self.assertEqual([m['platformMessageId'] for m in new['messages']], ['wecom:account:g:2'])
        self.assertNotIn('meta', new)
        self.assertEqual(cache.status()['messages'], 2)

    def test_unknown_types_are_kept_and_failed_batch_rolls_back(self):
        self.ingest([row(1, code=999)])
        self.assertEqual(self.cache.messages('account-g')['messages'][0]['type'], 99)
        with self.assertRaises(ValueError):
            self.ingest([row(2), row(3, stamp=-1)])
        self.assertEqual(self.cache.status()['messages'], 1)
        self.cache.fail(ValueError())
        self.assertFalse(self.cache.status()['ready'])

    def test_different_account_cannot_pollute_existing_source(self):
        self.ingest([row(1)])
        with self.assertRaises(ValueError):
            self.cache.ingest('other', self.conversations, [row(2)], lambda code, raw: raw)
        self.assertEqual(self.cache.status()['messages'], 1)

    def test_http_requires_auth_and_does_not_serve_failed_snapshot(self):
        self.ingest([row(1)])
        server = make_server(self.cache, {'port': 0, 'token': 'test-secret'})
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f'http://127.0.0.1:{server.server_port}/api/v1/sessions'
        with self.assertRaises(HTTPError) as caught:
            urlopen(url)
        self.assertEqual(caught.exception.code, 401)
        request = Request(url, headers={'Authorization': 'Bearer test-secret'})
        with urlopen(request) as response:
            self.assertEqual(len(json.load(response)['sessions']), 1)
        self.cache.fail(ValueError())
        with self.assertRaises(HTTPError) as caught:
            urlopen(request)
        self.assertEqual(caught.exception.code, 503)


if __name__ == '__main__':
    unittest.main()
