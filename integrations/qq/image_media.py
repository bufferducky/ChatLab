"""Serve QQ images from the local cache and complete misses through the QQ image bridge.

The local cache is always preferred: it works while QQ is offline and needs no
bridge. Only a cache miss asks the in-process QQ bridge to download the original
through the user's already logged-in client. The bridge never exposes arbitrary
paths, URLs or native calls; see IMAGE_BRIDGE_API.md.
"""

import base64
import hashlib
import json
import os
import re
import socket
import stat
import threading
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

MAX_IMAGE_BYTES = 50 * 1024 * 1024
BRIDGE_PROTOCOL_VERSION = "1"
BRIDGE_REQUEST_BYTES = 16 * 1024
BRIDGE_HEALTH_TIMEOUT = 5.0
BRIDGE_FETCH_TIMEOUT = 55.0
BRIDGE_DISCOVERY_BYTES = 4096

# Controlled error contract shared with the bridge and ChatLab. Status codes are
# the ones ChatLab may forward; unknown errors never borrow a code from here.
ERROR_STATUS = {
    "INVALID_IMAGE_REQUEST": 400,
    "UNAUTHORIZED": 401,
    "MESSAGE_NOT_FOUND": 404,
    "IMAGE_NOT_FOUND": 404,
    "QQ_IMAGE_UNAVAILABLE": 404,
    "QQ_ACCOUNT_MISMATCH": 409,
    "QQ_DATA_SOURCE_MISMATCH": 409,
    "IMAGE_REFERENCE_MISMATCH": 409,
    "IMAGE_TOO_LARGE": 413,
    "UNSUPPORTED_IMAGE": 415,
    "QQ_IMAGE_BUSY": 429,
    "QQ_DOWNLOAD_FAILED": 502,
    "IMAGE_INTEGRITY_FAILED": 502,
    "QQ_BRIDGE_UNAVAILABLE": 503,
    "QQ_OFFLINE": 503,
    "QQ_BRIDGE_INCOMPATIBLE": 503,
    "QQ_DOWNLOAD_TIMEOUT": 504,
}
# Codes that describe a state a simple retry cannot fix. QQ_OFFLINE and
# QQ_BRIDGE_UNAVAILABLE stay retryable once the user logs in or restarts QQ.
NON_RETRYABLE = {
    "INVALID_IMAGE_REQUEST",
    "UNAUTHORIZED",
    "MESSAGE_NOT_FOUND",
    "IMAGE_NOT_FOUND",
    "QQ_IMAGE_UNAVAILABLE",
    "QQ_ACCOUNT_MISMATCH",
    "QQ_DATA_SOURCE_MISMATCH",
    "IMAGE_REFERENCE_MISMATCH",
    "IMAGE_TOO_LARGE",
    "UNSUPPORTED_IMAGE",
    "QQ_BRIDGE_INCOMPATIBLE",
}
# Status fallback when a bridge response carries no usable code.
STATUS_CODE = {
    400: "INVALID_IMAGE_REQUEST",
    401: "UNAUTHORIZED",
    404: "IMAGE_NOT_FOUND",
    409: "IMAGE_REFERENCE_MISMATCH",
    413: "IMAGE_TOO_LARGE",
    415: "UNSUPPORTED_IMAGE",
    429: "QQ_IMAGE_BUSY",
    502: "QQ_DOWNLOAD_FAILED",
    503: "QQ_BRIDGE_UNAVAILABLE",
    504: "QQ_DOWNLOAD_TIMEOUT",
}
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


class QQImageError(Exception):
    """A controlled, page-safe image error with an explicit business code."""

    def __init__(self, status, code, message=None, retryable=None):
        self.status = status
        self.code = code
        self.message = message or _default_message(code)
        self.retryable = (
            retryable if isinstance(retryable, bool) else code not in NON_RETRYABLE
        )
        super().__init__(self.message)


DEFAULT_MESSAGES = {
    "INVALID_IMAGE_REQUEST": "Invalid image request",
    "UNAUTHORIZED": "Unauthorized",
    "MESSAGE_NOT_FOUND": "Message not found",
    "IMAGE_NOT_FOUND": "Image not found",
    "QQ_IMAGE_UNAVAILABLE": "QQ cannot provide this image",
    "QQ_ACCOUNT_MISMATCH": "QQ account differs from the data source account",
    "QQ_DATA_SOURCE_MISMATCH": "QQ uses a different account data directory",
    "IMAGE_REFERENCE_MISMATCH": "Image reference does not match the original message",
    "IMAGE_TOO_LARGE": "Image exceeds the size limit",
    "UNSUPPORTED_IMAGE": "Unsupported or damaged image",
    "QQ_IMAGE_BUSY": "QQ image download is busy",
    "QQ_DOWNLOAD_FAILED": "QQ image download failed",
    "IMAGE_INTEGRITY_FAILED": "Downloaded image failed integrity verification",
    "QQ_BRIDGE_UNAVAILABLE": "QQ image bridge is unavailable",
    "QQ_OFFLINE": "QQ is offline",
    "QQ_BRIDGE_INCOMPATIBLE": "QQ image bridge is incompatible with this QQ version",
    "QQ_DOWNLOAD_TIMEOUT": "QQ image download timed out",
}


def _default_message(code):
    return DEFAULT_MESSAGES.get(code, "Image unavailable")


def _clean_message(value):
    """Keep bridge-provided text short and free of control characters."""
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    return text[:200] if text else None


def bridge_error(status, body):
    """Translate one bridge error response into a controlled QQImageError."""
    code = message = retryable = None
    try:
        payload = json.loads(body.decode("utf-8"))
        if isinstance(payload, dict):
            code = payload.get("code")
            message = _clean_message(payload.get("error") or payload.get("message"))
            retryable = payload.get("retryable")
    except (AttributeError, UnicodeDecodeError, ValueError):
        pass
    if code not in ERROR_STATUS or ERROR_STATUS[code] != status:
        code = STATUS_CODE.get(status)
        if code is None:
            code, status = "QQ_DOWNLOAD_FAILED", 502
    return QQImageError(ERROR_STATUS[code], code, message, retryable)


def request(
    method,
    url,
    token,
    payload=None,
    timeout=BRIDGE_FETCH_TIMEOUT,
    limit=MAX_IMAGE_BYTES,
):
    """Call the loopback bridge with the ephemeral token and bounded I/O."""
    headers = {"Authorization": "Bearer " + token, "Accept": "application/octet-stream"}
    body = None
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if len(body) > BRIDGE_REQUEST_BYTES:
            raise QQImageError(413, "IMAGE_TOO_LARGE")
        headers["Content-Type"] = "application/json"
    try:
        with urlopen(
            Request(url, data=body, headers=headers, method=method), timeout=timeout
        ) as response:
            data = response.read(limit + 1)
            if len(data) > limit:
                raise QQImageError(413, "IMAGE_TOO_LARGE")
            return response.status, data, response.headers
    except HTTPError as error:
        try:
            detail = error.read(4096)
        except OSError:
            detail = b""
        raise bridge_error(error.code, detail) from None
    except TimeoutError:
        raise QQImageError(504, "QQ_DOWNLOAD_TIMEOUT") from None
    except URLError as error:
        if isinstance(error.reason, (TimeoutError, socket.timeout)):
            raise QQImageError(504, "QQ_DOWNLOAD_TIMEOUT") from None
        raise QQImageError(503, "QQ_BRIDGE_UNAVAILABLE") from None
    except OSError:
        raise QQImageError(503, "QQ_BRIDGE_UNAVAILABLE") from None


class QQBridge:
    """Discover and call the QQ image bridge advertised by the running client."""

    def __init__(self, home):
        self.path = Path(home) / "runtime" / "image-bridge.json" if home else None

    def discover(self):
        if self.path is None:
            raise QQImageError(503, "QQ_BRIDGE_UNAVAILABLE")
        try:
            info = self.path.lstat()
        except OSError:
            raise QQImageError(503, "QQ_BRIDGE_UNAVAILABLE") from None
        # The runtime file carries a live token: refuse links, special files and
        # group/world access instead of trusting a stale or replaced path.
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise QQImageError(503, "QQ_BRIDGE_UNAVAILABLE")
        if os.name == "posix" and stat.S_IMODE(info.st_mode) & 0o077:
            raise QQImageError(
                503,
                "QQ_BRIDGE_INCOMPATIBLE",
                "Bridge runtime file permissions are unsafe",
            )
        if info.st_size > BRIDGE_DISCOVERY_BYTES:
            raise QQImageError(
                503, "QQ_BRIDGE_INCOMPATIBLE", "Bridge runtime file is too large"
            )
        try:
            payload = json.loads(self.path.read_text("utf-8"))
        except (OSError, UnicodeDecodeError, ValueError):
            raise QQImageError(503, "QQ_BRIDGE_UNAVAILABLE") from None
        if not isinstance(payload, dict):
            raise QQImageError(503, "QQ_BRIDGE_INCOMPATIBLE")
        if payload.get("protocolVersion") != BRIDGE_PROTOCOL_VERSION:
            raise QQImageError(
                503, "QQ_BRIDGE_INCOMPATIBLE", "Unsupported bridge protocol version"
            )
        instance = payload.get("instanceId")
        if not isinstance(instance, str) or not instance:
            raise QQImageError(
                503, "QQ_BRIDGE_INCOMPATIBLE", "Bridge instance id is missing"
            )
        token = payload.get("token")
        # 32 random bytes are 43 urlsafe base64 characters; reject short tokens.
        if not isinstance(token, str) or len(token) < 43:
            raise QQImageError(503, "QQ_BRIDGE_INCOMPATIBLE", "Bridge token is invalid")
        location = urlsplit(
            payload.get("baseUrl") if isinstance(payload.get("baseUrl"), str) else ""
        )
        if (
            location.scheme != "http"
            or location.hostname not in LOOPBACK_HOSTS
            or location.port is None
            or location.username
            or location.password
            or location.query
            or location.fragment
            or location.path not in ("", "/")
        ):
            raise QQImageError(
                503, "QQ_BRIDGE_UNAVAILABLE", "Bridge address is not loopback"
            )
        return {
            "baseUrl": payload["baseUrl"].rstrip("/"),
            "token": token,
            "instanceId": instance,
        }

    @staticmethod
    def health(bridge):
        status, body, _headers = request(
            "GET",
            bridge["baseUrl"] + "/v1/health",
            bridge["token"],
            timeout=BRIDGE_HEALTH_TIMEOUT,
            limit=64 * 1024,
        )
        if status != 200:
            raise QQImageError(503, "QQ_BRIDGE_UNAVAILABLE")
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise QQImageError(
                503, "QQ_BRIDGE_INCOMPATIBLE", "Bridge health response is invalid"
            ) from None
        if not isinstance(payload, dict):
            raise QQImageError(
                503, "QQ_BRIDGE_INCOMPATIBLE", "Bridge health response is invalid"
            )
        if payload.get("protocolVersion") != BRIDGE_PROTOCOL_VERSION:
            raise QQImageError(
                503, "QQ_BRIDGE_INCOMPATIBLE", "Unsupported bridge protocol version"
            )
        if payload.get("instanceId") != bridge["instanceId"]:
            raise QQImageError(503, "QQ_BRIDGE_INCOMPATIBLE", "Bridge instance changed")
        return payload

    @staticmethod
    def check(health, config):
        """Verify readiness, account and account data directory before downloading."""
        if not health.get("sessionCaptured"):
            raise QQImageError(
                503, "QQ_BRIDGE_INCOMPATIBLE", "QQ session is not available"
            )
        if health.get("loggedIn") is not True:
            raise QQImageError(503, "QQ_OFFLINE")
        if health.get("ready") is not True:
            raise QQImageError(503, "QQ_BRIDGE_INCOMPATIBLE", "QQ bridge is not ready")
        capabilities = health.get("capabilities")
        if (
            not isinstance(capabilities, list)
            or "fetch-image-original" not in capabilities
        ):
            raise QQImageError(
                503, "QQ_BRIDGE_INCOMPATIBLE", "Bridge lacks original image support"
            )
        account = config.get("account") if isinstance(config, dict) else None
        expected_uin = str((account or {}).get("uin") or "")
        uin = health.get("accountUin")
        if not expected_uin.isdigit() or not isinstance(uin, str) or not uin.isdigit():
            raise QQImageError(503, "QQ_OFFLINE")
        if uin != expected_uin:
            raise QQImageError(409, "QQ_ACCOUNT_MISMATCH")
        directory = health.get("accountDataDir")
        if not isinstance(directory, str) or not directory:
            raise QQImageError(503, "QQ_OFFLINE")
        try:
            actual = Path(directory).resolve(strict=True)
            expected = Path(config["database_dir"]).resolve().parent
        except (KeyError, OSError, RuntimeError):
            raise QQImageError(409, "QQ_DATA_SOURCE_MISMATCH") from None
        if actual != expected:
            raise QQImageError(409, "QQ_DATA_SOURCE_MISMATCH")

    @staticmethod
    def fetch(bridge, chat_type, peer_uid, msg_id, image_index, expected_md5):
        status, body, headers = request(
            "POST",
            bridge["baseUrl"] + "/v1/images/fetch",
            bridge["token"],
            {
                "chatType": chat_type,
                "peerUid": peer_uid,
                "msgId": msg_id,
                "imageIndex": image_index,
                "expectedMd5": expected_md5,
            },
        )
        if status != 200:
            raise QQImageError(502, "QQ_DOWNLOAD_FAILED")
        actual = hashlib.md5(body).hexdigest()
        if actual != expected_md5 and not (
            headers.get("X-QQ-Image-Verification") == "native-image-v1"
            and headers.get("X-QQ-Image-Reference-MD5") == expected_md5
            and headers.get("X-QQ-Image-Content-MD5") == actual
        ):
            raise QQImageError(502, "IMAGE_INTEGRITY_FAILED")
        return body


class QQImages:
    def __init__(self, source):
        self.source = source
        self.lock = threading.Lock()
        self.inventory = []
        self.scanned_at = 0
        self.bridge = QQBridge(getattr(getattr(source, "cache", None), "root", None))

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
            raise QQImageError(404, "MESSAGE_NOT_FOUND")
        if metadata:
            return json.loads(metadata[0])
        snapshot, manifest = self.source.vault.current()
        prefix = f"qq:{manifest['origin']}:"
        if not mid.startswith(prefix):
            raise QQImageError(404, "MESSAGE_NOT_FOUND")
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
        if size not in ("preview", "original"):
            raise QQImageError(400, "INVALID_IMAGE_REQUEST")
        if (
            not isinstance(index, int)
            or isinstance(index, bool)
            or not 0 <= index < len(attachments)
        ):
            raise QQImageError(404, "IMAGE_NOT_FOUND")
        attachment = attachments[index]
        root, roots = self.cache_roots()
        cached = self.local(attachment, root, roots, size)
        if cached is not None:
            return cached
        return self.online(sid, mid, index, attachment, size)

    def cache_roots(self):
        root = Path(self.source.vault.config()["database_dir"]).parent
        roots = [
            directory.resolve()
            for name in ("nt_data", "nt_temp")
            if (directory := root / name).is_dir()
        ]
        return root, roots

    def local(self, attachment, root, roots, size):
        """Return cached QQ bytes, or None when the account cache has no match."""
        for native in attachment.get("native_paths", []):
            path = Path(native)
            if not path.is_absolute():
                path = root / path
            try:
                return self.read(path, roots)
            except (KeyError, FileNotFoundError):
                continue
        hashes = self.expected_md5(attachment)
        if not hashes:
            return None
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
            thumbnails, key=lambda p: int(p.stem.rsplit("_", 1)[1]), reverse=True
        ):
            try:
                return self.read(path, roots)
            except (KeyError, FileNotFoundError):
                continue
        return None

    def online(self, sid, mid, index, attachment, size):
        hashes = self.expected_md5(attachment)
        if not hashes:
            raise QQImageError(
                409, "IMAGE_REFERENCE_MISMATCH", "Original image checksum is missing"
            )
        with self.source.cache.connect() as db:
            message = db.execute(
                "SELECT native_id FROM messages WHERE session_id=? AND id=?", (sid, mid)
            ).fetchone()
            session = db.execute(
                "SELECT kind,native_id FROM sessions WHERE id=?", (sid,)
            ).fetchone()
        if not message or not message["native_id"]:
            raise QQImageError(404, "MESSAGE_NOT_FOUND")
        # Preview misses download the original once; ChatLab resizes it and caches
        # the WebP preview. QQ's native thumbnail API is not part of this version.
        chat_type = 2 if session and session["kind"] == "group" else 1
        peer = (session["native_id"] if session else None) or self.conversation_peer(
            sid
        )
        if not peer:
            raise QQImageError(404, "MESSAGE_NOT_FOUND")
        config = self.source.vault.config()
        bridge = self.bridge.discover()
        health = self.bridge.health(bridge)
        self.bridge.check(health, config)
        expected = self.primary_md5(attachment, hashes)
        data = self.bridge.fetch(
            bridge, chat_type, str(peer), str(message["native_id"]), index, expected
        )
        if not data:
            raise QQImageError(
                502, "IMAGE_INTEGRITY_FAILED", "Bridge returned no image bytes"
            )
        # QQBridge verifies the archived reference separately from the actual
        # bytes of QQ's full-size variant. Do not compare those two hashes again.
        from qq_local_interface.assets import media_type

        if media_type(Path("image.bin"), data[:64])[0] != "image":
            raise QQImageError(415, "UNSUPPORTED_IMAGE")
        return data

    def conversation_peer(self, sid):
        """Resolve the native conversation id once, then remember it in the cache."""
        from qq_local_interface.util import readonly

        try:
            snapshot, _manifest = self.source.vault.current()
            with readonly(snapshot / "records.db") as db:
                row = db.execute(
                    "SELECT payload FROM conversations WHERE id=?", (sid,)
                ).fetchone()
            if not row:
                return None
            value = json.loads(row[0]).get("native_id")
        except Exception:  # noqa: BLE001 -- Missing snapshots fall back to the archived message peer.
            return None
        if value in (None, ""):
            return None
        value = str(value)
        with self.source.cache.connect() as db:
            db.execute("UPDATE sessions SET native_id=? WHERE id=?", (value, sid))
        return value

    @staticmethod
    def expected_md5(attachment):
        hashes = set()
        identifiers = attachment.get("native_identifiers") or {}
        if isinstance(identifiers, dict):
            for value in identifiers.values():
                try:
                    raw = base64.b64decode(value, validate=True)
                except (TypeError, ValueError):
                    continue
                if len(raw) == 16:
                    hashes.add(raw.hex())
        stem = Path(str(attachment.get("name") or "")).stem
        if re.fullmatch(r"[a-fA-F0-9]{32}", stem):
            hashes.add(stem.lower())
        return hashes

    @staticmethod
    def primary_md5(attachment, hashes):
        """Pick the most authoritative original MD5 for one bridge request."""
        for key in ("45406",):
            value = (attachment.get("native_identifiers") or {}).get(key)
            try:
                raw = base64.b64decode(value, validate=True)
            except (TypeError, ValueError):
                continue
            if len(raw) == 16 and raw.hex() in hashes:
                return raw.hex()
        stem = Path(str(attachment.get("name") or "")).stem
        if re.fullmatch(r"[a-fA-F0-9]{32}", stem) and stem.lower() in hashes:
            return stem.lower()
        return min(hashes)

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
