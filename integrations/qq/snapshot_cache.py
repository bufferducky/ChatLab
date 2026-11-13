"""Durable detached QQ snapshots with COW copies and authenticated page reuse.

The caller holds QQVault's writer lock and publishes only after message ingestion.
Only cache generations are writable; QQ's database files are always read-only.
"""
from __future__ import annotations

from contextlib import contextmanager, ExitStack
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import tempfile
import uuid

from qq_local_interface.crypto import DatabaseKey, HEADER_SIZE, detect_codec, first_page, wal_plan
from qq_local_interface.errors import QQError
from qq_local_interface.util import atomic_json, digest, file_digest, private_dir, regular_file

VERSION = 1
GENERATION = re.compile(r'gen-[0-9a-f]{32}')


def process_write_bytes():
    """Optional macOS process accounting, not SSD physical write telemetry."""
    if sys.platform != 'darwin':
        return None
    class Usage(ctypes.Structure):
        _fields_ = [('uuid', ctypes.c_uint8 * 16), ('counters', ctypes.c_uint64 * 18)]
    try:
        usage = Usage()
        library = ctypes.CDLL('/usr/lib/libproc.dylib')
        if library.proc_pid_rusage(os.getpid(), 2, ctypes.byref(usage)) == 0:
            return usage.counters[17]
    except (OSError, AttributeError):
        pass
    return None


def copy_detached(source, output):
    """Clone independent extents on APFS; safely copy on unsupported volumes."""
    source = regular_file(source)
    if sys.platform == 'darwin':
        library = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
        clone = library.clonefile
        clone.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
        clone.restype = ctypes.c_int
        if clone(os.fsencode(source), os.fsencode(output), 0) == 0:
            os.chmod(output, 0o600)
            return 'clone'
        code = ctypes.get_errno()
        if code not in (errno.ENOTSUP, errno.EXDEV, errno.EINVAL, errno.ENOSYS):
            raise OSError(code, 'snapshot clone failed')
    shutil.copyfile(source, output)
    os.chmod(output, 0o600)
    return 'copy'


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def capture(vault, source, target, names):
    """Retain the existing before/after and active-journal capture contract."""
    paths = [source / (name + suffix) for name in names for suffix in ('', '-wal', '-journal')]
    for _ in range(3):
        before = {path: vault._signature(path) for path in paths}
        if before[source / 'nt_msg.db'] is None:
            raise QQError('not_found', 'QQ message database is missing')
        for name in names:
            journal = source / (name + '-journal')
            if before[journal] and before[journal][2]:
                with regular_file(journal).open('rb') as stream:
                    if any(stream.read(28)):
                        raise QQError('source_busy', 'QQ has an active rollback journal')
        available, copies = [], {'clone': 0, 'copy': 0}
        for name in names:
            if before[source / name] is None:
                continue
            if before[source / name][2] <= 1024 and name == 'nt_msg.db':
                raise QQError('invalid_database', 'QQ message database has no data pages')
            available.append(name)
            for suffix in ('', '-wal'):
                original, destination = source / (name + suffix), target / (name + suffix)
                destination.unlink(missing_ok=True)
                if before[original] is not None:
                    copies[copy_detached(original, destination)] += 1
        if before == {path: vault._signature(path) for path in paths}:
            return available, copies
    raise QQError('source_busy', 'QQ files changed during capture; previous cache remains current')


class CommittedImage:
    """Resolve each current page from committed WAL or the detached main file."""
    def __init__(self, source, keys, stack):
        self.source = stack.enter_context(regular_file(source).open('rb'))
        page = first_page(source)
        self.codec = None
        if page is not None:
            record = (keys.get('keys_by_salt', {}).get(page[:16].hex())
                      or keys.get('databases', {}).get(source.name) or keys.get('default'))
            if record is None:
                raise QQError('key_required', 'no authenticated key is stored for selected database')
            self.codec = detect_codec(DatabaseKey.from_record(record), page)
            if self.codec is None:
                raise QQError('authentication_failed', 'database first page did not authenticate')
            self.size, self.offset = self.codec.page_size, HEADER_SIZE
            self.identity = digest([page[:16].hex(), hashlib.sha256(self.codec.encryption_key).hexdigest(),
                                    self.size, self.codec.hmac_algorithm, self.codec.kdf_algorithm,
                                    self.codec.reserved])
        else:
            self.source.seek(16)
            self.size = int.from_bytes(self.source.read(2), 'big')
            self.size = 65536 if self.size == 1 else self.size
            if not 512 <= self.size <= 65536 or self.size & (self.size - 1):
                raise QQError('invalid_database', 'invalid SQLite page size')
            self.offset, self.identity = 0, digest(['plain', self.size])
        physical, remainder = divmod(source.stat().st_size - self.offset, self.size)
        if remainder:
            raise QQError('invalid_database', 'partial main database page')
        self.wal = source.with_name(source.name + '-wal')
        self.plan = wal_plan(self.wal if self.wal.exists() else None, self.size)
        self.log = stack.enter_context(regular_file(self.wal).open('rb')) if self.plan['offsets'] else None
        self.pages = self.plan['database_pages'] or physical
        if self.codec:
            header = self.plain(self.raw(1), 1)
            logical = int.from_bytes(header[28:32], 'big')
            if (header[24:28] == header[92:96] and 0 < logical < physical
                    and all(number <= logical for number in self.plan['offsets'])):
                self.source.seek(self.offset + logical * self.size)
                zero_tail = True
                while trailing := self.source.read(1024 * 1024):
                    if any(trailing):
                        zero_tail = False
                        break
                if zero_tail:
                    self.pages = min(self.pages, logical)

    def raw(self, number):
        wal_offset = self.plan['offsets'].get(number)
        stream = self.log if wal_offset is not None else self.source
        stream.seek(wal_offset if wal_offset is not None else self.offset + (number - 1) * self.size)
        raw = stream.read(self.size)
        if len(raw) != self.size:
            raise QQError('invalid_database', 'partial effective database page')
        return raw

    def plain(self, raw, number):
        plain = self.codec.decrypt(raw, number) if self.codec else raw
        if number == 1:
            plain = plain[:18] + b'\x01\x01' + plain[20:]
        return plain


def quick_check(path):
    db = sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)
    try:
        if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise QQError('integrity_failed', 'candidate snapshot failed SQLite quick_check')
    finally:
        db.close()


class SnapshotGeneration:
    def __init__(self, store, path, manifest, previous, metrics):
        self.store, self.path, self.manifest = store, path, manifest
        self.previous, self.metrics = previous, metrics
        self.data = path / 'data'
        self.published = False

    def export(self, destination):
        """Give the delta extractor independent files, never the persistent base."""
        private_dir(destination)
        for name in self.manifest['databases']:
            copy_detached(self.data / name, destination / name)

    def commit(self):
        atomic_json(self.path / 'manifest.json', self.manifest)
        sync_directory(self.data)
        sync_directory(self.path)
        name = 'gen-' + uuid.uuid4().hex
        destination = self.store.root / name
        os.replace(self.path, destination)
        self.path, self.data = destination, destination / 'data'
        sync_directory(self.store.root)
        atomic_json(self.store.root / 'current.json', {'generation': name, 'previous': self.previous})
        # Once the pointer is replaced, cleanup must never treat this as uncommitted.
        self.published = True
        sync_directory(self.store.root)
        for path in self.store.root.iterdir():
            if GENERATION.fullmatch(path.name) and path.name not in (name, self.previous):
                shutil.rmtree(path)


class SnapshotStore:
    def __init__(self, root):
        self.root = private_dir(root).resolve()

    def previous(self, profile):
        try:
            pointer = json.loads(regular_file(self.root / 'current.json').read_text())
            name = pointer['generation']
            if not isinstance(name, str) or not GENERATION.fullmatch(name):
                return None, {}
            path = self.root / name
            manifest = json.loads(regular_file(path / 'manifest.json').read_text())
            if not isinstance(manifest, dict) or not isinstance(manifest.get('databases'), dict):
                return name, {}
            if manifest.get('version') != VERSION or manifest.get('profile') != profile:
                return name, {}
            return name, manifest['databases']
        except (OSError, QQError, ValueError, KeyError, TypeError):
            return None, {}

    def trusted(self, previous, name, meta, image):
        if not previous or not isinstance(meta, dict) or meta.get('identity') != image.identity:
            return False
        data = self.root / previous / 'data'
        try:
            plain, hashes = regular_file(data / name), regular_file(data / (name + '.sha256'))
            return (plain.stat().st_size == meta['pages'] * image.size
                    and hashes.stat().st_size == meta['pages'] * 32
                    and file_digest(plain) == meta['plaintextDigest']
                    and file_digest(hashes) == meta['fingerprintDigest'])
        except (OSError, QQError, KeyError, TypeError):
            return False

    def build(self, vault, config, source, output, previous, meta, keys):
        with ExitStack() as stack:
            image = CommittedImage(source, keys, stack)
            reuse = self.trusted(previous, source.name, meta, image)
            hashes = output.with_name(output.name + '.sha256')
            old_pages = meta['pages'] if reuse else 0
            if reuse:
                old = self.root / previous / 'data'
                copy_detached(old / source.name, output)
                copy_detached(old / (source.name + '.sha256'), hashes)
            else:
                vault._decrypt(source, output, keys, config['account'], image.wal if image.wal.exists() else None)
                hashes.touch(mode=0o600)
            changed = 0
            with output.open('r+b') as plain, hashes.open('r+b') as fingerprints:
                for number in range(1, image.pages + 1):
                    raw = image.raw(number)
                    fingerprint = hashlib.sha256(raw).digest()
                    fingerprints.seek((number - 1) * 32)
                    old_hash = fingerprints.read(32) if number <= old_pages else None
                    if fingerprint != old_hash:
                        if reuse:
                            plain.seek((number - 1) * image.size)
                            plain.write(image.plain(raw, number))
                        fingerprints.seek((number - 1) * 32)
                        fingerprints.write(fingerprint)
                        changed += 1
                plain.truncate(image.pages * image.size)
                fingerprints.truncate(image.pages * 32)
                for stream in (plain, fingerprints):
                    stream.flush()
                    os.fsync(stream.fileno())
            quick_check(output)
            return ({'identity': image.identity, 'pages': image.pages,
                     'plaintextDigest': file_digest(output), 'fingerprintDigest': file_digest(hashes)},
                    {'mode': 'pages' if reuse else 'full', 'pages': image.pages, 'changedPages': changed,
                     'newPages': max(0, image.pages - old_pages), 'removedPages': max(0, old_pages - image.pages),
                     'pageBytesWritten': changed * image.size, 'walFrames': image.plan['committed_frames'],
                     'ignoredWalTail': image.plan['ignored_tail']})

    @contextmanager
    def stage(self, vault, config, names):
        # Orphans from an interrupted pre-publication stage are disposable.
        for path in self.root.glob('.build-*'):
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
        profile = digest([str(Path(config['database_dir']).resolve()), config['account'], config['origin'], vault.source_id])
        previous, metadata = self.previous(profile)
        path = Path(tempfile.mkdtemp(prefix='.build-', dir=self.root))
        generation = None
        try:
            encrypted, data = private_dir(path / 'encrypted'), private_dir(path / 'data')
            available, copies = capture(vault, Path(config['database_dir']), encrypted, names)
            keys = vault._keys(config['key_file'])
            manifest = {'version': VERSION, 'profile': profile, 'databases': {}}
            metrics = {'captureCopies': copies, 'databases': {}}
            for name in available:
                meta, stats = self.build(vault, config, encrypted / name, data / name, previous, metadata.get(name), keys)
                manifest['databases'][name], metrics['databases'][name] = meta, stats
            shutil.rmtree(encrypted)
            generation = SnapshotGeneration(self, path, manifest, previous, metrics)
            yield generation
        finally:
            if generation is None or not generation.published:
                candidate = generation.path if generation else path
                if candidate.exists():
                    shutil.rmtree(candidate)
