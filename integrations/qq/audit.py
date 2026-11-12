#!/usr/bin/env python3
"""Verify every QQ message against ChatLab without printing private content."""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path.home() / '.local/share/chatlab-qq')
    parser.add_argument('--database-dir', type=Path, required=True)
    args = parser.parse_args()
    config = json.loads((args.home / 'config.json').read_text())
    base_url = f"http://127.0.0.1:{config['port']}/api/v1"
    source = sqlite3.connect((args.home / 'messages.sqlite3').resolve().as_uri() + '?mode=ro', uri=True)
    source.row_factory = sqlite3.Row
    expected_total = actual_total = mismatched_chats = mismatched_messages = 0
    try:
        sessions = source.execute('SELECT * FROM sessions WHERE message_count>0').fetchall()
        for session in sessions:
            expected_total += session['message_count']
            digest = hashlib.sha256((base_url + '\0' + session['id']).encode()).hexdigest()[:12]
            target = args.database_dir / f'remote_{digest}.db'
            if not target.exists():
                mismatched_chats += 1
                mismatched_messages += session['message_count']
                continue
            source.execute('ATTACH DATABASE ? AS target', (target.resolve().as_uri() + '?mode=ro',))
            try:
                actual = source.execute('SELECT COUNT(*) FROM target.message').fetchone()[0]
                actual_total += actual
                wrong = source.execute('''SELECT COUNT(*) FROM target.message m
                    LEFT JOIN target.member u ON u.id=m.sender_id
                    LEFT JOIN main.messages c ON c.id=m.platform_message_id AND c.session_id=?
                    WHERE c.id IS NULL OR m.ts IS NOT c.stamp
                      OR m.type IS NOT json_extract(c.payload,'$.type')
                      OR m.content IS NOT json_extract(c.payload,'$.content')
                      OR u.platform_id IS NOT c.sender''', (session['id'],)).fetchone()[0]
                meta = source.execute('SELECT name,type FROM target.meta LIMIT 1').fetchone()
                mismatched_messages += wrong + max(0, session['message_count'] - actual)
                if wrong or actual != session['message_count'] or not meta or tuple(meta) != (session['name'], session['kind']):
                    mismatched_chats += 1
            finally:
                source.execute('DETACH DATABASE target')
    finally:
        source.close()
    result = {'conversations': len(sessions),
              'expectedMessages': expected_total, 'actualMessages': actual_total,
              'mismatchedConversations': mismatched_chats, 'mismatchedMessages': mismatched_messages}
    output = args.home / 'content-verification.json'
    output.write_text(json.dumps(result, indent=2))
    output.chmod(0o600)
    print(json.dumps(result))
    if mismatched_chats or mismatched_messages:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
