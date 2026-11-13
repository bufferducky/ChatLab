"""Read images from the selected QQ account's existing local cache."""

import base64
import hashlib
import json
import os
import re
import stat
import threading
import time
from pathlib import Path

MAX_IMAGE_BYTES = 50 * 1024 * 1024


class QQImages:
    def __init__(self, source):
        self.source = source
        self.lock = threading.Lock()
        self.inventory = []
        self.scanned_at = 0

    def metadata(self, sid, mid):
        cache = self.source.cache
        with cache.connect() as db:
            row = db.execute(
                "SELECT payload FROM messages WHERE session_id=? AND id=?", (sid, mid)
            ).fetchone()
            metadata = db.execute(
                "SELECT payload FROM image_metadata WHERE id=?", (mid,)
            ).fetchone()
        if not row:
            raise KeyError("Unknown image message")
        if metadata:
            return json.loads(metadata[0])
        snapshot, manifest = self.source.vault.current()
        prefix = f"qq:{manifest['origin']}:"
        if not mid.startswith(prefix):
            raise KeyError("Unknown image message")
        from qq_local_interface.util import readonly

        with readonly(snapshot / "records.db") as db:
            item = db.execute(
                "SELECT payload FROM messages WHERE id=?", (mid[len(prefix) :],)
            ).fetchone()
        if item:
            return json.loads(item[0])
        # Deployed bridge records omitted attachments. Its content still contains
        # native paths/names; resolve these only against the selected cache inventory.
        content = json.loads(row[0]).get("content") or ""
        names = [
            line.strip()
            for line in content.splitlines()
            if re.search(r"\.(?:jpe?g|png|gif|webp)$", line.strip(), re.IGNORECASE)
        ]
        return {
            "text": "",
            "attachments": [
                {"kind": "image", "name": Path(n).name, "native_paths": [n]}
                for n in names
            ],
        }

    def resolve(self, sid, mid, index=None, size="original"):
        item = self.metadata(sid, mid)
        attachments = [
            a for a in item.get("attachments", []) if a.get("kind") == "image"
        ]
        if index is None:
            return {
                "images": [{"index": i} for i in range(len(attachments))],
                "caption": item.get("text") or "",
            }
        if not 0 <= index < len(attachments):
            raise KeyError("Unknown image")
        root = Path(self.source.vault.config()["database_dir"]).parent
        roots = [
            directory.resolve()
            for name in ("nt_data", "nt_temp")
            if (directory := root / name).is_dir()
        ]
        attachment = attachments[index]
        for native in attachment.get("native_paths", []):
            path = Path(native)
            if not path.is_absolute():
                path = root / path
            try:
                return self.read(path, roots)
            except (KeyError, FileNotFoundError):
                continue
        hashes = set()
        for value in attachment.get("native_identifiers", {}).values():
            raw = base64.b64decode(value)
            if len(raw) == 16:
                hashes.add(raw.hex())
        name = attachment.get("name") or ""
        if re.fullmatch(r"[a-fA-F0-9]{32}", Path(name).stem):
            hashes.add(Path(name).stem.lower())
        if not hashes:
            raise KeyError("Image not cached")
        with self.lock:
            if not self.scanned_at or time.monotonic() - self.scanned_at > 300:
                # Only inventory names. Opening every cached file delayed the
                # first image on large accounts; inspect bytes after matching.
                self.inventory = []
                for directory in roots:
                    for current, subdirs, files in os.walk(
                        directory, followlinks=False
                    ):
                        subdirs[:] = [
                            name
                            for name in subdirs
                            if not (Path(current) / name).is_symlink()
                        ]
                        self.inventory.extend(Path(current) / name for name in files)
                self.scanned_at = time.monotonic()
            candidates = [
                path for path in self.inventory if path.stem.lower() in hashes
            ]
            thumbnails = (
                [
                    path
                    for path in self.inventory
                    if path.parent.name == "Thumb"
                    and re.fullmatch(r"[a-fA-F0-9]{32}_\d{1,5}", path.stem)
                    and path.stem[:32].lower() in hashes
                ]
                if size == "preview"
                else []
            )
        # QQ keeps identical originals in Pic and Emoji. Verify the content hash
        # instead of rejecting duplicate copies or trusting an arbitrary filename.
        for path in candidates:
            try:
                data = self.read(path, roots)
            except (KeyError, FileNotFoundError):
                continue
            # A unique cache path keeps the existing lookup behavior: QQ may
            # re-encode a cached original without renaming its message hash.
            if len(candidates) == 1 or hashlib.md5(data).hexdigest() in hashes:
                return data
        # QQ's Thumb/<MD5>_<size> files belong to that original, but have their
        # own bytes. They may serve previews only, never requests for originals.
        for path in sorted(
            thumbnails,
            key=lambda p: int(p.stem.rsplit("_", 1)[1]),
            reverse=True,
        ):
            try:
                return self.read(path, roots)
            except (KeyError, FileNotFoundError):
                continue
        raise KeyError("Image not cached")

    @staticmethod
    def read(path, roots):
        resolved = path.resolve(strict=True)
        if path.is_symlink() or not any(root in resolved.parents for root in roots):
            raise KeyError("Image outside selected account cache")
        from qq_local_interface.assets import file_signature, media_type

        before = resolved.stat()
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_IMAGE_BYTES:
            raise KeyError("Image unavailable or too large")
        fd = os.open(resolved, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as stream:
            if file_signature(os.fstat(stream.fileno())) != file_signature(before):
                raise KeyError("Image cache changed")
            data = stream.read(MAX_IMAGE_BYTES + 1)
            if len(data) > MAX_IMAGE_BYTES or file_signature(
                os.fstat(stream.fileno())
            ) != file_signature(before):
                raise KeyError("Image cache changed")
            if media_type(resolved, data[:64])[0] != "image":
                raise KeyError("Unsupported image cache")
            return data
