/**
 * @openchatlab/sync — Incremental pull scheduler.
 * Local collectors can trigger an early pull when their cache refreshes.
 */

import { NOOP_LOGGER } from './types'
import type { DataSource, SourceSyncStatus, SyncLogger } from './types'
import type { DataSourceManager } from './data-source-manager'
import type { PullEngine } from './pull-engine'

const HEALTH_INTERVAL_MS = 30_000
const HEALTH_TIMEOUT_MS = 3_000

type CollectorHealth = NonNullable<SourceSyncStatus['collector']>

interface SourceTimer {
  timer?: ReturnType<typeof setInterval>
  health?: CollectorHealth
  handledRefresh: number
  nextScheduledPull: number
  running: boolean
}

const timers = new Map<string, SourceTimer>()
let initialized = false

export interface SchedulerOptions {
  dsManager: DataSourceManager
  pullEngine: PullEngine
  logger?: SyncLogger
}

let _dsManager: DataSourceManager
let _pullEngine: PullEngine
let _logger: SyncLogger

function getLocalHealthUrl(baseUrl: string): URL | undefined {
  try {
    const url = new URL('/health', baseUrl)
    if (['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      return url
    }
  } catch {
    // Invalid sources still report their errors through the regular pull path.
  }
  return undefined
}

async function readCollectorHealth(url: URL, token: string): Promise<CollectorHealth | undefined> {
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: 'error',
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Collector health returned HTTP ${response.status}`)
  const body = (await response.json()) as {
    capabilities?: unknown
    lastRefresh?: unknown
    fresh?: unknown
    refresh?: { state?: string }
  }
  if (!Array.isArray(body.capabilities) || !body.capabilities.includes('collect')) return
  const state = body.refresh?.state
  const lastRefresh = typeof body.lastRefresh === 'number' && Number.isFinite(body.lastRefresh) ? body.lastRefresh : 0
  const fresh = typeof body.fresh === 'boolean' ? body.fresh : undefined
  switch (state) {
    case 'running':
    case 'done':
    case 'failed':
    case 'busy':
      return { lastRefresh, state, fresh }
    default:
      return { lastRefresh, state: 'idle', fresh }
  }
}

function startTimer(ds: DataSource, skipInitialPull = false): void {
  stopTimer(ds.id)
  if (!ds.enabled || ds.intervalMinutes < 1 || (ds.sessions.length === 0 && !ds.autoDiscoverSessions)) return

  const intervalMs = ds.intervalMinutes * 60_000
  const healthUrl = getLocalHealthUrl(ds.baseUrl)
  const state: SourceTimer = {
    handledRefresh: 0,
    nextScheduledPull: Date.now() + (skipInitialPull ? intervalMs : 0),
    running: false,
  }
  timers.set(ds.id, state)

  async function tick() {
    if (state.running) return
    state.running = true
    const now = Date.now()
    try {
      let current: DataSource | null
      try {
        current = _dsManager.get(ds.id)
      } catch (error) {
        stopTimer(ds.id)
        _logger.error('[Pull] Scheduled pull stopped because data source config could not be loaded', error)
        return
      }
      if (!current?.enabled || (current.sessions.length === 0 && !current.autoDiscoverSessions)) {
        stopTimer(ds.id)
        return
      }

      if (healthUrl) {
        try {
          state.health = await readCollectorHealth(healthUrl, current.token)
        } catch {
          state.health = { lastRefresh: state.health?.lastRefresh ?? 0, state: 'unavailable' }
        }
      }
      if (timers.get(ds.id) !== state) return

      const refresh = state.health?.lastRefresh ?? 0
      const scheduled = now >= state.nextScheduledPull
      // A previous success is insufficient evidence to trigger a pull while health is unreachable.
      const freshCache = state.health?.state !== 'unavailable' && refresh > state.handledRefresh
      if (!scheduled && !freshCache) return
      if (scheduled) state.nextScheduledPull = now + intervalMs

      const completed = await _pullEngine.pullAllSessions(current)
      if (completed && state.health?.state !== 'unavailable') {
        state.handledRefresh = Math.max(state.handledRefresh, refresh)
        if (freshCache && !scheduled) {
          state.nextScheduledPull = now + intervalMs
          _logger.info(
            `[Pull] Pulled source ${ds.id} after collector refresh ${new Date(refresh * 1000).toISOString()}`
          )
        }
      }
    } catch (error) {
      _logger.error('[Pull] Scheduled pull failed', error)
    } finally {
      state.running = false
    }
  }

  state.timer = setInterval(() => void tick(), healthUrl ? HEALTH_INTERVAL_MS : intervalMs)
  if (!skipInitialPull) void tick()
  _logger.info(
    `[Pull] Timer started for source ${ds.baseUrl} (${ds.sessions.length} sessions, every ${ds.intervalMinutes}min)`
  )
}

export function stopTimer(id: string): void {
  clearInterval(timers.get(id)?.timer)
  timers.delete(id)
}

export function getSourceSyncStatus(source: {
  id: string
  sessions: Array<{ id: string; lastSuccessfulPullAt?: number }>
}): SourceSyncStatus {
  const subscribed = new Set(source.sessions.map((session) => session.id))
  return {
    collector: timers.get(source.id)?.health,
    lastSuccessfulPullAt: source.sessions.reduce(
      (last, session) => Math.max(last, session.lastSuccessfulPullAt ?? 0),
      0
    ),
    pendingSessionIds: (_pullEngine?.getPendingImportSessionIds(source.id) ?? []).filter((id) => subscribed.has(id)),
  }
}

export function initScheduler(options: SchedulerOptions): void {
  if (initialized) return

  _dsManager = options.dsManager
  _pullEngine = options.pullEngine
  _logger = options.logger ?? NOOP_LOGGER

  let sources: DataSource[]
  try {
    sources = _dsManager.loadAll()
  } catch (err) {
    _logger.error('[Pull] Scheduler not started because data source config could not be loaded', err)
    return
  }
  initialized = true
  _pullEngine.startImportRetries()
  for (const ds of sources) startTimer(ds)

  _logger.info(`[Pull] Initialized with ${sources.filter((s) => s.enabled).length} active sources`)
}

export function stopAllTimers(): void {
  _pullEngine?.stopImportRetries()
  for (const id of timers.keys()) stopTimer(id)
  initialized = false
  _logger?.info('[Pull] All timers stopped')
}

export function reloadTimer(dsId: string, skipInitialPull = false): void {
  stopTimer(dsId)
  const ds = _dsManager?.get(dsId)
  if (ds) startTimer(ds, skipInitialPull)
}
