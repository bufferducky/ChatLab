"""Page reuse must preserve committed messages and recover the last good cache."""
import contextlib
import importlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

from snapshot_cache import SnapshotStore, collector_lock


class SnapshotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = Path(os.environ.get('WECOM_SOURCE', Path.home() / '.local/share/wecom-agent/source'))
        sys.path.insert(0, str(source))
        try:
            cls.crypto = importlib.import_module('decrypt.wxwork_crypto')
        except ImportError:
            raise unittest.SkipTest('installed wecom-agent runtime required')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.database = self.source / 'Info.db'
        with contextlib.closing(sqlite3.connect(self.database)) as db, db:
            db.execute('PRAGMA page_size=4096')
            db.execute('CREATE TABLE sample(id INTEGER PRIMARY KEY,body TEXT)')
            db.executemany('INSERT INTO sample VALUES(?,?)', [(i, 'original' * 100) for i in range(1, 101)])
        self.keys = self.root / 'keys.json'
        self.keys.write_text('{}')
        self.keys.chmod(0o600)
        self.paths = [self.database]
        self.store = SnapshotStore(self.root / 'snapshots', self.crypto)

    def stage(self):
        return self.store.stage(self.paths, self.keys)

    def compare(self, snapshot):
        reference = self.root / 'reference.db'
        self.crypto.decrypt_database(self.database, reference, getattr(self, 'key', None))
        self.assertEqual((snapshot.data / 'Info.db').read_bytes(), reference.read_bytes())

    def commit(self):
        with self.stage() as snapshot:
            self.compare(snapshot)
            metrics = snapshot.metrics
            snapshot.commit()
        return metrics['databases']['Info.db']

    def current(self):
        pointer = json.loads((self.store.root / 'current.json').read_text())
        return self.store.root / pointer['generation'] / 'data' / 'Info.db'

    def test_restart_reuses_pages_and_retains_only_two_generations(self):
        self.assertEqual(self.commit()['mode'], 'full')
        self.store = SnapshotStore(self.store.root, self.crypto)
        stats = self.commit()
        self.assertEqual(stats['mode'], 'pages')
        self.assertEqual(stats['changedPages'], 0)
        self.commit()
        self.assertEqual(len(list(self.store.root.glob('gen-*'))), 2)
        self.assertEqual(self.current().stat().st_mode & 0o777, 0o600)

    def test_wal_update_growth_reset_and_shrink_match_full_output(self):
        self.commit()
        db = sqlite3.connect(self.database)
        try:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('PRAGMA wal_autocheckpoint=0')
            db.execute("UPDATE sample SET body='committed update' WHERE id=1")
            db.commit()
            self.assertGreater(self.commit()['changedPages'], 0)
            db.executemany('INSERT INTO sample VALUES(?,?)', [(i, 'new' * 500) for i in range(101, 401)])
            db.commit()
            self.assertGreater(self.commit()['newPages'], 0)
            db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            self.assertEqual(self.commit()['changedPages'], 0)
            db.execute("UPDATE sample SET body='new WAL' WHERE id=1")
            db.commit()
            self.assertGreater(self.commit()['changedPages'], 0)
        finally:
            db.close()
        self.commit()
        with contextlib.closing(sqlite3.connect(self.database)) as db:
            db.execute('DELETE FROM sample WHERE id>3')
            db.commit()
            db.execute('VACUUM')
        self.assertGreater(self.commit()['removedPages'], 0)

    def test_failed_consumer_or_publication_preserves_old_generation(self):
        self.commit()
        pointer = (self.store.root / 'current.json').read_bytes()
        contents = self.current().read_bytes()
        with contextlib.closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE sample SET body='pending' WHERE id=1")
        with self.assertRaises(RuntimeError):
            with self.stage():
                raise RuntimeError('message ingestion failed')
        self.assertEqual((self.store.root / 'current.json').read_bytes(), pointer)
        with self.assertRaises(OSError):
            with self.stage() as snapshot:
                with patch('snapshot_cache.atomic_json', side_effect=OSError('pointer not published')):
                    snapshot.commit()
        self.assertEqual((self.store.root / 'current.json').read_bytes(), pointer)
        self.assertEqual(self.current().read_bytes(), contents)
        self.assertFalse(list(self.store.root.glob('.build-*')))
        self.commit()

    def test_cache_data_fingerprints_and_manifest_corruption_rebuild(self):
        self.commit()
        with contextlib.closing(sqlite3.connect(self.current())) as db, db:
            db.execute("UPDATE sample SET body='valid SQLite with wrong content' WHERE id=1")
        self.assertEqual(self.commit()['mode'], 'full')
        hashes = self.current().with_name('Info.db.sha256')
        hashes.write_bytes(bytes(hashes.stat().st_size))
        self.assertEqual(self.commit()['mode'], 'full')
        (self.store.root / 'current.json').write_text('{broken')
        self.assertEqual(self.commit()['mode'], 'full')

    def test_two_databases_publish_together_and_bad_second_keeps_both(self):
        second = self.source / 'Session.db'
        second.write_bytes(self.database.read_bytes())
        self.paths.append(second)
        self.commit()
        pointer = (self.store.root / 'current.json').read_bytes()
        with contextlib.closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE sample SET body='first good' WHERE id=1")
        second.write_bytes(second.read_bytes()[:-1])
        with self.assertRaises(ValueError):
            self.commit()
        self.assertEqual((self.store.root / 'current.json').read_bytes(), pointer)
        second.write_bytes(self.database.read_bytes())
        self.commit()

    def test_interrupted_stage_cleaned_and_source_identity_invalidates(self):
        self.commit()
        orphan = self.store.root / '.build-interrupted'
        orphan.mkdir()
        (orphan / 'partial').write_bytes(b'incomplete')
        self.assertEqual(self.commit()['mode'], 'pages')
        self.assertFalse(orphan.exists())
        alternative = self.root / 'another-account'
        alternative.mkdir()
        other = alternative / 'Info.db'
        other.write_bytes(self.database.read_bytes())
        self.paths = [other]
        self.database = other
        self.assertEqual(self.commit()['mode'], 'full')

    def test_collector_lock_prevents_two_processes_publishing_same_cache(self):
        with collector_lock(self.root):
            with self.assertRaises(RuntimeError):
                with collector_lock(self.root):
                    self.fail('second writer acquired the lock')
        with collector_lock(self.root):
            pass

    def test_encrypted_changes_rotation_and_wrong_key_keep_old_cache(self):
        plain = self.database.read_bytes()
        key = bytes(range(16))

        def encode(data, value):
            pages = []
            for offset in range(0, len(data), 4096):
                number, page = offset // 4096 + 1, data[offset:offset + 4096]
                pages.append(self.crypto._encrypt_page1(value, page) if number == 1 else
                             self.crypto._aes_cbc_enc(self.crypto.derive_page_key(value, number),
                                                       self.crypto.generate_initial_vector(number), page))
            return b''.join(pages)

        self.key = key
        self.keys.write_text(json.dumps({'fixture': key.hex()}))
        self.database.write_bytes(encode(plain, key))
        self.commit()
        changed = self.root / 'changed.db'
        changed.write_bytes(plain)
        with contextlib.closing(sqlite3.connect(changed)) as db, db:
            db.execute("UPDATE sample SET body='encrypted change' WHERE id=1")
        self.database.write_bytes(encode(changed.read_bytes(), key))
        self.assertGreater(self.commit()['changedPages'], 0)
        key = bytes(reversed(range(16)))
        self.key = key
        self.keys.write_text(json.dumps({'fixture': key.hex()}))
        self.database.write_bytes(encode(changed.read_bytes(), key))
        self.assertEqual(self.commit()['mode'], 'full')
        pointer = (self.store.root / 'current.json').read_bytes()
        contents = self.current().read_bytes()
        self.keys.write_text(json.dumps({'wrong': bytes([99] * 16).hex()}))
        with self.assertRaises(ValueError):
            self.commit()
        self.assertEqual((self.store.root / 'current.json').read_bytes(), pointer)
        self.assertEqual(self.current().read_bytes(), contents)


if __name__ == '__main__':
    unittest.main()
