/** A collector-prepared preview must open without contacting Telegram or the collector. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { MessageImageCache, MessageImagesService } from '../../packages/node-runtime/src/services/message-images'
import { cacheTelegramPreview } from './image-cache.mjs'

test('prefetched Telegram previews reuse the existing cache, caption and shared capacity', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tg-prefetch-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const cache = new MessageImageCache(directory, 4096)
  const baseUrl = 'http://127.0.0.1:5036/api/v1'
  const remote = 'telegram:1:-2'
  const url = `${baseUrl}/sessions/${encodeURIComponent(remote)}/messages/9/images`
  const source = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#aabbcc' } })
    .png()
    .toBuffer()
  await cacheTelegramPreview(cache, url, 'synthetic caption', source)
  const service = new MessageImagesService({
    cache: new MessageImageCache(directory, 4096),
    loadSources: () => [
      { id: 'tg', baseUrl, token: 'secret', sessions: [{ targetSessionId: 'local', remoteSessionId: remote }] },
    ],
    resolveMessage: () => ({ platform: 'telegram', platformMessageId: '9' }),
    fetch: async () => {
      throw new Error('Collector is offline')
    },
  })
  assert.deepEqual(await service.manifest('local', 1), { images: [{ index: 0 }], caption: 'synthetic caption' })
  const preview = await service.image('local', 1, 0, 'preview')
  assert.equal(preview.mime, 'image/webp')
  assert.equal((await sharp(preview.data).metadata()).width, 640)
  const originalKey = createHash('sha256').update(`${url}/0?size=original`).digest('hex')
  assert.equal(await cache.get(originalKey), null)
  // Ordinary image writes and prefetches share one budget, not 5 GiB each.
  await cache.put('other-platform', { data: Buffer.alloc(4000, 1), mime: 'image/png' })
  const sizes = await Promise.all(
    (await readdir(directory)).filter((name) => name.endsWith('.bin')).map((name) => stat(path.join(directory, name)))
  )
  assert.ok(sizes.reduce((sum, entry) => sum + entry.size, 0) <= 4096)
  await assert.rejects(service.image('local', 1, 0, 'original'), { statusCode: 503 })
})
