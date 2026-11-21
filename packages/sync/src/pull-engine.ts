/**
 * @openchatlab/sync — Pull engine
 *
 * Core paginated pull loop extracted from electron/main/api/pullScheduler.ts.
 * All platform-specific dependencies are injected via HttpFetcher, DataImporter, and SyncNotifier.
 */

import * as fs from 'fs'
import * as crypto from 'crypto'
import timers from 'node:timers'
import { NOOP_LOGGER } from './types'
import type {
  DataSource,
  ImportSession,
  HttpFetcher,
  DataImporter,
  SyncNotifier,
  SyncLogger,
  FetchParams,
  SyncMeta,
  ImportResult,
  PullSessionResult,
  PullProgress,
} from './types'
import { DataSourceConfigError, type DataSourceManager } from './data-source-manager'

const MAX_PAGES_PER_PULL = 5000
const PULL_OVERLAP_SECONDS = 60
const IMPORT_RETRY_MAX_DELAY_MS = 60_000
const IMPORT_RETRY_DELAYS_MS = [2000, 5000, 15_000, 30_000, IMPORT_RETRY_MAX_DELAY_MS]
const IMPORT_RETRY_WARNING_MS = 5 * 60_000
const SOURCE_UNAVAILABLE_LOG_COOLDOWN_MS = 5 * 60 * 1000
const SOURCE_UNAVAILABLE_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ABORT_ERR'])

// ==================== Helpers ====================

export function buildPullUrl(baseUrl: string, remoteSessionId: string, params: FetchParams): string {
  const base = `${baseUrl}/sessions/${remoteSessionId}/messages`
  const qs: string[] = ['format=chatlab']
  if (params.since !== undefined && params.since > 0) qs.push(`since=${params.since}`)
  if (params.offset !== undefined && params.offset > 0) qs.push(`offset=${params.offset}`)
  if (params.limit !== undefined && params.limit > 0) qs.push(`limit=${params.limit}`)
  return base + '?' + qs.join('&')
}

export function deriveLocalSessionId(baseUrl: string, remoteSessionId: string): string {
  const hash = crypto.createHash('sha256').update(`${baseUrl}\0${remoteSessionId}`).digest('hex').slice(0, 12)
  return `remote_${hash}`
}

export function parseSyncFromFile(filePath: string): SyncMeta | null {
  try {
    const isJsonl = filePath.endsWith('.jsonl')
    if (isJsonl) {
      const content = fs.readFileSync(filePath, 'utf-8')
      const lines = content.trimEnd().split('\n')
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
        try {
          const obj = JSON.parse(lines[i])
          if (obj._type === 'sync') {
            return {
              hasMore: !!obj.hasMore,
              nextSince: obj.nextSince,
              nextOffset: obj.nextOffset,
              watermark: obj.watermark,
              emptyIsFinal: obj.emptyIsFinal,
            }
          }
        } catch {
          continue
        }
      }
      return null
    }

    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed.sync && typeof parsed.sync === 'object') {
      const s = parsed.sync
      return {
        hasMore: !!s.hasMore,
        nextSince: s.nextSince,
        nextOffset: s.nextOffset,
        watermark: s.watermark,
        emptyIsFinal: s.emptyIsFinal,
      }
    }
    return null
  } catch {
    return null
  }
}

function fileContainsMessages(filePath: string): boolean {
  try {
    if (filePath.endsWith('.jsonl')) {
      const content = fs.readFileSync(filePath, 'utf-8')
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const obj = JSON.parse(trimmed)
          if (obj._type === 'message') return true
        } catch {
          continue
        }
      }
      return false
    }

    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed.messages) && parsed.messages.length > 0
  } catch {
    return false
  }
}

function getMaxMessageTimestampFromFile(filePath: string): number | null {
  try {
    let maxTs: number | null = null
    const visitTimestamp = (value: unknown) => {
      const ts = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
      if (typeof ts === 'number' && Number.isFinite(ts)) {
        maxTs = maxTs === null ? ts : Math.max(maxTs, ts)
      }
    }

    if (filePath.endsWith('.jsonl')) {
      const content = fs.readFileSync(filePath, 'utf-8')
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const obj = JSON.parse(trimmed)
          if (obj._type === 'message') visitTimestamp(obj.timestamp)
        } catch {
          continue
        }
      }
      return maxTs
    }

    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed.messages)) {
      for (const message of parsed.messages) {
        visitTimestamp(message?.timestamp)
      }
    }
    return maxTs
  } catch {
    return null
  }
}

function cleanupTempFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch {
    /* ignore */
  }
}

function getErrorProp(error: unknown, prop: string): unknown {
  return error && typeof error === 'object' ? (error as Record<string, unknown>)[prop] : undefined
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Pull failed')
}

// 只把连接级网络错误归为数据源不可达；导入/解析/HTTP 状态码仍按单会话失败处理。
function describeSourceUnavailableError(error: unknown): string | null {
  let current: unknown = error
  while (current && typeof current === 'object') {
    const code = getErrorProp(current, 'code')
    const name = getErrorProp(current, 'name')
    if (typeof code === 'string' && SOURCE_UNAVAILABLE_ERROR_CODES.has(code)) {
      const address = getErrorProp(current, 'address')
      const port = getErrorProp(current, 'port')
      if (typeof address === 'string' && (typeof port === 'number' || typeof port === 'string')) {
        return `${code} ${address}:${port}`
      }
      const host = getErrorProp(current, 'hostname') ?? getErrorProp(current, 'host')
      return typeof host === 'string' ? `${code} ${host}` : code
    }
    if (name === 'AbortError') return 'Request timeout'
    current = getErrorProp(current, 'cause')
  }
  return null
}

// ==================== Pull Engine ====================

export interface PullEngineOptions {
  fetcher: HttpFetcher
  importer: DataImporter
  notifier: SyncNotifier
  dsManager: Pick<DataSourceManager, 'get' | 'updateSession' | 'addSessions'>
  logger?: SyncLogger
  /** Return true when an import is already in progress for the local session. */
  isImporting?: (sessionId: string | undefined) => boolean
  /**
   * Called after a pull session completes successfully with the local session ID.
   * Used for post-import side effects (e.g. applying the platform owner profile).
   * Errors thrown by the hook never fail the pull.
   */
  onSessionImported?: (localSessionId: string) => void
}

interface DeferredSession {
  firstDeferredAt: number
  nextAttemptAt: number
  attempts: number
}

interface DeferredSource {
  sessions: Map<string, DeferredSession>
  timer?: ReturnType<typeof setTimeout>
  running: boolean
  warned: boolean
}

export class PullEngine {
  private fetcher: HttpFetcher
  private importer: DataImporter
  private notifier: SyncNotifier
  private dsManager: PullEngineOptions['dsManager']
  private logger: SyncLogger
  private isImporting: (sessionId: string | undefined) => boolean
  private onSessionImported?: (localSessionId: string) => void
  private pullingSourceIds = new Set<string>()
  private activeSessionPulls = new Map<string, Promise<PullSessionResult>>()
  private importQueueTail = Promise.resolve()
  private deferredSources = new Map<string, DeferredSource>()
  private retryImports = true
  private progressMap = new Map<string, PullProgress>()
  private sourceUnavailableLogs = new Map<string, { detail: string; lastLoggedAt: number }>()
  private readonly sessionImportedListeners = new Set<(sessionId: string) => void>()

  constructor(options: PullEngineOptions) {
    this.fetcher = options.fetcher
    this.importer = options.importer
    this.notifier = options.notifier
    this.dsManager = options.dsManager
    this.logger = options.logger ?? NOOP_LOGGER
    this.isImporting = options.isImporting ?? (() => false)
    this.onSessionImported = options.onSessionImported
  }

  getProgress(): PullProgress[] {
    return Array.from(this.progressMap.values())
  }

  getPendingImportSessionIds(sourceId: string): string[] {
    const sessions = this.deferredSources.get(sourceId)?.sessions
    return sessions ? Array.from(sessions.keys()) : []
  }

  subscribeSessionImported(listener: (sessionId: string) => void): () => void {
    this.sessionImportedListeners.add(listener)
    return () => {
      this.sessionImportedListeners.delete(listener)
    }
  }

  private importTempFile(baseUrl: string, sess: ImportSession, tempFile: string): Promise<ImportResult> {
    const writePage = this.importQueueTail.then(() => {
      const externalId = deriveLocalSessionId(baseUrl, sess.remoteSessionId)
      let targetId = sess.targetSessionId
      if (!targetId && this.importer.sessionExists(externalId)) {
        targetId = externalId
        this.logger.info(`[Pull] Reusing existing local session ${targetId} for "${sess.name}"`)
      }
      return this.importer.importFile(tempFile, targetId || undefined, externalId)
    })
    // A rejected page must not prevent the next source's page from running.
    this.importQueueTail = writePage.then(
      () => {},
      () => {}
    )
    return writePage
  }

  private deferRetryableImport(sess: ImportSession, newMessageCount: number, error?: string): PullSessionResult {
    if (newMessageCount > 0) this.notifier.onSessionListChanged(sess.targetSessionId)
    this.markProgressDone(sess.id)
    return { success: false, newMessageCount, error: error || 'Import deferred', retryable: true }
  }

  startImportRetries(): void {
    this.retryImports = true
  }

  stopImportRetries(): void {
    this.retryImports = false
    for (const deferred of this.deferredSources.values()) timers.clearTimeout(deferred.timer)
    this.deferredSources.clear()
  }

  private scheduleImportRetry(sourceId: string, sess: ImportSession, detail?: string): void {
    if (!this.retryImports) return
    let deferred = this.deferredSources.get(sourceId)
    if (!deferred) {
      deferred = { sessions: new Map(), running: false, warned: false }
      this.deferredSources.set(sourceId, deferred)
    }
    if (deferred.sessions.has(sess.id)) return
    const now = Date.now()
    deferred.sessions.set(sess.id, {
      firstDeferredAt: now,
      nextAttemptAt: now + IMPORT_RETRY_DELAYS_MS[0],
      attempts: 0,
    })
    this.logger.info(`[Pull] Deferring "${sess.name}": ${detail}; queued for retry`)
    this.armImportRetry(sourceId, deferred)
  }

  private armImportRetry(sourceId: string, deferred: DeferredSource): void {
    if (this.deferredSources.get(sourceId) !== deferred) return
    timers.clearTimeout(deferred.timer)
    if (deferred.sessions.size === 0) {
      this.deferredSources.delete(sourceId)
    } else if (!deferred.running) {
      const next = Math.min(...Array.from(deferred.sessions.values(), (session) => session.nextAttemptAt))
      deferred.timer = timers.setTimeout(
        () => void this.retryDeferredSource(sourceId, deferred),
        Math.max(0, next - Date.now())
      )
      deferred.timer.unref?.()
    }
  }

  private async retryDeferredSource(sourceId: string, deferred: DeferredSource): Promise<void> {
    if (this.deferredSources.get(sourceId) !== deferred) return
    deferred.running = true
    try {
      const ds = this.dsManager.get(sourceId)
      if (!ds?.enabled || ds.intervalMinutes < 1) {
        deferred.sessions.clear()
        return
      }
      const now = Date.now()
      const oldest = Math.min(...Array.from(deferred.sessions.values(), (session) => session.firstDeferredAt))
      if (!deferred.warned && now - oldest >= IMPORT_RETRY_WARNING_MS) {
        deferred.warned = true
        const attempts = Array.from(deferred.sessions.values()).reduce((sum, session) => sum + session.attempts, 0)
        this.logger.warn(
          `[Pull] Source ${sourceId}: ${deferred.sessions.size} sessions awaiting import retry, oldest since ${new Date(oldest).toISOString()}, ${attempts} retries`
        )
      }
      for (const [sessionId, pending] of deferred.sessions) {
        if (this.deferredSources.get(sourceId) !== deferred) break
        if (pending.nextAttemptAt > now) continue
        pending.attempts++
        const result = await this.joinSessionPull(sourceId, sessionId, deferred)
        const delay = IMPORT_RETRY_DELAYS_MS[Math.min(pending.attempts, IMPORT_RETRY_DELAYS_MS.length - 1)]
        pending.nextAttemptAt = Date.now() + delay
        if (result.sourceUnavailable && result.error) {
          this.logSourceUnavailable(ds, result.error, deferred.sessions.size)
          this.postponeSourceRetries(deferred)
          break
        }
      }
    } catch (error) {
      this.logger.error(`[Pull] Import retry failed for source ${sourceId}`, error)
      this.postponeSourceRetries(deferred)
    } finally {
      deferred.running = false
      this.armImportRetry(sourceId, deferred)
    }
  }

  private postponeSourceRetries(deferred: DeferredSource): void {
    const next = Date.now() + IMPORT_RETRY_MAX_DELAY_MS
    for (const pending of deferred.sessions.values()) pending.nextAttemptAt = Math.max(pending.nextAttemptAt, next)
  }

  private clearImportRetry(sourceId: string, sessionId: string, recovered = false): void {
    const deferred = this.deferredSources.get(sourceId)
    const pending = deferred?.sessions.get(sessionId)
    if (!deferred || !pending) return
    deferred.sessions.delete(sessionId)
    if (recovered) {
      this.logger.info(
        `[Pull] Import recovered for ${sourceId}/${sessionId} after ${Date.now() - pending.firstDeferredAt}ms`
      )
    }
    this.armImportRetry(sourceId, deferred)
  }

  executePullSession(sourceId: string, sessionId: string): Promise<PullSessionResult> {
    return this.joinSessionPull(sourceId, sessionId)
  }

  private joinSessionPull(sourceId: string, sessionId: string, deferred?: DeferredSource): Promise<PullSessionResult> {
    const key = `${sourceId}/${sessionId}`
    const active = this.activeSessionPulls.get(key)
    if (active) return active

    const pull = Promise.resolve()
      .then(() => this.runSessionPull(sourceId, sessionId, deferred))
      .finally(() => this.activeSessionPulls.delete(key))
    this.activeSessionPulls.set(key, pull)
    return pull
  }

  private async runSessionPull(
    sourceId: string,
    sessionId: string,
    deferred?: DeferredSource
  ): Promise<PullSessionResult> {
    const ds = this.dsManager.get(sourceId)
    const sess = ds?.sessions.find((session) => session.id === sessionId)
    if (!ds || !sess || (deferred && (!ds.enabled || ds.intervalMinutes < 1))) {
      this.clearImportRetry(sourceId, sessionId)
      return { success: true, newMessageCount: 0 }
    }
    if (deferred && this.deferredSources.get(sourceId) !== deferred) return { success: true, newMessageCount: 0 }

    const result = await this.pullSession(ds, sess)
    if (result.retryable && ds.enabled && ds.intervalMinutes >= 1) {
      this.scheduleImportRetry(sourceId, sess, result.error)
    } else if (result.success || !result.sourceUnavailable) {
      this.clearImportRetry(sourceId, sess.id, result.success)
    }
    return result
  }

  private async pullSession(ds: DataSource, sess: ImportSession): Promise<PullSessionResult> {
    const sourceId = ds.id
    const importStatusSessionId = sess.targetSessionId || deriveLocalSessionId(ds.baseUrl, sess.remoteSessionId)
    if (this.isImporting(importStatusSessionId)) {
      return this.deferRetryableImport(sess, 0, 'Import in progress')
    }

    let totalNewMessages = 0
    let since = sess.lastPullAt
    let offset: number | undefined
    let nextPullSince = sess.lastPullAt
    let pageCount = 0
    let resyncAttempted = false

    this.progressMap.set(sess.id, { sessionId: sess.id, sessionName: sess.name, current: 0, pages: 0, done: false })

    try {
      while (pageCount < MAX_PAGES_PER_PULL) {
        pageCount++
        const tempFile = await this.fetcher.fetchToTempFile(ds.baseUrl, sess.remoteSessionId, ds.token, {
          since,
          offset,
          limit: ds.pullLimit,
        })

        try {
          const stat = fs.statSync(tempFile)
          this.logger.info(`[Pull] "${sess.name}" page ${pageCount}: fetched ${stat.size} bytes`)

          const sync0 = parseSyncFromFile(tempFile)
          if (stat.size < 1024 || sync0?.emptyIsFinal === true) {
            if (!fileContainsMessages(tempFile) && sync0?.hasMore === false) {
              cleanupTempFile(tempFile)
              if (sync0?.nextSince !== undefined) nextPullSince = Math.max(nextPullSince, sync0.nextSince)
              // Empty incremental responses are normal. Only initial preparation
              // needs retries; sleeping per idle chat makes large sources unusable.
              if (sync0.emptyIsFinal === true || (since > 0 && sess.targetSessionId)) break
              const retryDelays = [2000, 3000, 5000]
              let retrySuccess = false
              let retryHasMore = false
              for (let ri = 0; ri < retryDelays.length; ri++) {
                this.logger.info(
                  `[Pull] "${sess.name}" page ${pageCount} got empty response, retry ${ri + 1}/${retryDelays.length} after ${retryDelays[ri]}ms`
                )
                await new Promise((r) => setTimeout(r, retryDelays[ri]))
                const retryFile = await this.fetcher.fetchToTempFile(ds.baseUrl, sess.remoteSessionId, ds.token, {
                  since,
                  offset,
                  limit: ds.pullLimit,
                })
                const retryStat = fs.statSync(retryFile)
                this.logger.info(`[Pull] "${sess.name}" retry ${ri + 1}: fetched ${retryStat.size} bytes`)
                const retrySync = parseSyncFromFile(retryFile)
                if (
                  retrySync?.hasMore === false &&
                  (retryStat.size < 1024 || retrySync.emptyIsFinal === true) &&
                  !fileContainsMessages(retryFile)
                ) {
                  // 空 retry 页也可能只返回服务端 watermark，跳过导入前仍要推进保存游标。
                  if (retrySync.nextSince !== undefined) nextPullSince = Math.max(nextPullSince, retrySync.nextSince)
                  cleanupTempFile(retryFile)
                  if (retrySync.emptyIsFinal === true) break
                  continue
                }
                const retryMaxTs = getMaxMessageTimestampFromFile(retryFile)
                const retryResult = await this.importTempFile(ds.baseUrl, sess, retryFile)
                cleanupTempFile(retryFile)

                if (retryResult.needFullResync && !resyncAttempted) {
                  resyncAttempted = true
                  this.logger.info(`[Pull] Resetting since=0 for "${sess.name}" full resync`)
                  since = 0
                  offset = undefined
                  nextPullSince = 0
                  pageCount = 0
                  sess.targetSessionId = ''
                  sess.lastPullAt = 0
                  this.dsManager.updateSession(sourceId, sess.id, { targetSessionId: '', lastPullAt: 0 })
                  retrySuccess = true
                  retryHasMore = true
                  break
                }

                if (retryResult.needFullResync) {
                  const errMsg = 'Full resync failed'
                  this.logger.error(`[Pull] Full resync already attempted for "${sess.name}", aborting`)
                  this.dsManager.updateSession(sourceId, sess.id, {
                    lastStatus: 'error',
                    lastError: errMsg,
                  })
                  this.notifier.onPullResult(sourceId, sess.id, 'error', errMsg)
                  this.markProgressDone(sess.id)
                  return { success: false, newMessageCount: 0, error: errMsg }
                }

                if (!retryResult.success) {
                  if (retryResult.retryable) return this.deferRetryableImport(sess, totalNewMessages, retryResult.error)

                  const errMsg = retryResult.error || 'Import failed'
                  this.dsManager.updateSession(sourceId, sess.id, {
                    lastStatus: 'error',
                    lastError: errMsg,
                  })
                  this.notifier.onPullResult(sourceId, sess.id, 'error', errMsg)
                  this.markProgressDone(sess.id)
                  return { success: false, newMessageCount: 0, error: errMsg }
                }

                if (retryResult.success && retryResult.sessionId && !sess.targetSessionId) {
                  sess.targetSessionId = retryResult.sessionId
                  this.dsManager.updateSession(sourceId, sess.id, { targetSessionId: retryResult.sessionId })
                }
                totalNewMessages += retryResult.newMessageCount
                if (retryMaxTs !== null) nextPullSince = Math.max(nextPullSince, retryMaxTs)
                // retry 终止页也可能携带服务端 watermark，必须保存，否则下次会重复拉取尾部窗口。
                if (retrySync?.nextSince !== undefined) nextPullSince = Math.max(nextPullSince, retrySync.nextSince)
                this.progressMap.set(sess.id, {
                  sessionId: sess.id,
                  sessionName: sess.name,
                  current: totalNewMessages,
                  pages: pageCount,
                  done: false,
                })
                if (retrySync?.hasMore && retrySync.nextSince !== undefined) {
                  since = retrySync.nextSince
                  offset = undefined
                } else if (retrySync?.hasMore && retrySync.nextOffset !== undefined) {
                  offset = retrySync.nextOffset
                }
                retryHasMore = !!retrySync?.hasMore
                retrySuccess = true
                break
              }
              if (!retrySuccess) break
              if (!retryHasMore) break
              continue
            }
          }

          if (stat.size === 0) {
            cleanupTempFile(tempFile)
            break
          }

          const sync = sync0
          const maxMessageTs = getMaxMessageTimestampFromFile(tempFile)
          const result = await this.importTempFile(ds.baseUrl, sess, tempFile)
          cleanupTempFile(tempFile)

          if (result.needFullResync && !resyncAttempted) {
            resyncAttempted = true
            this.logger.info(`[Pull] Resetting since=0 for "${sess.name}" full resync`)
            since = 0
            offset = undefined
            nextPullSince = 0
            pageCount = 0
            sess.targetSessionId = ''
            sess.lastPullAt = 0
            this.dsManager.updateSession(sourceId, sess.id, { targetSessionId: '', lastPullAt: 0 })
            continue
          }

          if (result.needFullResync) {
            const errMsg = 'Full resync failed'
            this.logger.error(`[Pull] Full resync already attempted for "${sess.name}", aborting`)
            this.dsManager.updateSession(sourceId, sess.id, {
              lastStatus: 'error',
              lastError: errMsg,
            })
            this.notifier.onPullResult(sourceId, sess.id, 'error', errMsg)
            this.markProgressDone(sess.id)
            return { success: false, newMessageCount: 0, error: errMsg }
          }

          if (!result.success) {
            if (result.retryable) return this.deferRetryableImport(sess, totalNewMessages, result.error)

            const errMsg = result.error || 'Import failed'
            this.dsManager.updateSession(sourceId, sess.id, {
              lastStatus: 'error',
              lastError: errMsg,
            })
            this.notifier.onPullResult(sourceId, sess.id, 'error', errMsg)
            this.markProgressDone(sess.id)
            return { success: false, newMessageCount: 0, error: errMsg }
          }

          if (!sess.targetSessionId && result.sessionId) {
            sess.targetSessionId = result.sessionId
            this.dsManager.updateSession(sourceId, sess.id, { targetSessionId: result.sessionId })
          }

          totalNewMessages += result.newMessageCount
          if (maxMessageTs !== null) nextPullSince = Math.max(nextPullSince, maxMessageTs)
          this.progressMap.set(sess.id, {
            sessionId: sess.id,
            sessionName: sess.name,
            current: totalNewMessages,
            pages: pageCount,
            done: false,
          })

          if (sync?.nextSince !== undefined) nextPullSince = Math.max(nextPullSince, sync.nextSince)

          if (!sync || !sync.hasMore) break

          // 游标推进优先使用时间戳链；旧数据源只返回 nextOffset 时，继续使用 offset 续拉同一个 since 窗口。
          if (sync.nextSince !== undefined) {
            since = sync.nextSince
            offset = undefined
          } else if (sync.nextOffset !== undefined) {
            offset = sync.nextOffset
          } else {
            this.logger.warn(`[Pull] "${sess.name}" returned hasMore=true without nextSince or nextOffset, stopping`)
            break
          }
        } catch (importErr) {
          cleanupTempFile(tempFile)
          throw importErr
        }
      }

      if (pageCount >= MAX_PAGES_PER_PULL) {
        this.logger.warn(`[Pull] "${sess.name}" reached page limit (${MAX_PAGES_PER_PULL}), data may be incomplete`)
      }

      // 保留 overlap 窗口，但成功拉取未观察到更新游标时不能把已保存游标向后移动。
      const savedLastPullAt = Math.max(sess.lastPullAt, Math.max(0, nextPullSince - PULL_OVERLAP_SECONDS))
      this.dsManager.updateSession(sourceId, sess.id, {
        lastPullAt: savedLastPullAt,
        lastSuccessfulPullAt: Math.floor(Date.now() / 1000),
        lastStatus: 'success',
        lastNewMessages: totalNewMessages,
        lastError: '',
      })
      if (totalNewMessages > 0) this.notifier.onSessionListChanged(sess.targetSessionId)
      this.notifier.onPullResult(sourceId, sess.id, 'success', `+${totalNewMessages} messages`)
      this.markProgressDone(sess.id)
      if (this.onSessionImported && sess.targetSessionId) {
        try {
          this.onSessionImported(sess.targetSessionId)
        } catch (hookErr) {
          this.logger.warn(`[Pull] onSessionImported hook failed for "${sess.name}": ${hookErr}`)
        }
      }
      if (sess.targetSessionId) {
        for (const listener of this.sessionImportedListeners) {
          try {
            listener(sess.targetSessionId)
          } catch (error) {
            this.logger.warn(`[Pull] Session imported listener failed: ${error}`)
          }
        }
      }
      return { success: true, newMessageCount: totalNewMessages }
    } catch (error: any) {
      const sourceUnavailable = describeSourceUnavailableError(error)
      const errMsg = sourceUnavailable ?? getErrorMessage(error)
      if (!sourceUnavailable) {
        this.logger.error(`[Pull] Pull failed for "${sess.name}": ${errMsg}`)
      }
      this.markProgressDone(sess.id)
      try {
        // A failed config commit must not be retried as an error-status write advancing the cursor.
        if (error instanceof DataSourceConfigError) throw error
        this.dsManager.updateSession(sourceId, sess.id, {
          lastStatus: 'error',
          lastError: errMsg,
        })
      } catch (configError) {
        this.notifier.onPullResult(sourceId, sess.id, 'error', getErrorMessage(configError))
        throw configError
      }
      this.notifier.onPullResult(sourceId, sess.id, 'error', errMsg)
      return { success: false, newMessageCount: 0, error: errMsg, sourceUnavailable: !!sourceUnavailable }
    }
  }

  private markProgressDone(sessionId: string): void {
    const p = this.progressMap.get(sessionId)
    if (p) {
      p.done = true
      setTimeout(() => this.progressMap.delete(sessionId), 5000)
    }
  }

  private async discoverSessions(ds: DataSource): Promise<DataSource> {
    if (!ds.autoDiscoverSessions) return ds
    const sessions: Array<{ name: string; remoteSessionId: string }> = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const url = new URL(`${ds.baseUrl}/sessions`)
      if (cursor) url.searchParams.set('cursor', cursor)
      const response = await fetch(url, {
        headers: ds.token ? { Authorization: `Bearer ${ds.token}` } : {},
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error(`Session discovery returned HTTP ${response.status}`)
      const body = (await response.json()) as {
        sessions?: Array<{ id: string; name: string; type: string }>
        page?: { hasMore?: boolean; nextCursor?: string }
      }
      if (!Array.isArray(body.sessions)) throw new Error('Invalid session discovery response')
      for (const session of body.sessions) {
        if ((session.type === 'group' || session.type === 'private') && session.id && session.name) {
          sessions.push({ name: session.name, remoteSessionId: String(session.id) })
        }
      }
      cursor = body.page?.hasMore ? body.page.nextCursor : undefined
      if (body.page?.hasMore && (!cursor || cursors.has(cursor))) {
        throw new Error('Session discovery did not advance its cursor')
      }
      if (cursor) cursors.add(cursor)
      if (cursors.size >= MAX_PAGES_PER_PULL) throw new Error('Session discovery page limit reached')
    } while (cursor)
    // Re-read after network I/O so disabling/deleting a source takes effect before subscribing.
    const current = this.dsManager.get(ds.id)
    if (!current || !current.enabled) return { ...ds, sessions: [] }
    if (!current.autoDiscoverSessions) return current
    const known = new Set(current.sessions.map((s) => s.remoteSessionId))
    const excluded = new Set(current.excludedRemoteSessionIds)
    const added = sessions.filter((s) => !known.has(s.remoteSessionId) && !excluded.has(s.remoteSessionId))
    if (added.length) {
      this.dsManager.addSessions(ds.id, added)
      this.notifier.onSessionListChanged()
    }
    return this.dsManager.get(ds.id) ?? current
  }

  async pullAllSessions(ds: DataSource): Promise<boolean> {
    if (this.pullingSourceIds.has(ds.id)) {
      this.logger.info(`[Pull] Skipping pullAllSessions for "${ds.baseUrl}": pull already in progress`)
      return false
    }
    this.pullingSourceIds.add(ds.id)
    try {
      ds = await this.discoverSessions(ds)
      let sourceUnavailable = false
      for (let index = 0; index < ds.sessions.length; index++) {
        const sess = ds.sessions[index]
        const result = await this.executePullSession(ds.id, sess.id)
        if (result.sourceUnavailable && result.error) {
          sourceUnavailable = true
          this.markRemainingSessionsSourceUnavailable(ds, index + 1, result.error)
          this.logSourceUnavailable(ds, result.error, ds.sessions.length - index)
          break
        }
      }
      if (!sourceUnavailable) this.sourceUnavailableLogs.delete(ds.id)
      return !sourceUnavailable
    } finally {
      this.pullingSourceIds.delete(ds.id)
    }
  }

  private markRemainingSessionsSourceUnavailable(ds: DataSource, startIndex: number, detail: string): void {
    for (const sess of ds.sessions.slice(startIndex)) {
      this.dsManager.updateSession(ds.id, sess.id, {
        lastStatus: 'error',
        lastError: detail,
      })
      this.notifier.onPullResult(ds.id, sess.id, 'error', detail)
      this.markProgressDone(sess.id)
    }
  }

  private logSourceUnavailable(ds: DataSource, detail: string, affectedSessions: number): void {
    const now = Date.now()
    const previous = this.sourceUnavailableLogs.get(ds.id)
    if (previous && previous.detail === detail && now - previous.lastLoggedAt < SOURCE_UNAVAILABLE_LOG_COOLDOWN_MS) {
      return
    }
    this.sourceUnavailableLogs.set(ds.id, { detail, lastLoggedAt: now })
    this.logger.warn(`[Pull] Source ${ds.baseUrl} unavailable: ${detail}, skipped ${affectedSessions} sessions`)
  }

  /**
   * Pull only the selected sessions. Reuses the whole-source guard so a manual
   * range pull never overlaps a scheduled pull.
   */
  async pullSessions(
    sourceId: string,
    sessionIds: string[]
  ): Promise<{ success: boolean; newMessages: number; errors: string[] }> {
    const ds = this.dsManager.get(sourceId)
    if (!ds) return { success: false, newMessages: 0, errors: ['Data source not found'] }
    if (this.pullingSourceIds.has(sourceId)) {
      this.logger.info(`[Pull] Skipping pullSessions for source ${sourceId}: pull already in progress`)
      return { success: false, newMessages: 0, errors: ['Pull already in progress'] }
    }

    const wanted = new Set(sessionIds)
    this.pullingSourceIds.add(sourceId)
    try {
      const current = await this.discoverSessions(ds)
      const targets = current.sessions.filter(
        (session) => wanted.has(session.id) || wanted.has(session.remoteSessionId)
      )
      const errors: string[] = []
      let newMessages = 0
      let sourceUnavailable = false

      for (let index = 0; index < targets.length; index++) {
        const session = targets[index]
        const result = await this.executePullSession(sourceId, session.id)
        newMessages += result.newMessageCount
        if (!result.success && result.error) errors.push(`${session.name}: ${result.error}`)
        if (result.sourceUnavailable && result.error) {
          sourceUnavailable = true
          this.markRemainingSessionsSourceUnavailable({ ...current, sessions: targets }, index + 1, result.error)
          this.logSourceUnavailable(current, result.error, targets.length - index)
          break
        }
      }

      if (!sourceUnavailable) this.sourceUnavailableLogs.delete(ds.id)
      return { success: errors.length === 0, newMessages, errors }
    } finally {
      this.pullingSourceIds.delete(sourceId)
    }
  }

  async triggerPull(sourceId: string, sessionId?: string): Promise<{ success: boolean; error?: string }> {
    let ds = this.dsManager.get(sourceId)
    if (!ds) return { success: false, error: 'Data source not found' }

    if (sessionId) {
      const sess = ds.sessions.find((s) => s.id === sessionId)
      if (!sess) return { success: false, error: 'Session not found' }
      const result = await this.executePullSession(sourceId, sess.id)
      if (result.sourceUnavailable && result.error) this.logSourceUnavailable(ds, result.error, 1)
      if (result.success) this.sourceUnavailableLogs.delete(ds.id)
      return { success: result.success, error: result.error }
    }

    if (this.pullingSourceIds.has(sourceId)) {
      this.logger.info(`[Pull] Skipping triggerPull for source ${sourceId}: pull already in progress`)
      return { success: true }
    }
    this.pullingSourceIds.add(sourceId)
    try {
      ds = await this.discoverSessions(ds)
      const errors: string[] = []
      let sourceUnavailable = false
      for (let index = 0; index < ds.sessions.length; index++) {
        const sess = ds.sessions[index]
        const result = await this.executePullSession(sourceId, sess.id)
        if (!result.success && result.error) errors.push(`${sess.name}: ${result.error}`)
        if (result.sourceUnavailable && result.error) {
          sourceUnavailable = true
          this.markRemainingSessionsSourceUnavailable(ds, index + 1, result.error)
          this.logSourceUnavailable(ds, result.error, ds.sessions.length - index)
          break
        }
      }
      if (!sourceUnavailable) this.sourceUnavailableLogs.delete(ds.id)
      if (errors.length > 0) {
        return { success: false, error: errors.join('; ') }
      }
      return { success: true }
    } finally {
      this.pullingSourceIds.delete(sourceId)
    }
  }

  async triggerPullAll(sourceId: string): Promise<{ success: boolean; error?: string }> {
    return this.triggerPull(sourceId)
  }
}
