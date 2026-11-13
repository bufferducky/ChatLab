"""Persistent page reuse must preserve committed rows and the last good cache."""
import ctypes
import ctypes.util
import hashlib
import hmac
import json
from pathlib import Path
import sqlite3
import struct
import tempfile
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from qq_local_interface.crypto import DatabaseKey, decrypt_database, wal_checksum
from qq_local_interface.errors import QQError
from qq_local_interface.vault import QQVault

from snapshot_cache import SnapshotStore


def reserved_database(path):
    library = ctypes.CDLL(ctypes.util.find_library('sqlite3'))
    pointer = ctypes.c_void_p()
    library.sqlite3_open.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
    library.sqlite3_exec.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    library.sqlite3_file_control.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p]
    library.sqlite3_close.argtypes = [ctypes.c_void_p]
    assert library.sqlite3_open(str(path).encode(), ctypes.byref(pointer)) == 0
    try:
        assert library.sqlite3_exec(pointer, b'PRAGMA page_size=4096', None, None, None) == 0
        reserve = ctypes.c_int(48)
        assert library.sqlite3_file_control(pointer, None, 38, ctypes.byref(reserve)) == 0
        assert library.sqlite3_exec(pointer, b'CREATE TABLE messages(id INTEGER PRIMARY KEY,body TEXT)', None, None, None) == 0
    finally:
        library.sqlite3_close(pointer)


def encrypt_fixture(source, destination, passphrase='fixture-key', salt=bytes(range(16)), wal=False):
    encryption = hashlib.pbkdf2_hmac('sha512', passphrase.encode(), salt, 4000, 32)
    mac_key = hashlib.pbkdf2_hmac('sha512', encryption, bytes(v ^ 58 for v in salt), 2, 32)

    def page(plain, number):
        iv = hashlib.sha256(b'fixture iv' + struct.pack('<I', number)).digest()[:16]
        start = 16 if number == 1 else 0
        cipher = Cipher(algorithms.AES(encryption), modes.CBC(iv)).encryptor()
        body = cipher.update(plain[start:4048]) + cipher.finalize()
        mac = hmac.new(mac_key, body + iv + struct.pack('<I', number), hashlib.sha1).digest()
        return (salt if number == 1 else b'') + body + iv + mac + bytes(12)

    with source.open('rb') as src, destination.open('wb') as dst:
        if not wal:
            dst.write(bytes(1024))
            number = 1
            while plain := src.read(4096):
                dst.write(page(plain, number))
                number += 1
            return
        header = src.read(32)
        if not header:
            return
        endian = '<' if struct.unpack('>I', header[:4])[0] == 0x377F0682 else '>'
        checksum = wal_checksum(header[:24], endian=endian)
        dst.write(header[:24] + struct.pack('>II', *checksum))
        while frame := src.read(24):
            payload = page(src.read(4096), struct.unpack('>I', frame[:4])[0])
            checksum = wal_checksum(frame[:8] + payload, checksum, endian)
            dst.write(frame[:16] + struct.pack('>II', *checksum) + payload)


class SnapshotCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.database = self.source / 'nt_msg.db'
        with sqlite3.connect(self.database) as db:
            db.execute('CREATE TABLE messages(id INTEGER PRIMARY KEY, body TEXT)')
            db.execute("INSERT INTO messages VALUES(1,'initial')")
        self.vault = QQVault(self.root / 'vault', 'fixture')
        self.config = {'database_dir': str(self.source), 'key_file': str(self.root / 'keys.json'),
                       'account': {'uin': '111', 'uid': 'fixture'}, 'origin': 'fixture'}
        (self.root / 'keys.json').write_text('{}')
        (self.root / 'keys.json').chmod(0o600)
        self.store = SnapshotStore(self.root / 'snapshots')
        self.names = ('nt_msg.db',)
        self.key = None

    def tearDown(self):
        self.temp.cleanup()

    def stage(self):
        return self.store.stage(self.vault, self.config, self.names)

    def compare(self, snapshot):
        reference = self.root / 'reference.db'
        reference.unlink(missing_ok=True)
        wal = self.source / 'nt_msg.db-wal'
        decrypt_database(self.database, reference, self.key, wal=wal if wal.exists() else None)
        self.assertEqual((snapshot.data / 'nt_msg.db').read_bytes(), reference.read_bytes())

    def commit(self):
        with self.stage() as snapshot:
            self.compare(snapshot)
            metrics = snapshot.metrics
            snapshot.commit()
        return metrics

    def current(self):
        pointer = json.loads((self.store.root / 'current.json').read_text())
        return self.store.root / pointer['generation'] / 'data' / 'nt_msg.db'

    def test_restart_reuses_pages_and_extraction_cannot_destroy_base(self):
        self.commit()
        self.store = SnapshotStore(self.store.root)
        with self.stage() as snapshot:
            self.compare(snapshot)
            self.assertEqual(snapshot.metrics['databases']['nt_msg.db']['changedPages'], 0)
            consumer = self.root / 'consumer'
            snapshot.export(consumer)
            (consumer / 'nt_msg.db').write_bytes(b'delta only')
            self.compare(snapshot)
            snapshot.commit()
        self.commit()
        self.assertEqual(len(list(self.store.root.glob('gen-*'))), 2)

    def test_wal_commits_growth_reset_and_shrink_match_full_decryption(self):
        self.commit()
        db = sqlite3.connect(self.database)
        try:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('PRAGMA wal_autocheckpoint=0')
            db.execute("UPDATE messages SET body='updated' WHERE id=1")
            db.commit()
            self.assertGreater(self.commit()['databases']['nt_msg.db']['changedPages'], 0)
            db.executemany('INSERT INTO messages VALUES(?,?)', [(i, 'x' * 1000) for i in range(2, 80)])
            db.commit()
            self.assertGreater(self.commit()['databases']['nt_msg.db']['newPages'], 0)
            db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            self.assertEqual(self.commit()['databases']['nt_msg.db']['changedPages'], 0)
            db.execute("UPDATE messages SET body='new WAL' WHERE id=1")
            db.commit()
            self.commit()
        finally:
            db.close()
        with sqlite3.connect(self.database) as db:
            db.execute('DELETE FROM messages WHERE id>1')
            db.commit()
            db.execute('VACUUM')
        db.close()
        self.assertGreater(self.commit()['databases']['nt_msg.db']['removedPages'], 0)

    def test_failure_and_interrupted_publication_keep_previous_generation(self):
        self.commit()
        pointer = (self.store.root / 'current.json').read_bytes()
        contents = self.current().read_bytes()
        with sqlite3.connect(self.database) as db:
            db.execute("UPDATE messages SET body='next' WHERE id=1")
        with self.assertRaises(RuntimeError):
            with self.stage():
                raise RuntimeError('consumer failed before publication')
        self.assertEqual((self.store.root / 'current.json').read_bytes(), pointer)
        with self.assertRaises(OSError):
            with self.stage() as snapshot:
                with patch('snapshot_cache.atomic_json', side_effect=OSError('publication interrupted')):
                    snapshot.commit()
        self.assertEqual((self.store.root / 'current.json').read_bytes(), pointer)
        self.assertEqual(self.current().read_bytes(), contents)
        self.commit()

    def test_corrupt_cached_data_or_fingerprints_rebuild_instead_of_reusing(self):
        self.commit()
        # Still valid SQLite, same file size: quick_check alone cannot catch this.
        with sqlite3.connect(self.current()) as db:
            db.execute("UPDATE messages SET body='damaged' WHERE id=1")
        result = self.commit()['databases']['nt_msg.db']
        self.assertEqual(result['mode'], 'full')
        fingerprint = self.current().parent / 'nt_msg.db.sha256'
        fingerprint.write_bytes(bytes(fingerprint.stat().st_size))
        self.assertEqual(self.commit()['databases']['nt_msg.db']['mode'], 'full')

    def test_source_profile_change_invalidates_cache_and_busy_source_does_not_publish(self):
        self.commit()
        self.config['origin'] = 'another-account'
        self.assertEqual(self.commit()['databases']['nt_msg.db']['mode'], 'full')
        pointer = (self.store.root / 'current.json').read_bytes()
        journal = self.source / 'nt_msg.db-journal'
        journal.write_bytes(b'active journal' + bytes(32))
        with self.assertRaises(QQError) as caught:
            self.commit()
        self.assertEqual(caught.exception.code, 'source_busy')
        self.assertEqual((self.store.root / 'current.json').read_bytes(), pointer)

    def test_missing_optional_database_and_corrupt_manifest_recover(self):
        self.names = ('nt_msg.db', 'profile_info.db')
        self.commit()
        (self.store.root / 'current.json').write_text('{broken')
        self.assertEqual(self.commit()['databases']['nt_msg.db']['mode'], 'full')

    def test_encrypted_wal_preallocation_key_rotation_and_bad_pages(self):
        plain = self.root / 'plain.db'
        reserved_database(plain)
        db = sqlite3.connect(plain)
        db.execute("INSERT INTO messages VALUES(1,'encrypted initial')")
        db.commit()
        passphrase, salt = 'fixture-key', bytes(range(16))

        def capture_cipher():
            encrypt_fixture(plain, self.database, passphrase, salt)
            output_wal = self.source / 'nt_msg.db-wal'
            original_wal = plain.with_name('plain.db-wal')
            output_wal.unlink(missing_ok=True)
            if original_wal.exists():
                encrypt_fixture(original_wal, output_wal, passphrase, salt, wal=True)
            with self.database.open('ab') as stream:
                stream.write(bytes(4096 * 3))
            record = {'kind': 'passphrase', 'value': passphrase}
            (self.root / 'keys.json').write_text(json.dumps({'default': record}))
            self.key = DatabaseKey.from_record(record)

        try:
            capture_cipher()
            self.commit()
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('PRAGMA wal_autocheckpoint=0')
            db.execute("UPDATE messages SET body='committed encrypted WAL' WHERE id=1")
            db.commit()
            capture_cipher()
            self.assertGreater(self.commit()['databases']['nt_msg.db']['changedPages'], 0)
            db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            capture_cipher()
            self.assertEqual(self.commit()['databases']['nt_msg.db']['changedPages'], 0)
        finally:
            db.close()
        passphrase, salt = 'rotated-fixture-key', bytes(reversed(range(16)))
        capture_cipher()
        self.assertEqual(self.commit()['databases']['nt_msg.db']['mode'], 'full')
        pointer = (self.store.root / 'current.json').read_bytes()
        contents = self.current().read_bytes()
        with self.database.open('r+b') as stream:
            stream.seek(1024 + 4096 + 40)
            value = stream.read(1)
            stream.seek(-1, 1)
            stream.write(bytes([value[0] ^ 1]))
        with self.assertRaises(QQError) as caught:
            self.commit()
        self.assertEqual(caught.exception.code, 'authentication_failed')
        self.assertEqual((self.store.root / 'current.json').read_bytes(), pointer)
        self.assertEqual(self.current().read_bytes(), contents)


if __name__ == '__main__':
    unittest.main()
