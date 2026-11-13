import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const MAX_IMAGE_BYTES = 50 * 1024 * 1024
export const DEFAULT_IMAGE_CACHE_BYTES = 3 * 1024 ** 3
const IMAGE_FORMATS: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
}

export class MessageImageError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message)
  }
}

export interface ImageManifest {
  images: Array<{ index: number }>
  caption: string
}

export interface ImageBytes {
  data: Buffer
  mime: string
}

/** Content-addressed, disposable image cache. Missing blobs simply refetch. */
export class MessageImageCache {
  private writes: Promise<unknown> = Promise.resolve()
  constructor(
    readonly directory: string,
    readonly maxBytes = DEFAULT_IMAGE_CACHE_BYTES
  ) {}

  async get(key: string): Promise<ImageBytes | null> {
    try {
      const ref = JSON.parse(await fs.readFile(path.join(this.directory, `${key}.json`), 'utf8'))
      if (!/^[a-f0-9]{64}$/.test(ref.blob) || ![...Object.values(IMAGE_FORMATS), 'application/json'].includes(ref.mime))
        return null
      const file = path.join(this.directory, `${ref.blob}.bin`)
      const data = await fs.readFile(file)
      await fs.utimes(file, new Date(), new Date())
      return { data, mime: ref.mime }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async put(key: string, value: ImageBytes): Promise<void> {
    const write = this.writes.then(async () => {
      if (value.data.length > this.maxBytes) return
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
      const blob = createHash('sha256').update(value.data).digest('hex')
      const bin = path.join(this.directory, `${blob}.bin`)
      await this.atomicWrite(bin, value.data)
      await this.atomicWrite(path.join(this.directory, `${key}.json`), JSON.stringify({ blob, mime: value.mime }))
      const entries = await fs.readdir(this.directory)
      const blobs = await Promise.all(
        entries
          .filter((name) => name.endsWith('.bin'))
          .map(async (name) => {
            const file = path.join(this.directory, name)
            try {
              const stat = await fs.stat(file)
              return { file, name: name.slice(0, -4), size: stat.size, accessed: stat.mtimeMs }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
              throw error
            }
          })
      )
      const existing = blobs.filter((entry) => entry !== null)
      let bytes = existing.reduce((sum, entry) => sum + entry.size, 0)
      const evicted = new Set<string>()
      for (const entry of existing.sort((a, b) => a.accessed - b.accessed)) {
        if (bytes <= this.maxBytes) break
        await fs.rm(entry.file, { force: true })
        bytes -= entry.size
        evicted.add(entry.name)
      }
      // Remove references too, so a long-lived cache cannot accumulate metadata forever.
      if (evicted.size) {
        for (const name of entries.filter((entry) => entry.endsWith('.json'))) {
          const file = path.join(this.directory, name)
          try {
            const ref = JSON.parse(await fs.readFile(file, 'utf8'))
            if (evicted.has(ref.blob)) await fs.rm(file, { force: true })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      }
    })
    this.writes = write.catch(() => {})
    await write
  }

  private async atomicWrite(file: string, data: Buffer | string) {
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temp, data, { mode: 0o600 })
      await fs.rename(temp, file)
    } finally {
      await fs.rm(temp, { force: true })
    }
  }
}

interface ImageSource {
  id: string
  baseUrl: string
  token: string
  sessions: Array<{ targetSessionId: string; remoteSessionId: string }>
}

interface MessageImagesOptions {
  cache: MessageImageCache
  loadSources(): unknown[]
  resolveMessage(
    sessionId: string,
    messageId: number
  ): { platform: string; platformMessageId: string | null } | undefined
  fetch?: typeof fetch
}

/** Resolve attachments through the subscription that imported each message. */
export class MessageImagesService {
  private pending = new Map<string, Promise<ImageBytes>>()
  constructor(private options: MessageImagesOptions) {}

  private resolve(sessionId: string, messageId: number) {
    const message = this.options.resolveMessage(sessionId, messageId)
    if (!message?.platformMessageId || !['qq', 'telegram'].includes(message.platform))
      throw new MessageImageError(404, 'Image source unavailable')
    const matches: Array<{ source: ImageSource; remote: string }> = []
    for (const candidate of this.options.loadSources()) {
      const source = candidate as ImageSource
      if (
        !source ||
        typeof source.baseUrl !== 'string' ||
        typeof source.token !== 'string' ||
        !Array.isArray(source.sessions)
      )
        continue
      for (const session of source.sessions) {
        if (session.targetSessionId === sessionId && typeof session.remoteSessionId === 'string')
          matches.push({ source, remote: session.remoteSessionId })
      }
    }
    if (matches.length !== 1) throw new MessageImageError(404, 'Image source unavailable')
    const { source, remote } = matches[0]
    const base = source.baseUrl.replace(/\/+$/, '')
    const url = `${base}/sessions/${encodeURIComponent(remote)}/messages/${encodeURIComponent(message.platformMessageId)}/images`
    return { url, token: source.token, platform: message.platform }
  }

  private async request(url: string, token: string) {
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(65_000),
        redirect: 'error',
      })
    } catch {
      throw new MessageImageError(503, 'Image source unavailable')
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new MessageImageError(response.status === 404 ? 404 : 503, 'Image unavailable')
    }
    return response
  }

  async manifest(sessionId: string, messageId: number): Promise<ImageManifest> {
    const source = this.resolve(sessionId, messageId)
    const key = createHash('sha256').update(source.url).digest('hex')
    const cached = await this.options.cache.get(key)
    if (cached) return JSON.parse(cached.data.toString('utf8'))
    const response = await this.request(source.url, source.token)
    let data: ImageManifest
    try {
      data = JSON.parse((await this.readLimited(response, 256 * 1024)).toString('utf8'))
    } catch {
      throw new MessageImageError(502, 'Invalid image manifest')
    }
    if (
      !Array.isArray(data.images) ||
      data.images.length > 100 ||
      !data.images.every((image: { index: unknown }, index: number) => image?.index === index)
    )
      throw new MessageImageError(502, 'Invalid image manifest')
    const manifest = {
      images: data.images.map((image: { index: number }) => ({ index: image.index })),
      caption: typeof data.caption === 'string' ? data.caption : '',
    }
    if (manifest.images.length)
      await this.options.cache.put(key, { data: Buffer.from(JSON.stringify(manifest)), mime: 'application/json' })
    return manifest
  }

  async image(sessionId: string, messageId: number, index: number, size: 'preview' | 'original'): Promise<ImageBytes> {
    const source = this.resolve(sessionId, messageId)
    const url = `${source.url}/${index}?size=${size}`
    const key = createHash('sha256').update(url).digest('hex')
    const cached = await this.options.cache.get(key)
    if (cached) return cached
    const pending = this.pending.get(key)
    if (pending) return pending
    const request = this.download(url, source.token, size, source.platform, key)
    this.pending.set(key, request)
    try {
      return await request
    } finally {
      this.pending.delete(key)
    }
  }

  private async download(url: string, token: string, size: 'preview' | 'original', platform: string, key: string) {
    const data = await this.readLimited(await this.request(url, token), MAX_IMAGE_BYTES)
    let image: ImageBytes
    try {
      const decoder = sharp(data, { limitInputPixels: 40_000_000 })
      const metadata = await decoder.metadata()
      const mime = IMAGE_FORMATS[metadata.format ?? '']
      if (!mime) throw new Error('Unsupported image')
      image =
        size === 'preview'
          ? {
              data: await decoder
                .rotate()
                .resize(640, 640, { fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 75 })
                .toBuffer(),
              mime: 'image/webp',
            }
          : { data, mime }
    } catch {
      throw new MessageImageError(415, 'Unsupported or damaged image')
    }
    // QQ originals stay in QQ's own cache. Only their small previews are copied.
    if (size === 'preview' || platform !== 'qq') await this.options.cache.put(key, image)
    return image
  }

  private async readLimited(response: Response, limit: number) {
    const chunks: Buffer[] = []
    let bytes = 0
    if (!response.body) throw new MessageImageError(502, 'Empty image response')
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > limit) {
          await reader.cancel()
          throw new MessageImageError(413, 'Image too large')
        }
        chunks.push(Buffer.from(value))
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks)
  }
}
