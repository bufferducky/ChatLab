#!/usr/bin/env python3
"""Read the installed wecom-agent snapshots and expose a local ChatLab Pull source."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import sqlite3
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

DEFAULT_HOME = Path.home() / '.local/share/chatlab-wecom'
TYPE_MAP = {0: 0, 2: 0, 6: 0, 14: 1, 15: 4, 16: 2, 29: 5, 40: 23,
            13: 7, 38: 80, 501: 80, 503: 80, 1011: 80, 1001: 80,
            1002: 80, 1006: 80, 1018: 80, 1022: 80, 1051: 80, 1052: 80}


def private_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Cache:
    """Persist source identities and observation times so late history is not skipped."""

    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.root / 'messages.sqlite3'
        self.lock = threading.RLock()
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, name TEXT, kind TEXT);
                CREATE TABLE IF NOT EXISTS messages(
                    id TEXT PRIMARY KEY, session_id TEXT, signature TEXT,
                    observed INTEGER, stamp INTEGER, payload TEXT);
                CREATE INDEX IF NOT EXISTS by_session ON messages(session_id, observed, id);
                CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT);
            ''')
        self.path.chmod(0o600)

    @contextlib.contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def ingest(self, account, conversations, rows, renderer, cards=(), now=None):
        seen, changed, unknown = 0, 0, 0
        with self.lock, self.connect() as db:
            previous = db.execute("SELECT value FROM state WHERE key='account'").fetchone()
            if previous and previous[0] != account:
                raise ValueError('Source account changed; use a separate bridge directory')
            db.execute("INSERT OR REPLACE INTO state VALUES('account',?)", (account,))
            clock = int(time.time() if now is None else now)
            old_clock = db.execute("SELECT MAX(observed) FROM messages").fetchone()[0] or 0
            clock = max(clock, old_clock)
            names = {str(c['id']): c for c in conversations}
            existing = {r['id']: r['signature'] for r in db.execute('SELECT id,signature FROM messages')}
            for row in rows:
                seen += 1
                cid = str(row['conv_id'])
                session_id = f'{account}-{cid}'
                conv = names.get(cid, {'name': row['conversation'], 'kind': 'private'})
                db.execute('INSERT OR REPLACE INTO sessions VALUES(?,?,?)',
                           (session_id, str(conv['name']), conv['kind']))
                # Use LID rather than display names or timestamps. Zero/duplicate server RIDs exist.
                mid = f"wecom:{account}:{cid}:{row['local_id']}"
                code = row['type_code']
                kind = TYPE_MAP.get(code, 7 if code in cards else 99)
                if kind == 99:
                    unknown += 1
                stamp = int(row['send_time'])
                if stamp > 20_000_000_000:
                    stamp //= 1000
                if stamp < 0:
                    raise ValueError('Negative source timestamp')
                clock = max(clock, stamp)
                signature = hashlib.sha256(json.dumps([
                    str(row['sender_id']), stamp, code, row['sender'],
                    bytes(row['_raw']).hex() if isinstance(row['_raw'], (bytes, bytearray)) else row['_raw'],
                ], ensure_ascii=False).encode()).hexdigest()
                if existing.get(mid) == signature:
                    continue
                content = renderer(code, row['_raw'])
                if not isinstance(content, str):
                    content = str(content) if content is not None else f'[WeCom type {code}]'
                payload = {'platformMessageId': mid, 'sender': str(row['sender_id']),
                           'accountName': row['sender'], 'timestamp': stamp,
                           'type': kind, 'content': content}
                db.execute('INSERT OR REPLACE INTO messages VALUES(?,?,?,?,?,?)',
                           (mid, session_id, signature, clock, stamp, json.dumps(payload, ensure_ascii=False)))
                changed += 1
            db.execute("INSERT OR REPLACE INTO state VALUES('lastRefresh',?)", (str(int(time.time())),))
            db.execute("INSERT OR REPLACE INTO state VALUES('lastError','')")
        return {'sourceMessages': seen, 'changedMessages': changed, 'unknownTypes': unknown}

    def status(self):
        with self.lock, self.connect() as db:
            state = dict(db.execute('SELECT key,value FROM state'))
            return {'ready': bool(state.get('lastRefresh')) and not state.get('lastError'),
                    'lastRefresh': int(state.get('lastRefresh', 0)),
                    'error': state.get('lastError', ''),
                    'conversations': db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0],
                    'messages': db.execute('SELECT COUNT(*) FROM messages').fetchone()[0]}

    def fail(self, error):
        # Never log key material, message bodies, or raw exceptions from upstream tools.
        with self.lock, self.connect() as db:
            db.execute("INSERT OR REPLACE INTO state VALUES('lastError',?)", (type(error).__name__,))

    def sessions(self):
        with self.lock, self.connect() as db:
            return [dict(r) for r in db.execute('''
                SELECT s.id,s.name,'wecom' AS platform,s.kind AS type,
                  COUNT(m.id) AS messageCount, MAX(m.stamp) AS lastMessageAt,
                  COUNT(DISTINCT json_extract(m.payload,'$.sender')) AS memberCount
                FROM sessions s JOIN messages m ON m.session_id=s.id
                GROUP BY s.id ORDER BY lastMessageAt DESC,s.id
            ''')]

    def messages(self, session_id, since=0, offset=0, limit=1000):
        with self.lock, self.connect() as db:
            conv = db.execute('SELECT * FROM sessions WHERE id=?', (session_id,)).fetchone()
            if not conv:
                raise KeyError('Unknown conversation')
            # since is an observation-time cursor, not the original message timestamp.
            # Offset pagination preserves every message when many arrive in the same second.
            rows = db.execute('''SELECT payload,observed FROM messages
                WHERE session_id=? AND observed>=? ORDER BY observed,id LIMIT ? OFFSET ?''',
                              (session_id, since, limit + 1, offset)).fetchall()
            more = len(rows) > limit
            selected = rows[:limit]
            messages = [json.loads(r['payload']) for r in selected]
            messages.sort(key=lambda m: (m['timestamp'], m['platformMessageId']))
            result = {'chatlab': {'version': '0.0.2', 'exportedAt': int(time.time()),
                                  'generator': 'wecom-agent-chatlab'},
                      'messages': messages, 'sync': {'hasMore': more}}
            if more:
                result['sync']['nextOffset'] = offset + len(selected)
            else:
                result['sync']['nextSince'] = max([since, int(time.time())] + [r['observed'] for r in selected])
            if since == 0:
                members = {m['sender']: {'platformId': m['sender'], 'accountName': m['accountName']}
                           for m in messages}
                # ChatLab detects the format and metadata from the file head.
                result = {'chatlab': {'version': '0.0.2', 'exportedAt': int(time.time()),
                                      'generator': 'wecom-agent-chatlab'},
                          'meta': {'name': conv['name'], 'platform': 'wecom',
                                   'type': conv['kind'], 'groupId': session_id},
                          'members': list(members.values()), **result}
            return result


class WeComSource:
    def __init__(self, config, cache):
        self.config, self.cache = config, cache
        source = Path(config['wecomSource']).expanduser().resolve()
        sys.path[:0] = [str(source), str(source / 'decrypt/macos')]
        from decrypt import export_wxwork as ex
        from decrypt.local_query import MessageStore
        from decrypt.wxwork_crypto import PAGE_SZ, SQLITE_HDR, decrypt_database, load_valid_keys
        self.ex, self.store = ex, MessageStore
        self.page_size, self.header = PAGE_SZ, SQLITE_HDR
        self.decrypt, self.keys = decrypt_database, load_valid_keys
        self.signature = None

    def refresh(self):
        profile = Path(self.config['profile']).expanduser().resolve()
        paths = [profile / 'Messages1' / name for name in ('Info.db', 'Session.db')]
        inputs = paths + [Path(str(p) + '-wal') for p in paths] + [Path(self.config['keyFile'])]
        signature = [(str(p), p.stat().st_size, p.stat().st_mtime_ns) if p.exists() else (str(p), None)
                     for p in inputs]
        if self.signature == signature:
            return {'unchanged': True, **self.cache.status()}
        with tempfile.TemporaryDirectory(prefix='.snapshot-', dir=self.cache.root) as directory:
            for original in paths:
                with original.open('rb') as stream:
                    header = stream.read(self.page_size)
                keys = self.keys(self.config['keyFile'], header)
                if not keys and not header.startswith(self.header):
                    raise ValueError('Existing WeCom key is no longer valid')
                self.decrypt(original, Path(directory) / original.name, keys[0] if keys else None)
            info = Path(directory) / 'Info.db'
            from decrypt.local_io import connect_readonly
            with contextlib.closing(connect_readonly(info)) as db:
                store = self.store(db, users=self.ex._load_user_names(str(info)))
                types = {str(r[0]): r[1] for r in db.execute('SELECT RID,conversationtype FROM CONVERSATION')}
                conversations = [{**c, 'kind': 'group' if types.get(c['id']) == 1 else 'private'}
                                 for c in store.conversations()]
                account = hashlib.sha256(str(profile).encode()).hexdigest()[:20]
                # Let Cache render only new/changed rows instead of reparsing every body on each poll.
                def rows():
                    for row in db.execute('SELECT LID,RID,conv_id,sender_id,content_type,send_time,content FROM MESSAGE'):
                        cid, sid = row['conv_id'], row['sender_id']
                        yield {'conv_id': str(cid), 'conversation': str(store.names.get(cid, cid)),
                               'sender_id': sid, 'sender': str(store.sender(sid)),
                               'local_id': row['LID'], 'type_code': row['content_type'],
                               'send_time': row['send_time'], '_raw': row['content']}
                result = self.cache.ingest(account, conversations, rows(), self.ex.render, self.ex.CARD_TYPES)
        self.signature = signature
        return {**result, **self.cache.status()}


def make_server(cache, config):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            path = urlsplit(self.path)
            if path.path == '/health':
                return self.reply(200, cache.status())
            supplied = self.headers.get('Authorization', '')
            if not hmac.compare_digest(supplied, 'Bearer ' + config['token']):
                return self.reply(401, {'error': 'Unauthorized'})
            if not cache.status()['ready']:
                return self.reply(503, {'error': 'WeCom snapshot unavailable; inspect /health'})
            try:
                query = parse_qs(path.query)
                if path.path == '/api/v1/sessions':
                    sessions = cache.sessions()
                    keyword = query.get('keyword', [''])[0].casefold()
                    sessions = [s for s in sessions if keyword in s['name'].casefold()]
                    limit = max(1, min(5000, int(query.get('limit', ['5000'])[0])))
                    offset = int(query.get('cursor', ['0'])[0])
                    if offset < 0:
                        raise ValueError('Negative cursor')
                    return self.reply(200, {'sessions': sessions[offset:offset + limit],
                                           'page': {'hasMore': offset + limit < len(sessions),
                                                    'nextCursor': str(offset + limit)}})
                parts = path.path.strip('/').split('/')
                if len(parts) == 5 and parts[:3] == ['api', 'v1', 'sessions'] and parts[4] == 'messages':
                    since = int(query.get('since', ['0'])[0])
                    offset = int(query.get('offset', ['0'])[0])
                    limit = max(1, min(5000, int(query.get('limit', ['1000'])[0])))
                    if since < 0 or offset < 0:
                        raise ValueError('Negative cursor')
                    return self.reply(200, cache.messages(unquote(parts[3]), since, offset, limit))
                self.reply(404, {'error': 'Not found'})
            except (ValueError, KeyError):
                self.reply(400, {'error': 'Invalid request'})

        def reply(self, status, value):
            body = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return ThreadingHTTPServer(('127.0.0.1', config['port']), Handler)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['init', 'refresh', 'serve', 'status'])
    parser.add_argument('--home', type=Path, default=DEFAULT_HOME)
    parser.add_argument('--wecom-source', type=Path, default=Path.home() / '.local/share/wecom-agent/source')
    parser.add_argument('--port', type=int, default=5034)
    parser.add_argument('--interval', type=int, default=30)
    args = parser.parse_args()
    config_path = args.home / 'config.json'
    if args.command == 'init':
        if config_path.exists():
            raise SystemExit('Bridge already configured; existing account and token preserved')
        sys.path.insert(0, str(args.wecom_source / 'decrypt/macos'))
        from wecom_paths import profile_dir
        private_json(config_path, {'wecomSource': str(args.wecom_source.resolve()),
                                  'profile': profile_dir(), 'port': args.port,
                                  'keyFile': str(args.wecom_source / 'decrypt/macos/wxwork_keys.json'),
                                  'token': secrets.token_urlsafe(32), 'interval': args.interval})
        print(json.dumps({'configured': True, 'port': args.port}))
        return
    config = json.loads(config_path.read_text())
    cache = Cache(args.home)
    if args.command == 'status':
        print(json.dumps(cache.status()))
        return
    source = WeComSource(config, cache)

    def refresh():
        try:
            result = source.refresh()
            if not result.get('unchanged'):
                print(json.dumps(result), flush=True)
        except Exception as error:
            cache.fail(error)
            source.signature = None
            print(json.dumps({'ready': False, 'error': type(error).__name__}), flush=True)
            if args.command == 'refresh':
                raise SystemExit(1) from None

    refresh()
    if args.command == 'refresh':
        return
    stop = threading.Event()

    def loop():
        while not stop.wait(max(5, config['interval'])):
            refresh()

    threading.Thread(target=loop, daemon=True).start()
    server = make_server(cache, config)
    try:
        server.serve_forever()
    finally:
        stop.set()
        server.server_close()


if __name__ == '__main__':
    main()
