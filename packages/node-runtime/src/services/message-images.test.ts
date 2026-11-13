import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
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
