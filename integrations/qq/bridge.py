#!/usr/bin/env python3
"""Expose authenticated local QQ snapshots through the ChatLab Pull protocol."""
from __future__ import annotations

import argparse
import contextlib
from datetime import datetime
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import sqlite3
import tempfile
import threading
import time
from urllib.parse import parse_qs, unquote, urlsplit

DEFAULT_HOME = Path.home() / '.local/share/chatlab-qq'
TYPE_MAP = {'text': 0, 'image': 1, 'voice': 2, 'video': 3, 'file': 4,
            'sticker': 5, 'card': 7, 'forward': 26, 'quote': 25, 'call': 23,
            'location': 8, 'system': 80}
CORE_DATABASES = ('nt_msg.db', 'profile_info.db', 'group_info.db')


@contextlib.contextmanager
def readonly(path):
    db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    try:
        yield db
    finally:
        db.close()


def convert_message(item, name, origin):
    # ChatLab incremental imports require positive timestamps. One second after
    # epoch is the explicit unknown-time sentinel, not an inferred send date.
    stamp = int(datetime.fromisoformat(item['created_at'].replace('Z', '+00:00')).timestamp()) if item['created_at'] else 1
    content = item.get('search_text') or item.get('text') or item.get('title') or f"[QQ {item['kind']}]"
    return {'platformMessageId': f"qq:{origin}:{item['id']}",
            'sender': item.get('author_id') or 'qq:unknown',
            'accountName': name or item.get('author_id') or 'QQ',
            'timestamp': stamp, 'type': TYPE_MAP.get(item['kind'], 99), 'content': content}


class Cache:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.root / 'messages.sqlite3'
        self.lock = threading.RLock()
        with self.connect() as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT);
                CREATE TABLE IF NOT EXISTS sessions(
                    id TEXT PRIMARY KEY,name TEXT,kind TEXT,message_count INTEGER DEFAULT 0,
                    last_stamp INTEGER,member_count INTEGER DEFAULT 0);
                CREATE TABLE IF NOT EXISTS messages(
                    seq INTEGER PRIMARY KEY,id TEXT UNIQUE,session_id TEXT,observed INTEGER,
                    stamp INTEGER,sender TEXT,payload TEXT,native_table TEXT,native_id INTEGER,
                    UNIQUE(native_table,native_id));
                CREATE INDEX IF NOT EXISTS session_seq ON messages(session_id,seq);
                CREATE INDEX IF NOT EXISTS session_observed ON messages(session_id,observed,seq);
            ''')
        self.path.chmod(0o600)

    @contextlib.contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=120)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def ingest(self, records, origin, *, bootstrap=False, now=None):
        changed = 0
        with self.lock, self.connect() as db, readonly(records) as source:
            state = dict(db.execute('SELECT key,value FROM state'))
            if state.get('origin', origin) != origin:
                raise ValueError('QQ account changed; use a separate bridge directory')
            clock = max(int(time.time() if now is None else now), int(state.get('clock', 0)) + 1)
            latest = source.execute('SELECT created_at FROM messages ORDER BY created_at DESC LIMIT 1').fetchone()
            if latest and latest[0]:
                latest_stamp = int(datetime.fromisoformat(latest[0].replace('Z', '+00:00')).timestamp())
                clock = max(clock, latest_stamp + (120 if bootstrap else 0))
            actors = dict(source.execute('SELECT id,name FROM actors'))
            conversations = {r['id']: r for r in source.execute('SELECT id,name,kind FROM conversations')}
            affected = set()
            for row in source.execute('SELECT payload FROM messages ORDER BY rowid'):
                item = json.loads(row[0])
                payload = convert_message(item, actors.get(item.get('author_id')), origin)
                # Old bootstrap history sits outside the pull engine's overlap window.
                observed = clock - 120 if bootstrap else clock
                cid = item['conversation_id']
                if cid not in affected:
                    conv = conversations[cid]
                    db.execute('''INSERT INTO sessions(id,name,kind) VALUES(?,?,?)
                        ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind''',
                               (cid, conv['name'] or cid, 'group' if conv['kind'] == 'group' else 'private'))
                    affected.add(cid)
                native = item['provenance']
                result = db.execute('''INSERT OR IGNORE INTO messages
                    (id,session_id,observed,stamp,sender,payload,native_table,native_id)
                    VALUES(?,?,?,?,?,?,?,?)''',
                    (payload['platformMessageId'], cid, observed, payload['timestamp'], payload['sender'],
                     json.dumps(payload, ensure_ascii=False), native['table'], int(native['local_id'])))
                changed += result.rowcount
            for cid in affected:
                stats = db.execute('SELECT COUNT(*),MAX(stamp),COUNT(DISTINCT sender) FROM messages WHERE session_id=?',
                                   (cid,)).fetchone()
                db.execute('UPDATE sessions SET message_count=?,last_stamp=?,member_count=? WHERE id=?', (*stats, cid))
            for key, value in {'origin': origin, 'clock': str(clock), 'lastRefresh': str(int(time.time())),
                               'lastError': '', 'bootstrapped': '1'}.items():
                db.execute('INSERT OR REPLACE INTO state VALUES(?,?)', (key, value))
        return {'changedMessages': changed, **self.status()}

    def status(self):
        with self.connect() as db:
            state = dict(db.execute('SELECT key,value FROM state'))
            counts = db.execute('SELECT COUNT(*),COALESCE(SUM(message_count),0) FROM sessions').fetchone()
            return {'ready': state.get('bootstrapped') == '1', 'conversations': counts[0], 'messages': counts[1],
                    'lastRefresh': int(state.get('lastRefresh', 0)), 'error': state.get('lastError', '')}

    def fail(self, error):
        with self.connect() as db:
            db.execute("INSERT OR REPLACE INTO state VALUES('lastError',?)", (type(error).__name__,))

    def sessions(self):
        with self.connect() as db:
            return [dict(r) for r in db.execute('''SELECT id,name,'qq' AS platform,kind AS type,
                message_count AS messageCount,last_stamp AS lastMessageAt,member_count AS memberCount
                FROM sessions WHERE message_count>0 ORDER BY last_stamp DESC,id''')]

    def messages(self, session_id, since=0, offset=0, limit=5000):
        with self.connect() as db:
            db.execute('BEGIN')
            conv = db.execute('SELECT * FROM sessions WHERE id=?', (session_id,)).fetchone()
            if not conv:
                raise KeyError('Unknown conversation')
            # Observations and sequence numbers only increase. Keyset pagination also
            # preserves same-second insertions and avoids quadratic OFFSET scans.
            lower = db.execute('''SELECT seq FROM messages WHERE session_id=? AND observed>=?
                ORDER BY observed,seq LIMIT 1''', (session_id, since)).fetchone()
            start = max(offset, lower[0] - 1) if lower else None
            rows = [] if start is None else db.execute('''SELECT seq,observed,payload FROM messages
                WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?''', (session_id, start, limit + 1)).fetchall()
            selected, more = rows[:limit], len(rows) > limit
            messages = [json.loads(r['payload']) for r in selected]
            sync = {'hasMore': more}
            if more:
                sync['nextOffset'] = selected[-1]['seq']
            else:
                clock = db.execute("SELECT value FROM state WHERE key='clock'").fetchone()
                # Never outrun committed observations while a refresh is in flight.
                sync['nextSince'] = max(since, int(clock[0]) if clock else 0)
            return {'chatlab': {'version': '0.0.2', 'exportedAt': int(time.time()), 'generator': 'qq-local-chatlab'},
                    'meta': {'name': conv['name'], 'platform': 'qq', 'type': conv['kind'], 'groupId': session_id},
                    'members': list({m['sender']: {'platformId': m['sender'], 'accountName': m['accountName']}
                                     for m in messages}.values()), 'messages': messages, 'sync': sync}


def extract_new_rows(data, cache):
    """Build a small detached QQ database containing all unseen native IDs."""
    original = data / 'nt_msg.db'
    delta = data / 'delta.db'
    with sqlite3.connect(delta, uri=True) as db:
        db.execute('ATTACH DATABASE ? AS raw', (original.as_uri() + '?mode=ro',))
        db.execute('ATTACH DATABASE ? AS known', (cache.path.as_uri() + '?mode=ro',))
        for table in ('c2c_msg_table', 'group_msg_table'):
            db.execute(f'''CREATE TABLE "{table}" AS SELECT r.* FROM raw."{table}" r
                WHERE NOT EXISTS(SELECT 1 FROM known.messages m
                    WHERE m.native_table=? AND m.native_id=r."40001")''', (table,))
    os.replace(delta, original)


class QQSource:
    def __init__(self, config, cache):
        from qq_local_interface.vault import QQVault
        self.vault = QQVault(root=config['vaultRoot'], source_id=config['sourceId'])
        self.cache = cache
        self.signature = None

    def bootstrap(self):
        if not self.cache.status()['ready']:
            snapshot, manifest = self.vault.current()
            return self.cache.ingest(snapshot / 'records.db', manifest['origin'], bootstrap=True)

    def refresh(self):
        from qq_local_interface.index import build_index
        config = self.vault.config()
        source = Path(config['database_dir'])
        paths = [source / (name + suffix) for name in CORE_DATABASES for suffix in ('', '-wal', '-journal')]
        signature = [self.vault._signature(p) for p in paths + [Path(config['key_file'])]]
        if signature == self.signature:
            return {'unchanged': True, **self.cache.status()}
        with self.vault._writer(), tempfile.TemporaryDirectory(prefix='.refresh-', dir=self.cache.root) as temp:
            temp = Path(temp)
            encrypted, data = temp / 'encrypted', temp / 'data'
            encrypted.mkdir()
            data.mkdir()
            available, _ = self.vault._copy_stable(source, encrypted, CORE_DATABASES)
            keys = self.vault._keys(config['key_file'])
            for name in available:
                self.vault._decrypt(encrypted / name, data / name, keys, config['account'],
                                    encrypted / (name + '-wal') if (encrypted / (name + '-wal')).exists() else None)
            extract_new_rows(data, self.cache)
            build_index(data, temp / 'records.db', self.vault.source_id, config['account'], 'chatlab-delta')
            result = self.cache.ingest(temp / 'records.db', config['origin'])
        self.signature = signature
        return result


def make_server(cache, config):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            path = urlsplit(self.path)
            if path.path == '/health':
                return self.reply(200, cache.status())
            if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + config['token']):
                return self.reply(401, {'error': 'Unauthorized'})
            if not cache.status()['ready']:
                return self.reply(503, {'error': 'QQ snapshot unavailable; inspect /health'})
            try:
                query = parse_qs(path.query)
                limit = max(1, min(5000, int(query.get('limit', ['5000'])[0])))
                if path.path == '/api/v1/sessions':
                    sessions = cache.sessions()
                    keyword = query.get('keyword', [''])[0].casefold()
                    sessions = [s for s in sessions if keyword in s['name'].casefold()]
                    offset = int(query.get('cursor', ['0'])[0])
                    if offset < 0:
                        raise ValueError('Negative cursor')
                    return self.reply(200, {'sessions': sessions[offset:offset + limit],
                        'page': {'hasMore': offset + limit < len(sessions), 'nextCursor': str(offset + limit)}})
                parts = path.path.strip('/').split('/')
                if len(parts) == 5 and parts[:3] == ['api', 'v1', 'sessions'] and parts[4] == 'messages':
                    since, offset = int(query.get('since', ['0'])[0]), int(query.get('offset', ['0'])[0])
                    if since < 0 or offset < 0:
                        raise ValueError('Negative cursor')
                    return self.reply(200, cache.messages(unquote(parts[3]), since, offset, limit))
                return self.reply(404, {'error': 'Not found'})
            except (KeyError, ValueError):
                return self.reply(400, {'error': 'Invalid request'})

        def reply(self, status, value):
            body = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    return ThreadingHTTPServer(('127.0.0.1', config['port']), Handler)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['init', 'bootstrap', 'refresh', 'serve', 'status'])
    parser.add_argument('--home', type=Path, default=DEFAULT_HOME)
    parser.add_argument('--vault-root', type=Path, default=Path.home() / 'Library/Application Support/qq-local-interface')
    parser.add_argument('--source-id', default='personal-qq')
    parser.add_argument('--port', type=int, default=5035)
    parser.add_argument('--interval', type=int, default=300)
    args = parser.parse_args()
    config_path = args.home / 'config.json'
    if args.command == 'init':
        from qq_local_interface.util import atomic_json
        if config_path.exists():
            raise SystemExit('Bridge already configured; existing source and token preserved')
        atomic_json(config_path, {'vaultRoot': str(args.vault_root.resolve()), 'sourceId': args.source_id,
                                 'port': args.port, 'interval': args.interval, 'token': secrets.token_urlsafe(32)})
        print(json.dumps({'configured': True, 'port': args.port}))
        return
    config = json.loads(config_path.read_text())
    cache = Cache(args.home)
    if args.command == 'status':
        print(json.dumps(cache.status()))
        return
    source = QQSource(config, cache)
    result = source.bootstrap()
    if result:
        print(json.dumps(result), flush=True)
    if args.command == 'bootstrap':
        return

    def refresh():
        started = time.monotonic()
        try:
            result = source.refresh()
            if not result.get('unchanged'):
                print(json.dumps({**result, 'durationSeconds': round(time.monotonic() - started, 2)}), flush=True)
        except Exception as error:
            cache.fail(error)
            print(json.dumps({'refreshFailed': True, 'error': type(error).__name__}), flush=True)
            if args.command == 'refresh':
                raise SystemExit(1) from None

    if args.command == 'refresh':
        refresh()
        return
    stop = threading.Event()

    def loop():
        refresh()
        while not stop.wait(max(30, config['interval'])):
            refresh()

    server = make_server(cache, config)
    threading.Thread(target=loop, daemon=True).start()
    try:
        server.serve_forever()
    finally:
        stop.set()
        server.server_close()


if __name__ == '__main__':
    main()
