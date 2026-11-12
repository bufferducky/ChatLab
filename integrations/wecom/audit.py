#!/usr/bin/env python3
"""Compare every cached message with its imported ChatLab row; print counts only."""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3


def readonly(path):
    db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    return db


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path.home() / '.local/share/chatlab-wecom')
    parser.add_argument('--database-dir', type=Path, required=True)
    args = parser.parse_args()
    config = json.loads((args.home / 'config.json').read_text())
    base_url = f"http://127.0.0.1:{config['port']}/api/v1"
    source = readonly(args.home / 'messages.sqlite3')
    expected_total = actual_total = mismatched_chats = mismatched_messages = 0
    sessions = source.execute('SELECT * FROM sessions').fetchall()
    for session in sessions:
        digest = hashlib.sha256((base_url + '\0' + session['id']).encode()).hexdigest()[:12]
        target_path = args.database_dir / f'remote_{digest}.db'
        expected = {}
        for row in source.execute('SELECT payload FROM messages WHERE session_id=?', (session['id'],)):
            message = json.loads(row[0])
            expected[message['platformMessageId']] = (message['timestamp'], message['type'],
                                                    message['content'], message['sender'])
        expected_total += len(expected)
        if not target_path.exists():
            mismatched_chats += 1
            mismatched_messages += len(expected)
            continue
        target = readonly(target_path)
        actual = {row['platform_message_id']: (row['ts'], row['type'], row['content'], row['platform_id'])
                  for row in target.execute('''SELECT m.platform_message_id,m.ts,m.type,m.content,u.platform_id
                    FROM message m LEFT JOIN member u ON m.sender_id=u.id''')}
        actual_count = target.execute('SELECT COUNT(*) FROM message').fetchone()[0]
        actual_total += actual_count
        wrong = sum(expected.get(mid) != actual.get(mid) for mid in expected.keys() | actual.keys())
        mismatched_messages += wrong
        meta = target.execute('SELECT name,type FROM meta LIMIT 1').fetchone()
        if wrong or actual_count != len(expected) or not meta or meta['name'] != session['name'] or meta['type'] != session['kind']:
            mismatched_chats += 1
        target.close()
    source.close()
    result = {'conversations': len(sessions), 'expectedMessages': expected_total,
              'actualMessages': actual_total, 'mismatchedConversations': mismatched_chats,
              'mismatchedMessages': mismatched_messages}
    output = args.home / 'content-verification.json'
    output.write_text(json.dumps(result, indent=2))
    output.chmod(0o600)
    print(json.dumps(result))
    if mismatched_chats or mismatched_messages:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
