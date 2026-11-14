"""Account-wide media admission at RPC boundaries, with shared cancellable jobs."""

import asyncio
import contextlib
import itertools
import json
import math
import time
from contextvars import ContextVar
from dataclasses import dataclass, field

media_job = ContextVar("telegram_media_job", default=None)
_admitted_task = ContextVar("telegram_media_admitted_task", default=None)


class MediaRateLimited(RuntimeError):
    def __init__(self, seconds):
        self.retry_after = max(1, math.ceil(seconds))
        super().__init__("Telegram media cooling down")


class MediaTimeout(TimeoutError):
    def __init__(self, phase):
        self.phase = phase
        super().__init__(f"Image {phase} timed out")


@dataclass(eq=False)
class MediaJob:
    subscribers: dict = field(default_factory=dict)
    task: object = None
    large: bool = True
    network_seconds: float = 0
    queue_seconds: float = 0
    requests: int = 0
    best_priority: int = 3
    conversion_seconds: float = 0
    cache_seconds: float = 0

    @property
    def priority(self):
        return min(
            (
                v.priority if isinstance(v, MediaJob) else v
                for v in self.subscribers.values()
            ),
            default=3,
        )


class MediaScheduler:
    def __init__(self, cache):
        self.cache = cache
        self.jobs = {}
        self.condition = asyncio.Condition()
        self.waiters = []
        self.sequence = itertools.count()
        self.active = []
        self.small_limit = self.large_limit = self.total_limit = 1
        self.background_paused = False
        self.promotions = 0

    def configure(self, small, large):
        if (
            isinstance(small, (int, float))
            and small > 0
            and isinstance(large, (int, float))
            and large > 0
        ):
            self.small_limit = min(2, int(small))
            self.large_limit = min(1, int(large))
            self.total_limit = 2

    def check_cooldown(self):
        remaining = self.cache.status()["retryAfter"] - time.time() if self.cache else 0
        if remaining > 0:
            raise MediaRateLimited(remaining)

    async def changed(self):
        async with self.condition:
            self.condition.notify_all()

    async def run(self, key, priority, operation):
        job = self.jobs.get(key)
        if job is None:
            job = MediaJob()
            self.jobs[key] = job

            async def execute():
                token = media_job.set(job)
                started = time.monotonic()
                error_type = ""
                try:
                    # Queue and per-RPC budgets are separate; keep an outer deadline.
                    async with asyncio.timeout(60):
                        return await operation()
                except TimeoutError as error:
                    error_type = type(error).__name__
                    if isinstance(error, MediaTimeout):
                        raise
                    raise MediaTimeout(
                        "queue" if not job.requests else "processing"
                    ) from None
                except BaseException as error:
                    error_type = type(error).__name__
                    raise
                finally:
                    if job.best_priority < 2:
                        print(
                            json.dumps(
                                {
                                    "event": "telegramMediaTask",
                                    "priority": job.best_priority,
                                    "totalSeconds": round(
                                        time.monotonic() - started, 3
                                    ),
                                    "queueSeconds": round(job.queue_seconds, 3),
                                    "networkSeconds": round(job.network_seconds, 3),
                                    "conversionSeconds": round(
                                        job.conversion_seconds, 3
                                    ),
                                    "cacheSeconds": round(job.cache_seconds, 3),
                                    "rpcRequests": job.requests,
                                    "error": error_type,
                                }
                            ),
                            flush=True,
                        )
                    media_job.reset(token)
                    if self.jobs.get(key) is job:
                        self.jobs.pop(key, None)

            job.task = asyncio.create_task(execute())
        subscriber = object()
        previous = job.priority
        job.subscribers[subscriber] = priority
        job.best_priority = min(job.best_priority, priority)
        if priority < previous and len(job.subscribers) > 1:
            self.promotions += 1
        try:
            await self.changed()
            return await asyncio.shield(job.task)
        finally:
            job.subscribers.pop(subscriber, None)
            if not job.subscribers and not job.task.done():
                job.task.cancel()
                await asyncio.gather(job.task, return_exceptions=True)
            await self.changed()

    def _eligible(self, job):
        if len(self.active) >= self.total_limit:
            return False
        if sum(j.large == job.large for j in self.active) >= (
            self.large_limit if job.large else self.small_limit
        ):
            return False
        if job.priority >= 2:
            if self.background_paused or any(j.priority >= 2 for j in self.active):
                return False
            if any(j.priority < 2 for _, j in self.waiters):
                return False
        return True

    @contextlib.asynccontextmanager
    async def rpc(self):
        if _admitted_task.get() is asyncio.current_task():
            # Resolving a TL request may synchronously make another RPC. That
            # nested request uses the same slot, before its parent is sent.
            self.check_cooldown()
            yield
            return
        job = media_job.get() or MediaJob(subscribers={None: 1})
        ticket = (next(self.sequence), job)
        started = time.monotonic()
        async with self.condition:
            self.waiters.append(ticket)
            try:
                async with asyncio.timeout(20):
                    while True:
                        self.check_cooldown()
                        candidates = [w for w in self.waiters if self._eligible(w[1])]
                        chosen = min(
                            candidates,
                            key=lambda w: (w[1].priority, w[0]),
                            default=None,
                        )
                        if chosen is ticket:
                            self.active.append(job)
                            break
                        await self.condition.wait()
            except TimeoutError:
                raise MediaTimeout("queue") from None
            finally:
                self.waiters.remove(ticket)
                job.queue_seconds += time.monotonic() - started
                self.condition.notify_all()
        started = time.monotonic()
        job.requests += 1
        token = _admitted_task.set(asyncio.current_task())
        try:
            async with asyncio.timeout(30):
                yield
        except TimeoutError:
            raise MediaTimeout("network") from None
        finally:
            _admitted_task.reset(token)
            job.network_seconds += time.monotonic() - started
            async with self.condition:
                self.active.remove(job)
                self.condition.notify_all()
