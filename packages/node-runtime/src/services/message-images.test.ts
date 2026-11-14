import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { MessageImageCache, MessageImagesService } from './message-images'

test('preview images preserve captions, resize and cache bytes without reimporting messages', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'chatlab-images-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const input = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#aabbcc' } })
    .png()
    .toBuffer()
  const calls: string[] = []
  const service = new MessageImagesService({
    cache: new MessageImageCache(dir),
    resolveMessage: () => ({ platform: 'telegram', platformMessageId: '9007199254740993' }),
    loadSources: () => [
      {
        id: 'tg',
        baseUrl: 'http://127.0.0.1:5036/api/v1',
        token: 'test-secret',
        sessions: [{ targetSessionId: 'local', remoteSessionId: 'telegram:1:-1002' }],
      },
    ],
    fetch: async (url, init) => {
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-secret')
      calls.push(String(url))
      return String(url).endsWith('/images')
        ? Response.json({ images: [{ index: 0 }], caption: 'caption' })
        : new Response(Uint8Array.from(input))
    },
  })
  assert.deepEqual(await service.manifest('local', 42), { images: [{ index: 0 }], caption: 'caption' })
  const [first, second] = await Promise.all([
    service.image('local', 42, 0, 'preview'),
    service.image('local', 42, 0, 'preview'),
  ])
  assert.deepEqual(first, second)
  assert.equal(first.mime, 'image/webp')
  assert.equal((await sharp(first.data).metadata()).width, 640)
  assert.deepEqual(await service.image('local', 42, 0, 'preview'), first)
  assert.deepEqual(await service.manifest('local', 42), { images: [{ index: 0 }], caption: 'caption' })
  assert.equal(calls.length, 2)
  assert.ok(calls[0].includes('9007199254740993'))
  assert.ok(calls[0].includes('telegram%3A1%3A-1002'))
  const original = await service.image('local', 42, 0, 'original')
  assert.deepEqual(original.data, input)
  assert.equal(original.mime, 'image/png')
})

test('cache deduplicates bytes and evicts least recently viewed images at its limit', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'chatlab-images-lru-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cache = new MessageImageCache(dir, 8)
  await cache.put('a', { data: Buffer.from('aaaa'), mime: 'image/png' })
  await cache.put('duplicate', { data: Buffer.from('aaaa'), mime: 'image/png' })
  assert.equal((await readdir(dir)).filter((name) => name.endsWith('.bin')).length, 1)
  await cache.put('b', { data: Buffer.from('bbbb'), mime: 'image/png' })
  // Make the next access strictly newer even on filesystems with coarse timestamps.
  for (const name of (await readdir(dir)).filter((name) => name.endsWith('.bin'))) {
    await utimes(path.join(dir, name), new Date(0), new Date(0))
  }
  await cache.get('a')
  await cache.put('c', { data: Buffer.from('cccc'), mime: 'image/png' })
  assert.equal(await cache.get('b'), null)
  assert.equal((await cache.get('a'))?.data.toString(), 'aaaa')
  assert.equal((await cache.get('c'))?.data.toString(), 'cccc')
})

test('QQ originals are read through without making another original copy; invalid files never render', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'chatlab-qq-images-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cache = new MessageImageCache(dir)
  const input = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer()
  let valid = true
  let calls = 0
  const options = {
    cache,
    resolveMessage: () => ({ platform: 'qq', platformMessageId: 'qq:origin:item' }),
    loadSources: () => [
      {
        id: 'qq',
        baseUrl: 'http://localhost/api/v1',
        token: '',
        sessions: [{ targetSessionId: 'local', remoteSessionId: 'remote' }],
      },
    ],
    fetch: async () => {
      calls++
      return new Response(Uint8Array.from(valid ? input : Buffer.from('<svg onload="alert(1)"/>')))
    },
  }
  const service = new MessageImagesService(options)
  await service.image('local', 1, 0, 'original')
  await service.image('local', 1, 0, 'original')
  assert.equal(calls, 2)
  assert.equal((await readdir(dir)).length, 0)
  valid = false
  await assert.rejects(service.image('local', 1, 0, 'preview'), { statusCode: 415 })
  const detached = new MessageImagesService({ ...options, loadSources: () => [] })
  await assert.rejects(detached.image('local', 1, 0, 'preview'), { statusCode: 404 })
  assert.equal(calls, 3)
})

test('controlled collector errors preserve their business code and retryability', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'chatlab-images-errors-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let status = 409
  let payload: Record<string, unknown> = {
    error: 'QQ account differs from the data source account',
    code: 'QQ_ACCOUNT_MISMATCH',
    retryable: false,
  }
  const service = new MessageImagesService({
    cache: new MessageImageCache(dir),
    resolveMessage: () => ({ platform: 'qq', platformMessageId: 'qq:origin:item' }),
    loadSources: () => [
      {
        id: 'qq',
        baseUrl: 'http://127.0.0.1:5035/api/v1',
        token: 'secret',
        sessions: [{ targetSessionId: 'local', remoteSessionId: 'conversation_1' }],
      },
    ],
    fetch: async () => new Response(JSON.stringify(payload), { status }),
  })
  await assert.rejects(service.image('local', 1, 0, 'preview'), (error: unknown) => {
    const failure = error as { statusCode: number; code: string; retryable: boolean }
    return failure.statusCode === 409 && failure.code === 'QQ_ACCOUNT_MISMATCH' && failure.retryable === false
  })
  status = 429
  payload = { error: 'QQ image download is busy', code: 'QQ_IMAGE_BUSY', retryable: true }
  await assert.rejects(service.image('local', 1, 0, 'preview'), (error: unknown) => {
    const failure = error as { statusCode: number; code: string; retryable: boolean }
    return failure.statusCode === 429 && failure.code === 'QQ_IMAGE_BUSY' && failure.retryable === true
  })
  // Unknown or mismatched source codes never leak through; the status maps to a known code.
  status = 503
  payload = { error: 'unexpected upstream detail', code: 'SOMETHING_NEW', retryable: true }
  await assert.rejects(service.image('local', 1, 0, 'preview'), (error: unknown) => {
    const failure = error as { statusCode: number; code: string; retryable: boolean; message: string }
    return (
      failure.statusCode === 503 &&
      failure.code === 'QQ_BRIDGE_UNAVAILABLE' &&
      failure.message === 'unexpected upstream detail'
    )
  })
})

test('shared readers cancel independently and the final cancellation reaches the collector', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'chatlab-images-cancel-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const input = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer()
  let release: () => void = () => {}
  let started: () => void = () => {}
  let ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const remoteRequests: Array<{ id: string; signal: AbortSignal }> = []
  const cancellations: string[] = []
  const service = new MessageImagesService({
    cache: new MessageImageCache(dir),
    resolveMessage: (_session, messageId) => ({ platform: 'telegram', platformMessageId: String(messageId) }),
    loadSources: () => [
      {
        id: 'tg',
        baseUrl: 'http://localhost/api/v1',
        token: 'secret',
        sessions: [{ targetSessionId: 'local', remoteSessionId: 'tg-peer' }],
      },
    ],
    fetch: async (url, init) => {
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer secret')
      if (init?.method === 'DELETE') {
        cancellations.push(String(url))
        return Response.json({ cancelled: true })
      }
      if (String(url).endsWith('image-capabilities'))
        return Response.json({}, { headers: { 'X-Image-Cancel-Protocol': '1' } })
      assert.ok(init?.signal)
      remoteRequests.push({ id: new Headers(init.headers).get('X-Image-Request-Id')!, signal: init.signal })
      await new Promise<void>((resolve, reject) => {
        release = resolve
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
        started()
      })
      return new Response(Uint8Array.from(input), { headers: { 'X-Image-Cancel-Protocol': '1' } })
    },
  })
  const first = new AbortController()
  const second = new AbortController()
  const a = service.image('local', 1, 0, 'preview', first.signal)
  const b = service.image('local', 1, 0, 'preview', second.signal)
  const rejected = assert.rejects(a, { name: 'AbortError' })
  await ready
  // Allow both cache reads to join the shared request before removing one reader.
  await new Promise((resolve) => setTimeout(resolve, 20))
  first.abort()
  await rejected
  assert.equal(remoteRequests[0].signal.aborted, false)
  release()
  assert.equal((await b).mime, 'image/webp')
  assert.equal(remoteRequests.length, 1)
  assert.equal(cancellations.length, 0)

  const last = new AbortController()
  ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const abandoned = service.image('local', 2, 0, 'original', last.signal)
  const cancelled = assert.rejects(abandoned, { name: 'AbortError' })
  await ready
  last.abort()
  await cancelled
  assert.equal(remoteRequests[1].signal.aborted, true)
  assert.equal(cancellations[0], `http://localhost/api/v1/image-requests/${remoteRequests[1].id}`)
})

test('server Retry-After is preserved even if the response body is not JSON', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'chatlab-images-cooldown-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const service = new MessageImagesService({
    cache: new MessageImageCache(dir),
    resolveMessage: () => ({ platform: 'telegram', platformMessageId: '1' }),
    loadSources: () => [
      {
        id: 'tg',
        baseUrl: 'http://localhost/api/v1',
        token: '',
        sessions: [{ targetSessionId: 'local', remoteSessionId: 'tg-peer' }],
      },
    ],
    fetch: async () => new Response('Rate limited', { status: 429, headers: { 'Retry-After': '41' } }),
  })
  await assert.rejects(service.image('local', 1, 0, 'original'), {
    code: 'IMAGE_RATE_LIMITED',
    retryAfterSeconds: 41,
    retryable: true,
  })
})
