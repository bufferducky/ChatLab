#!/usr/bin/env python3
"""Compare cached Telegram messages with ChatLab; only report aggregate counts."""

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path

from bridge import DEFAULT_HOME, private_json


def audit(root, database_dir):
    config = json.loads((root / "config.json").read_text())
    base_url = f"http://127.0.0.1:{config['port']}/api/v1"
    source = sqlite3.connect(
        (root / "messages.sqlite3").resolve().as_uri() + "?mode=ro", uri=True
    )
    source.row_factory = sqlite3.Row
    expected_total = actual_total = mismatched_chats = mismatched_messages = 0
    try:
        sessions = source.execute("""SELECT s.*,COUNT(m.seq) AS count FROM sessions s
            JOIN messages m ON m.session_id=s.id GROUP BY s.id""").fetchall()
        for session in sessions:
            expected_total += session["count"]
            digest = hashlib.sha256(
                (base_url + "\0" + session["id"]).encode()
            ).hexdigest()[:12]
            target = database_dir / f"remote_{digest}.db"
            if not target.exists():
                mismatched_chats += 1
                mismatched_messages += session["count"]
                continue
            source.execute(
                "ATTACH DATABASE ? AS target", (target.resolve().as_uri() + "?mode=ro",)
            )
            try:
                actual = source.execute(
                    "SELECT COUNT(*) FROM target.message"
                ).fetchone()[0]
                actual_total += actual
                wrong = source.execute(
                    """SELECT COUNT(*) FROM target.message m
                    LEFT JOIN target.member u ON u.id=m.sender_id
                    LEFT JOIN main.messages c ON c.session_id=?
                        AND c.native_id=CAST(m.platform_message_id AS INTEGER)
                    WHERE c.seq IS NULL OR m.platform_message_id IS NOT CAST(c.native_id AS TEXT)
                      OR m.ts IS NOT c.stamp OR m.type IS NOT json_extract(c.payload,'$.type')
                      OR m.content IS NOT json_extract(c.payload,'$.content')
                      OR u.platform_id IS NOT c.sender
                      OR m.reply_to_message_id IS NOT json_extract(c.payload,'$.replyToMessageId')""",
                    (session["id"],),
                ).fetchone()[0]
                meta = source.execute(
                    "SELECT name,type FROM target.meta LIMIT 1"
                ).fetchone()
                mismatched_messages += wrong + max(0, session["count"] - actual)
                if (
                    wrong
                    or actual != session["count"]
                    or not meta
                    or tuple(meta) != (session["name"], session["kind"])
                ):
                    mismatched_chats += 1
            finally:
                source.execute("DETACH DATABASE target")
    finally:
        source.close()
    result = {
        "conversations": len(sessions),
        "expectedMessages": expected_total,
        "actualMessages": actual_total,
        "mismatchedConversations": mismatched_chats,
        "mismatchedMessages": mismatched_messages,
    }
    private_json(root / "content-verification.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=DEFAULT_HOME)
    parser.add_argument("--database-dir", type=Path, required=True)
    args = parser.parse_args()
    result = audit(args.home, args.database_dir)
    print(json.dumps(result))
    if result["mismatchedConversations"] or result["mismatchedMessages"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
