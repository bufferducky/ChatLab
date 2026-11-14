/**
 * @openchatlab/sync — Optional on-demand collection
 *
 * A Pull source may expose `POST /collect` to run its own collection cycle on
 * demand instead of waiting for its timer. Sources without that capability
 * degrade to a plain pull; nothing here is required by the Pull protocol.
 */

import { NOOP_LOGGER } from './types'
import type { SyncLogger } from './types'

const PROBE_TTL_MS = 10 * 60 * 1000
const COLLECT_THROTTLE_MS = 30 * 1000
const DEFAULT_POLL_INTERVAL_MS = 500
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 15 * 1000

export interface CollectStatus {
  state: 'idle' | 'running' | 'done' | 'failed' | 'busy'
  collectId?: string
  startedAt?: number
  finishedAt?: number
  changed?: number
  error?: string
  alreadyRunning?: boolean
}

export interface CollectOutcome {
  /** Whether the source implements POST /collect. */
  supported: boolean
  state: 'done' | 'failed' | 'busy' | 'timeout' | 'skipped'
  changed: number
  error?: string
  durationMs: number
}

export interface CollectCoordinatorOptions {
  logger?: SyncLogger
  pollIntervalMs?: number
  timeoutMs?: number
  throttleMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class CollectCoordinator {
  private logger: SyncLogger
  private pollIntervalMs: number
  private timeoutMs: number
  private throttleMs: number
  private now: () => number
  private sleep: (ms: number) => Promise<void>
  private probeCache = new Map<string, { supported: boolean; checkedAt: number }>()
  private lastCollectAt = new Map<string, number>()

  constructor(options: CollectCoordinatorOptions = {}) {
    this.logger = options.logger ?? NOOP_LOGGER
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.throttleMs = options.throttleMs ?? COLLECT_THROTTLE_MS
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** Probe `GET /health` for the optional `collect` capability. */
  async probe(baseUrl: string, token: string): Promise<boolean> {
    const cached = this.probeCache.get(baseUrl)
    if (cached && this.now() - cached.checkedAt < PROBE_TTL_MS) return cached.supported
    try {
      const response = await fetch(new URL('/health', baseUrl), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) return false
      const body = (await response.json()) as { capabilities?: unknown }
      const supported = Array.isArray(body.capabilities) && body.capabilities.includes('collect')
      this.probeCache.set(baseUrl, { supported, checkedAt: this.now() })
      return supported
    } catch {
      // Unreachable sources are not cached: a later attempt may succeed.
      return false
    }
  }

  /**
   * Trigger one collection round and wait for it to finish.
   *
   * `skipped` means the server predates the capability or the source was
   * collected moments ago; callers should pull with whatever data exists.
   */
  async collect(baseUrl: string, token: string): Promise<CollectOutcome> {
    const startedAt = this.now()
    const elapsed = () => this.now() - startedAt

    if (!(await this.probe(baseUrl, token))) {
      return { supported: false, state: 'skipped', changed: 0, durationMs: elapsed() }
    }

    const last = this.lastCollectAt.get(baseUrl)
    if (last !== undefined && this.now() - last < this.throttleMs) {
      return { supported: true, state: 'skipped', changed: 0, durationMs: elapsed() }
    }
    this.lastCollectAt.set(baseUrl, this.now())

    let status: CollectStatus | null
    try {
      status = await this.trigger(baseUrl, token)
    } catch (error) {
      this.logger.warn(`[Collect] Trigger failed for ${baseUrl}: ${describeError(error)}`)
      return {
        supported: true,
        state: 'failed',
        changed: 0,
        error: describeError(error),
        durationMs: elapsed(),
      }
    }

    if (status === null) {
      return { supported: false, state: 'skipped', changed: 0, durationMs: elapsed() }
    }

    if (status.state === 'done') {
      return { supported: true, state: 'done', changed: status.changed ?? 0, durationMs: elapsed() }
    }
    if (status.state === 'busy') {
      return { supported: true, state: 'busy', changed: 0, durationMs: elapsed() }
    }

    while (elapsed() < this.timeoutMs) {
      await this.sleep(this.pollIntervalMs)
      try {
        status = await this.poll(baseUrl, token)
      } catch (error) {
        this.logger.warn(`[Collect] Status poll failed for ${baseUrl}: ${describeError(error)}`)
        continue
      }
      if (status.state === 'done') {
        return { supported: true, state: 'done', changed: status.changed ?? 0, durationMs: elapsed() }
      }
      if (status.state === 'busy') {
        return { supported: true, state: 'busy', changed: 0, durationMs: elapsed() }
      }
      if (status.state === 'failed') {
        return {
          supported: true,
          state: 'failed',
          changed: 0,
          error: status.error || 'Collection failed',
          durationMs: elapsed(),
        }
      }
    }

    this.logger.warn(`[Collect] Timed out waiting for ${baseUrl} after ${this.timeoutMs}ms`)
    return { supported: true, state: 'timeout', changed: 0, durationMs: elapsed() }
  }

  private async trigger(baseUrl: string, token: string): Promise<CollectStatus | null> {
    const response = await fetch(`${baseUrl}/collect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.status === 404 || response.status === 405) {
      this.probeCache.set(baseUrl, { supported: false, checkedAt: this.now() })
      return null
    }
    if (!response.ok && response.status !== 202) {
      throw new Error(`Collect returned HTTP ${response.status}`)
    }
    return (await response.json()) as CollectStatus
  }

  private async poll(baseUrl: string, token: string): Promise<CollectStatus> {
    const response = await fetch(`${baseUrl}/collect`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`Collect status returned HTTP ${response.status}`)
    return (await response.json()) as CollectStatus
  }
}
