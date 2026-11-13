"""Persist verified WeCom plaintext generations and patch changed pages only.

Uses wecom-agent's committed WAL reader, cipher and integrity checks. wxSQLite3
has no page HMAC; fingerprints detect cache changes, not source authenticity.
The caller holds collector_lock across staging, message ingestion and publication.
"""
from __future__ import annotations

from contextlib import contextmanager
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile
import uuid

VERSION = 1
GENERATION = re.compile(r'gen-[0-9a-f]{32}')


def private_dir(path):
    path = Path(path)
    if path.is_symlink():
        raise ValueError('snapshot directory must not be a symbolic link')
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)
    return path


def regular_file(path):
    path = Path(path)
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError('snapshot input must be a regular file')
    return path


def file_digest(path):
    result = hashlib.sha256()
    with regular_file(path).open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            result.update(chunk)
    return result.hexdigest()


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_json(path, value):
    descriptor, temporary = tempfile.mkstemp(prefix='.write-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, separators=(',', ':'))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


@contextmanager
def collector_lock(root):
    descriptor = os.open(Path(root) / 'collector.lock', os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('CollectorBusy') from None
        yield
    finally:
        os.close(descriptor)


def copy_detached(source, output):
    """APFS clone shares unchanged extents without sharing future file writes."""
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


def process_write_bytes():
    """Optional process-accounted bytes; this is not physical SSD telemetry."""
    if sys.platform != 'darwin':
        return None
    class Usage(ctypes.Structure):
        _fields_ = [('uuid', ctypes.c_uint8 * 16), ('counters', ctypes.c_uint64 * 18)]
    try:
        result = Usage()
        library = ctypes.CDLL('/usr/lib/libproc.dylib')
        if library.proc_pid_rusage(os.getpid(), 2, ctypes.byref(result)) == 0:
            return result.counters[17]
    except (AttributeError, OSError):
        pass
    return None


class SnapshotGeneration:
    def __init__(self, store, path, manifest, previous, metrics):
        self.store, self.path, self.manifest = store, path, manifest
        self.data = path / 'data'
        self.previous, self.metrics, self.published = previous, metrics, False

    def commit(self):
        atomic_json(self.path / 'manifest.json', self.manifest)
        sync_directory(self.data)
        sync_directory(self.path)
        name = 'gen-' + uuid.uuid4().hex
        destination = self.store.root / name
        os.replace(self.path, destination)
        self.path, self.data = destination, destination / 'data'
        sync_directory(self.store.root)
        atomic_json(self.store.root / 'current.json', {'generation': name})
        self.published = True
        sync_directory(self.store.root)
        # Only cache-owned generations are removable; message archives are separate.
        for path in self.store.root.iterdir():
            if (GENERATION.fullmatch(path.name) and path.name not in (name, self.previous)
                    and path.is_dir() and not path.is_symlink()):
                shutil.rmtree(path)


class SnapshotStore:
    def __init__(self, root, crypto, *, reader=None):
        self.root = private_dir(root).resolve()
        self.crypto = crypto
        self.reader = reader or crypto.read_snapshot

    def previous(self, profile):
        try:
            pointer = json.loads(regular_file(self.root / 'current.json').read_text())
            name = pointer['generation']
            if not isinstance(name, str) or not GENERATION.fullmatch(name):
                return None, {}
            manifest = json.loads(regular_file(self.root / name / 'manifest.json').read_text())
            if not isinstance(manifest, dict) or not isinstance(manifest.get('databases'), dict):
                return name, {}
            if manifest.get('version') != VERSION or manifest.get('profile') != profile:
                return name, {}
            return name, manifest['databases']
        except (OSError, ValueError, KeyError, TypeError):
            return None, {}

    def trusted(self, previous, name, meta, identity):
        if not previous or not isinstance(meta, dict) or meta.get('identity') != identity:
            return False
        try:
            pages = meta['pages']
            if type(pages) is not int or pages <= 0:
                return False
            data = self.root / previous / 'data'
            plain, hashes = regular_file(data / name), regular_file(data / (name + '.sha256'))
            return (plain.stat().st_size == pages * self.crypto.PAGE_SZ
                    and hashes.stat().st_size == pages * 32
                    and file_digest(plain) == meta['plaintextDigest']
                    and file_digest(hashes) == meta['fingerprintDigest'])
        except (OSError, ValueError, KeyError, TypeError):
            return False

    def build(self, path, key_file, output, previous, meta):
        size = self.crypto.PAGE_SZ
        data = self.reader(path)
        if len(data) < size or len(data) % size:
            raise ValueError('Incomplete committed database page')
        plain_input = data.startswith(self.crypto.SQLITE_HDR)
        keys = [] if plain_input else self.crypto.load_valid_keys(key_file, data[:size])
        if not plain_input and not keys:
            raise ValueError('Existing WeCom key is no longer valid')
        key = keys[0] if keys else None
        identity = hashlib.sha256(b'plain' if plain_input else b'wxSQLite3-AES128:' + key).hexdigest()
        reusable = self.trusted(previous, path.name, meta, identity)
        pages = len(data) // size
        hashes = output.with_name(output.name + '.sha256')
        copies = {'clone': 0, 'copy': 0}
        if reusable:
            base = self.root / previous / 'data'
            copies[copy_detached(base / path.name, output)] += 1
            copies[copy_detached(base / (path.name + '.sha256'), hashes)] += 1
        else:
            for target in (output, hashes):
                descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
                os.close(descriptor)
        old_pages = meta['pages'] if reusable else 0
        changed = 0
        with output.open('r+b') as target, hashes.open('r+b') as fingerprints:
            for number in range(1, pages + 1):
                offset = (number - 1) * size
                raw = data[offset:offset + size]
                fingerprint = hashlib.sha256(raw).digest()
                fingerprints.seek((number - 1) * 32)
                old = fingerprints.read(32) if number <= old_pages else None
                if old != fingerprint:
                    target.seek(offset)
                    target.write(raw if plain_input else self.crypto.decrypt_page(key, raw, number))
                    fingerprints.seek((number - 1) * 32)
                    fingerprints.write(fingerprint)
                    changed += 1
            target.truncate(pages * size)
            fingerprints.truncate(pages * 32)
            for stream in (target, fingerprints):
                stream.flush()
                os.fsync(stream.fileno())
        self.crypto.validate_database(output)
        return ({'identity': identity, 'pages': pages, 'plaintextDigest': file_digest(output),
                 'fingerprintDigest': file_digest(hashes)},
                {'mode': 'pages' if reusable else 'full', 'pages': pages, 'changedPages': changed,
                 'newPages': max(0, pages - old_pages), 'removedPages': max(0, old_pages - pages),
                 'pageBytesWritten': changed * size, 'copies': copies})

    @contextmanager
    def stage(self, paths, key_file):
        # Called with the collector lock, so interrupted candidates cannot be live.
        for path in self.root.glob('.build-*'):
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
        paths = [Path(path).resolve() for path in paths]
        profile = hashlib.sha256(json.dumps([str(path) for path in paths]).encode()).hexdigest()
        previous, metadata = self.previous(profile)
        path = Path(tempfile.mkdtemp(prefix='.build-', dir=self.root))
        generation = None
        try:
            data = private_dir(path / 'data')
            manifest = {'version': VERSION, 'profile': profile, 'databases': {}}
            metrics = {'databases': {}}
            for source in paths:
                meta, stats = self.build(source, key_file, data / source.name, previous, metadata.get(source.name))
                manifest['databases'][source.name], metrics['databases'][source.name] = meta, stats
            generation = SnapshotGeneration(self, path, manifest, previous, metrics)
            yield generation
        finally:
            if generation is None or not generation.published:
                candidate = generation.path if generation else path
                if candidate.exists():
                    shutil.rmtree(candidate)
