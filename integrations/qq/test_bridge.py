"""Guard against missing late QQ history, duplicates, and unauthenticated reads."""
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from bridge import Cache, convert_message, extract_new_rows, make_server


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.cache = Cache(self.root / 'cache')
        self.records = self.root / 'records.db'
        with sqlite3.connect(self.records) as db:
            db.executescript('''CREATE TABLE actors(id TEXT,name TEXT);
                CREATE TABLE conversations(id TEXT,name TEXT,kind TEXT);
                CREATE TABLE messages(payload TEXT,created_at TEXT);
                INSERT INTO actors VALUES('u1','Alice');
                INSERT INTO conversations VALUES('c1','Test group','group');''')

    def tearDown(self):
        self.temp.cleanup()

    def add(self, native_id, stamp='2020-01-01T00:00:00Z', kind='text', text='same text\nsecond line'):
        item = {'id': 'item-' + str(native_id), 'conversation_id': 'c1', 'author_id': 'u1',
                'created_at': stamp, 'kind': kind, 'text': text,
                'provenance': {'table': 'group_msg_table', 'local_id': str(native_id)}}
        with sqlite3.connect(self.records) as db:
            db.execute('INSERT INTO messages VALUES(?,?)', (json.dumps(item), stamp))

    def test_late_lower_ids_duplicate_bodies_and_restart(self):
        self.add(9007199254740993)
        self.add(9007199254740994)
        self.cache.ingest(self.records, 'account-a', bootstrap=True, now=1800000000)
        initial = self.cache.messages('c1', limit=1)
        self.assertTrue(initial['sync']['hasMore'])
        # New native IDs can be smaller and have an old send timestamp.
        self.add(2, stamp='2019-01-01T00:00:00Z', kind='image', text=None)
        result = self.cache.ingest(self.records, 'account-a', now=1800000200)
        self.assertEqual(result['changedMessages'], 1)
        tail = self.cache.messages('c1', offset=initial['sync']['nextOffset'])
        self.assertEqual(len(tail['messages']), 2)
        self.assertEqual(len({m['platformMessageId'] for m in initial['messages'] + tail['messages']}), 3)
        late = self.cache.messages('c1', since=1800000000)
        self.assertEqual([m['type'] for m in late['messages']], [1])
        self.assertEqual(late['messages'][0]['content'], '[QQ image]')
        self.assertEqual(late['messages'][0]['timestamp'], 1546300800)
        restarted = Cache(self.cache.root)
        self.assertEqual(restarted.ingest(self.records, 'account-a')['changedMessages'], 0)
        self.assertEqual(restarted.status()['messages'], 3)
        with self.assertRaises(ValueError):
            restarted.ingest(self.records, 'other-account')
        self.assertEqual(restarted.status()['messages'], 3)

    def test_failed_ingest_is_atomic(self):
        self.add(1)
        self.add(2)
        with sqlite3.connect(self.records) as db:
            db.execute("UPDATE messages SET payload=json_set(payload,'$.provenance.local_id','invalid') WHERE rowid=2")
        with self.assertRaises(ValueError):
            self.cache.ingest(self.records, 'account-a')
        self.assertFalse(self.cache.status()['ready'])
        self.assertEqual(self.cache.status()['messages'], 0)

    def test_pull_watermark_does_not_outrun_committed_observations(self):
        self.add(1)
        self.cache.ingest(self.records, 'account-a', now=1800000000)
        with patch('bridge.time.time', return_value=1900000000):
            page = self.cache.messages('c1')
        self.assertEqual(page['sync']['nextSince'], 1800000000)

    def test_media_types_match_chatlab_and_plain_text_is_preserved(self):
        for kind, expected in [('text', 0), ('image', 1), ('voice', 2), ('video', 3),
                               ('file', 4), ('sticker', 5), ('forward', 26), ('mixed', 99)]:
            with self.subTest(kind=kind):
                converted = convert_message({'created_at': '2020-01-01T00:00:00Z', 'id': 'm1',
                    'kind': kind, 'text': 'line1\nline2'}, 'Alice', 'a')
                self.assertEqual(converted['type'], expected)
                self.assertEqual(converted['content'], 'line1\nline2')
        undated = convert_message({'created_at': None, 'id': 'm0', 'kind': 'system', 'text': None}, None, 'a')
        self.assertEqual(undated['timestamp'], 1)

    def test_native_delta_finds_old_ids_and_keeps_source_intact(self):
        self.add(9007199254740993)
        self.cache.ingest(self.records, 'account-a')
        data = self.root / 'data'
        data.mkdir()
        with sqlite3.connect(data / 'nt_msg.db') as db:
            for table in ('group_msg_table', 'c2c_msg_table'):
                db.execute(f'CREATE TABLE {table}("40001" INTEGER PRIMARY KEY,"40050" INTEGER)')
            db.executemany('INSERT INTO group_msg_table VALUES(?,?)', [(9007199254740993, 10), (2, 1)])
            # IDs are namespaced by table, not assumed globally unique.
            db.execute('INSERT INTO c2c_msg_table VALUES(?,?)', (9007199254740993, 10))
        extract_new_rows(data, self.cache)
        with sqlite3.connect(data / 'nt_msg.db') as db:
            self.assertEqual(db.execute('SELECT "40001" FROM group_msg_table').fetchall(), [(2,)])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM c2c_msg_table').fetchone()[0], 1)

    def test_http_auth_and_keyset_paging(self):
        self.add(1)
        self.add(2)
        self.cache.ingest(self.records, 'account-a')
        server = make_server(self.cache, {'token': 'test-token', 'port': 0})
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{server.server_port}'
        try:
            with self.assertRaises(HTTPError) as caught:
                urlopen(base + '/api/v1/sessions')
            self.assertEqual(caught.exception.code, 401)
            def get(path):
                with urlopen(Request(base + path, headers={'Authorization': 'Bearer test-token'})) as response:
                    return json.load(response)
            self.assertEqual(get('/api/v1/sessions')['sessions'][0]['messageCount'], 2)
            first = get('/api/v1/sessions/c1/messages?limit=1')
            second = get('/api/v1/sessions/c1/messages?limit=1&offset=' + str(first['sync']['nextOffset']))
            self.assertNotEqual(first['messages'][0]['platformMessageId'], second['messages'][0]['platformMessageId'])
            self.assertFalse(second['sync']['hasMore'])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
