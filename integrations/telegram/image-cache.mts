/** Populate the existing Desktop/CLI image cache without a second media directory. */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MessageImageCache,
  prepareMessageImage,
  type ImageManifest,
} from '../../packages/node-runtime/src/services/message-images'

export async function cacheTelegramPreview(
  cache: MessageImageCache,
  manifestUrl: string,
  caption: string,
  data: Buffer
) {
  const image = await prepareMessageImage(data, 'preview')
  const key = (url: string) => createHash('sha256').update(url).digest('hex')
  const manifest: ImageManifest = { images: [{ index: 0 }], caption }
  await cache.put(key(manifestUrl), { data: Buffer.from(JSON.stringify(manifest)), mime: 'application/json' })
  await cache.put(key(`${manifestUrl}/0?size=preview`), image)
  return { bytes: image.data.length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const directory = process.argv[2]
    if (!directory) throw new Error('Cache directory is required')
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of process.stdin) {
      bytes += chunk.length
      if (bytes > 72 * 1024 * 1024) throw new Error('Preview input is too large')
      chunks.push(chunk)
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      manifestUrl: string
      caption: string
      data: string
    }
    const result = await cacheTelegramPreview(
      new MessageImageCache(directory),
      input.manifestUrl,
      input.caption,
      Buffer.from(input.data, 'base64')
    )
    process.stdout.write(JSON.stringify(result))
  } catch {
    // The Python collector records only the failure category, never captions or image bytes.
    process.stderr.write('Preview cache write failed\n')
    process.exitCode = 1
  }
}
