import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const MAX_IMAGE_BYTES = 50 * 1024 * 1024
const MAX_SOURCE_ERROR_BYTES = 8 * 1024
export const DEFAULT_IMAGE_CACHE_BYTES = 5 * 1024 ** 3
const IMAGE_FORMATS: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
}

/** Business codes the image endpoints may return. Unknown source codes are never forwarded. */
export const MESSAGE_IMAGE_ERROR_CODES = [
  'INVALID_IMAGE_REQUEST',
  'UNAUTHORIZED',
  'MESSAGE_NOT_FOUND',
  'IMAGE_NOT_FOUND',
  'QQ_IMAGE_UNAVAILABLE',
  'QQ_ACCOUNT_MISMATCH',
  'QQ_DATA_SOURCE_MISMATCH',
  'IMAGE_REFERENCE_MISMATCH',
  'IMAGE_TOO_LARGE',
  'UNSUPPORTED_IMAGE',
  'QQ_IMAGE_BUSY',
  'QQ_DOWNLOAD_FAILED',
  'IMAGE_INTEGRITY_FAILED',
  'QQ_BRIDGE_UNAVAILABLE',
  'QQ_OFFLINE',
  'QQ_BRIDGE_INCOMPATIBLE',
  'QQ_DOWNLOAD_TIMEOUT',
  'IMAGE_RATE_LIMITED',
  'IMAGE_TIMEOUT',
  'IMAGE_SOURCE_UNAVAILABLE',
] as const
export type MessageImageErrorCode = (typeof MESSAGE_IMAGE_ERROR_CODES)[number]
const KNOWN_CODES = new Set<string>(MESSAGE_IMAGE_ERROR_CODES)
// A retry may succeed after the user logs in, waits or restarts the collector.
const RETRYABLE_CODES = new Set<string>([
  'QQ_IMAGE_BUSY',
  'QQ_DOWNLOAD_FAILED',
  'IMAGE_INTEGRITY_FAILED',
  'QQ_BRIDGE_UNAVAILABLE',
  'QQ_OFFLINE',
  'QQ_DOWNLOAD_TIMEOUT',
  'IMAGE_RATE_LIMITED',
  'IMAGE_TIMEOUT',
  'IMAGE_SOURCE_UNAVAILABLE',
])
const DEFAULT_CODE_BY_STATUS: Record<number, MessageImageErrorCode> = {
  400: 'INVALID_IMAGE_REQUEST',
  401: 'UNAUTHORIZED',
  404: 'IMAGE_NOT_FOUND',
  409: 'IMAGE_REFERENCE_MISMATCH',
  413: 'IMAGE_TOO_LARGE',
  415: 'UNSUPPORTED_IMAGE',
  429: 'IMAGE_RATE_LIMITED',
  502: 'QQ_DOWNLOAD_FAILED',
  503: 'QQ_BRIDGE_UNAVAILABLE',
  504: 'QQ_DOWNLOAD_TIMEOUT',
}

export class MessageImageError extends Error {
  readonly statusCode: number
  readonly code: MessageImageErrorCode
  readonly retryable: boolean
  readonly retryAfterSeconds?: number

  constructor(
    statusCode: number,
    message: string,
    code?: MessageImageErrorCode,
    retryable?: boolean,
    retryAfterSeconds?: number
  ) {
    super(message)
    this.name = 'MessageImageError'
    this.statusCode = statusCode
    this.code = code ?? DEFAULT_CODE_BY_STATUS[statusCode] ?? 'IMAGE_SOURCE_UNAVAILABLE'
    this.retryable = retryable ?? RETRYABLE_CODES.has(this.code)
    this.retryAfterSeconds = retryAfterSeconds
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

/** Both on-demand downloads and collector prefetches use the same image validation. */
export async function prepareMessageImage(data: Buffer, size: 'preview' | 'original'): Promise<ImageBytes> {
  if (data.length > MAX_IMAGE_BYTES) throw new MessageImageError(413, 'Image too large')
  try {
    const decoder = sharp(data, { limitInputPixels: 40_000_000 })
    const metadata = await decoder.metadata()
    const mime = IMAGE_FORMATS[metadata.format ?? '']
    if (!mime) throw new Error('Unsupported image')
    return size === 'preview'
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
    throw new MessageImageError(415, 'Unsupported or damaged image', 'UNSUPPORTED_IMAGE')
  }
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
  private pending = new Map<
    string,
    {
      promise: Promise<unknown>
      controller: AbortController
      subscribers: number
    }
  >()
  private cancellation = new Map<string, boolean>()
  constructor(private options: MessageImagesOptions) {}

  private resolve(sessionId: string, messageId: number) {
    const message = this.options.resolveMessage(sessionId, messageId)
    if (!message?.platformMessageId || !['qq', 'telegram'].includes(message.platform))
      throw new MessageImageError(404, 'Image source unavailable', 'MESSAGE_NOT_FOUND')
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
    if (matches.length !== 1) throw new MessageImageError(404, 'Image source unavailable', 'MESSAGE_NOT_FOUND')
    const { source, remote } = matches[0]
    const base = source.baseUrl.replace(/\/+$/, '')
    const url = `${base}/sessions/${encodeURIComponent(remote)}/messages/${encodeURIComponent(message.platformMessageId)}/images`
    return { url, token: source.token, platform: message.platform, base }
  }

  private async shared<T>(
    key: string,
    source: { base: string; token: string },
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal, requestId: string) => Promise<T>
  ): Promise<T> {
    signal?.throwIfAborted()
    let entry = this.pending.get(key)
    if (!entry) {
      const controller = new AbortController()
      const requestId = randomUUID()
      const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(65_000)])
      const cancel = () => {
        if (this.cancellation.get(source.base)) {
          void (this.options.fetch ?? fetch)(`${source.base}/image-requests/${requestId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${source.token}` },
            signal: AbortSignal.timeout(3_000),
            redirect: 'error',
          }).catch(() => {})
        }
      }
      combined.addEventListener('abort', cancel, { once: true })
      const created = { controller, subscribers: 0, promise: Promise.resolve() as Promise<unknown> }
      created.promise = Promise.resolve()
        .then(() => operation(combined, requestId))
        .finally(() => {
          combined.removeEventListener('abort', cancel)
          if (this.pending.get(key) === created) this.pending.delete(key)
        })
      entry = created
      this.pending.set(key, entry)
    }
    const current = entry
    current.subscribers++
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        cleanup()
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      let finished = false
      const cleanup = () => {
        if (finished) return
        finished = true
        signal?.removeEventListener('abort', abort)
        current.subscribers--
        if (!current.subscribers && this.pending.get(key) === current) {
          this.pending.delete(key)
          current.controller.abort()
        }
      }
      signal?.addEventListener('abort', abort, { once: true })
      current.promise.then(
        (value) => {
          if (!finished) {
            cleanup()
            resolve(value as T)
          }
        },
        (error) => {
          if (!finished) {
            cleanup()
            reject(error)
          }
        }
      )
    })
  }

  private async request(url: string, token: string, signal?: AbortSignal, requestId?: string, base?: string) {
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(url, {
        headers: { Authorization: `Bearer ${token}`, ...(requestId ? { 'X-Image-Request-Id': requestId } : {}) },
        signal: signal ?? AbortSignal.timeout(65_000),
        redirect: 'error',
      })
    } catch {
      throw new MessageImageError(503, 'Image source unavailable', 'IMAGE_SOURCE_UNAVAILABLE')
    }
    if (base) this.cancellation.set(base, response.headers.get('X-Image-Cancel-Protocol') === '1')
    if (!response.ok) {
      const detail = await this.sourceError(response)
      const status = response.status >= 400 && response.status <= 599 ? response.status : 502
      const code: MessageImageErrorCode =
        detail.code && KNOWN_CODES.has(detail.code)
          ? (detail.code as MessageImageErrorCode)
          : (DEFAULT_CODE_BY_STATUS[status] ?? 'IMAGE_SOURCE_UNAVAILABLE')
      throw new MessageImageError(
        status,
        detail.message ?? 'Image unavailable',
        code,
        detail.retryable,
        detail.retryAfterSeconds
      )
    }
    return response
  }

  /** Read the collector's controlled error payload without trusting arbitrary fields. */
  private async sourceError(
    response: Response
  ): Promise<{ code?: string; message?: string; retryable?: boolean; retryAfterSeconds?: number }> {
    try {
      const raw = await this.readLimited(response, MAX_SOURCE_ERROR_BYTES)
      const payload = JSON.parse(raw.toString('utf8')) as {
        code?: unknown
        error?: unknown
        message?: unknown
        retryable?: unknown
        retryAfterSeconds?: unknown
      }
      const message =
        typeof payload.message === 'string'
          ? payload.message
          : typeof payload.error === 'string'
            ? payload.error
            : undefined
      return {
        code: typeof payload.code === 'string' ? payload.code : undefined,
        message: message ? message.slice(0, 200) : undefined,
        retryable: typeof payload.retryable === 'boolean' ? payload.retryable : undefined,
        retryAfterSeconds: this.retrySeconds(response.headers.get('Retry-After'), payload.retryAfterSeconds),
      }
    } catch (error) {
      if (error instanceof MessageImageError)
        return { retryAfterSeconds: this.retrySeconds(response.headers.get('Retry-After')) }
      return { retryAfterSeconds: this.retrySeconds(response.headers.get('Retry-After')) }
    }
  }

  private retrySeconds(header: string | null, body?: unknown): number | undefined {
    const seconds = Math.max(
      typeof body === 'number' && Number.isFinite(body) ? body : 0,
      header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : 0,
      header && !/^\d+(?:\.\d+)?$/.test(header) ? (Date.parse(header) - Date.now()) / 1000 : 0
    )
    return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined
  }

  async manifest(sessionId: string, messageId: number, signal?: AbortSignal): Promise<ImageManifest> {
    const source = this.resolve(sessionId, messageId)
    const key = createHash('sha256').update(source.url).digest('hex')
    const cached = await this.options.cache.get(key)
    if (cached) return JSON.parse(cached.data.toString('utf8'))
    return this.shared(key, source, signal, async (combined, requestId) => {
      const response = await this.request(source.url, source.token, combined, requestId, source.base)
      let data: ImageManifest
      try {
        data = JSON.parse((await this.readLimited(response, 256 * 1024)).toString('utf8'))
      } catch {
        throw new MessageImageError(502, 'Invalid image manifest', 'IMAGE_SOURCE_UNAVAILABLE')
      }
      if (
        !Array.isArray(data.images) ||
        data.images.length > 100 ||
        !data.images.every((image: { index: unknown }, index: number) => image?.index === index)
      )
        throw new MessageImageError(502, 'Invalid image manifest', 'IMAGE_SOURCE_UNAVAILABLE')
      const manifest = {
        images: data.images.map((image: { index: number }) => ({ index: image.index })),
        caption: typeof data.caption === 'string' ? data.caption : '',
      }
      if (manifest.images.length)
        await this.options.cache.put(key, { data: Buffer.from(JSON.stringify(manifest)), mime: 'application/json' })
      return manifest
    })
  }

  async image(
    sessionId: string,
    messageId: number,
    index: number,
    size: 'preview' | 'original',
    signal?: AbortSignal
  ): Promise<ImageBytes> {
    const source = this.resolve(sessionId, messageId)
    const url = `${source.url}/${index}?size=${size}`
    const key = createHash('sha256').update(url).digest('hex')
    const cached = await this.options.cache.get(key)
    if (cached) return cached
    // A fresh runtime may already have cached manifests; discover capability using
    // a bounded local request before relying on the cancellation protocol.
    if (source.platform === 'telegram' && !this.cancellation.has(source.base)) {
      try {
        const response = await (this.options.fetch ?? fetch)(`${source.base}/image-capabilities`, {
          headers: { Authorization: `Bearer ${source.token}` },
          signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(2_000)]),
          redirect: 'error',
        })
        this.cancellation.set(source.base, response.headers.get('X-Image-Cancel-Protocol') === '1')
        await response.body?.cancel()
      } catch {
        this.cancellation.set(source.base, false)
      }
    }
    return this.shared(key, source, signal, async (combined, requestId) => {
      const response = await this.request(url, source.token, combined, requestId, source.base)
      const data = await this.readLimited(response, MAX_IMAGE_BYTES)
      combined.throwIfAborted()
      const image = await prepareMessageImage(data, size)
      if (size === 'preview' || source.platform !== 'qq') await this.options.cache.put(key, image)
      return image
    })
  }

  private async readLimited(response: Response, limit: number) {
    const chunks: Buffer[] = []
    let bytes = 0
    if (!response.body) throw new MessageImageError(502, 'Empty image response', 'IMAGE_INTEGRITY_FAILED')
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
