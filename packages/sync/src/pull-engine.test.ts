import { afterEach, describe, it } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as os from 'os'
import * as path from 'path'
import { PullEngine } from './pull-engine'
import { DataSourceManager, DataSourceConfigError } from './data-source-manager'
import type {
  DataSource,
  DataImporter,
  FetchParams,
  HttpFetcher,
  ImportSession,
  SyncLogger,
  SyncNotifier,
} from './types'

const tempFiles: string[] = []

afterEach(() => {
  for (const file of tempFiles.splice(0)) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file)
    } catch {
      /* ignore */
    }
  }
})

function writeTempJson(data: unknown): string {
  const file = path.join(os.tmpdir(), `chatlab-pull-engine-test-${process.pid}-${tempFiles.length}.json`)
  fs.writeFileSync(file, JSON.stringify(data), 'utf-8')
  tempFiles.push(file)
  return file
}

async function withImmediateTimers<T>(fn: () => Promise<T>): Promise<T> {
  const originalSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = (callback: (...args: any[]) => void) => {
    callback()
    return 0
  }
  try {
    return await fn()
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
}

function createDataSource(): DataSource {
  return {
    id: 'ds_test',
    name: 'Test Source',
    baseUrl: 'http://example.test/api/v1',
    token: '',
    intervalMinutes: 10,
    pullLimit: 1000,
    enabled: true,
    createdAt: 1,
    sessions: [],
  }
}

function createSession(): ImportSession {
  return {
    id: 'is_test',
    name: 'Test Session',
    remoteSessionId: 'remote_session',
    targetSessionId: 'local_session',
    lastPullAt: 100,
    lastStatus: 'idle',
    lastError: '',
    lastNewMessages: 0,
  }
}

function createSessionWithId(id: string): ImportSession {
  return {
    ...createSession(),
    id,
    name: `Test Session ${id}`,
    remoteSessionId: `remote_${id}`,
    targetSessionId: `local_${id}`,
  }
}

function createFetchFailedError(code = 'ECONNREFUSED'): Error {
  const cause = Object.assign(new Error(`connect ${code} 127.0.0.1:5031`), {
    code,
    address: '127.0.0.1',
    port: 5031,
  })
  return Object.assign(new TypeError('fetch failed'), { cause })
}

function createEngine(options: {
  files: string[]
  importResult: Awaited<ReturnType<DataImporter['importFile']>>
  dataSource: DataSource
  fetchError?: Error
  fetchCalls?: string[]
  isImporting?: (sessionId: string | undefined) => boolean
  fetchParams?: FetchParams[]
  sessionUpdates?: Array<{ sessionId: string; updates: Partial<ImportSession> }>
  pullResults?: Array<{ status: 'success' | 'error'; detail: string }>
  logger?: SyncLogger
}): PullEngine {
  const files = [...options.files]
  const fetcher: HttpFetcher = {
    async fetchToTempFile(
      _baseUrl: string,
      _remoteSessionId: string,
      _token: string,
      params: FetchParams
    ): Promise<string> {
      options.fetchCalls?.push(_remoteSessionId)
      if (options.fetchError) throw options.fetchError
      options.fetchParams?.push({ ...params })
      const file = files.shift()
      if (!file) throw new Error('Unexpected retry fetch')
      return file
    },
  }
  const importer: DataImporter = {
    sessionExists: () => true,
    importFile: async () => options.importResult,
  }
  const notifier: SyncNotifier = {
    onSessionListChanged: () => {},
    onPullResult: (_sourceId, _sessionId, status, detail) => {
      options.pullResults?.push({ status, detail })
    },
  }
  const dsManager = {
    get: () => options.dataSource,
    updateSession: (_sourceId: string, sessionId: string, updates: Partial<ImportSession>) => {
      options.sessionUpdates?.push({ sessionId, updates })
    },
  }

  return new PullEngine({
    fetcher,
    importer,
    notifier,
    dsManager: dsManager as any,
    isImporting: options.isImporting,
    logger: options.logger,
  })
}

describe('PullEngine', () => {
  it('gives another data source a write between pages when both scheduled pulls are active', async () => {
    const qq = { ...createDataSource(), id: 'qq', sessions: [createSessionWithId('qq')] }
    const telegram = { ...createDataSource(), id: 'telegram', sessions: [createSessionWithId('telegram')] }
    const { promise: qqWriting, resolve: signalQqWriting } = Promise.withResolvers<void>()
    const { promise: qqCanFinish, resolve: releaseQq } = Promise.withResolvers<void>()
    const { promise: telegramFetched, resolve: signalTelegramFetched } = Promise.withResolvers<void>()
    const writes: string[] = []
    const fetcher: HttpFetcher = {
      async fetchToTempFile(_url, remoteId, _token, params) {
        const firstQqPage = remoteId === 'remote_qq' && params.since === 100
        const timestamp = firstQqPage ? 200 : 400
        if (remoteId === 'remote_telegram') signalTelegramFetched()
        return writeTempJson({
          messages: [{ timestamp }],
          sync: { hasMore: firstQqPage, nextSince: timestamp },
        })
      },
    }
    const importer: DataImporter = {
      sessionExists: () => true,
      async importFile(file, targetId) {
        const { messages } = JSON.parse(fs.readFileSync(file, 'utf8'))
        const label = `${targetId}/${messages[0].timestamp}`
        writes.push(label)
        if (label === 'local_qq/200') {
          signalQqWriting()
          await qqCanFinish
        }
        return { success: true, newMessageCount: 1 }
      },
    }
    const engine = new PullEngine({
      fetcher,
      importer,
      notifier: { onSessionListChanged: () => {}, onPullResult: () => {} },
      dsManager: {
        get: (id: string) => (id === qq.id ? qq : telegram),
        addSessions: () => [],
        updateSession: (id: string, _sessionId: string, updates: Partial<ImportSession>) =>
          Object.assign((id === qq.id ? qq : telegram).sessions[0], updates),
      },
    })

    const first = engine.pullAllSessions(qq)
    await qqWriting
    const second = engine.pullAllSessions(telegram)
    await telegramFetched
    await nextTurn()
    const writesWhileQqHeldTheLock = [...writes]
    releaseQq()
    await Promise.all([first, second])

    assert.deepEqual(writesWhileQqHeldTheLock, ['local_qq/200'])
    assert.deepEqual(writes, ['local_qq/200', 'local_telegram/400', 'local_qq/400'])
    assert.equal(qq.sessions[0].lastPullAt, 340)
    assert.equal(telegram.sessions[0].lastPullAt, 340)
  })

  it('merges a due retry with a manual pull and rereads the saved cursor', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const session = createSession()
    const source = { ...createDataSource(), sessions: [session] }
    const { promise: fetched, resolve: signalFetch } = Promise.withResolvers<void>()
    const { promise: canFinish, resolve: releaseFetch } = Promise.withResolvers<void>()
    let importing = true
    const cursors: Array<number | undefined> = []
    const engine = new PullEngine({
      fetcher: {
        async fetchToTempFile(_url, _id, _token, params) {
          cursors.push(params.since)
          signalFetch()
          await canFinish
          return writeTempJson({ messages: [{ timestamp: 900 }], sync: { hasMore: false, nextSince: 900 } })
        },
      },
      importer: { sessionExists: () => true, importFile: async () => ({ success: true, newMessageCount: 1 }) },
      notifier: { onSessionListChanged: () => {}, onPullResult: () => {} },
      dsManager: {
        get: () => source,
        addSessions: () => [],
        updateSession: (_id: string, _sessionId: string, updates: Partial<ImportSession>): ImportSession =>
          Object.assign(session, updates),
      },
      isImporting: () => importing,
    })

    await engine.pullAllSessions(source)
    assert.equal(session.lastPullAt, 100)
    session.lastPullAt = 500
    importing = false

    const manual = engine.triggerPull(source.id, session.id)
    await fetched
    t.mock.timers.tick(2000)
    const secondManual = engine.triggerPull(source.id, session.id)
    await nextTurn()
    releaseFetch()
    assert.equal((await manual).success, true)
    assert.equal((await secondManual).success, true)
    t.mock.timers.tick(60_000)
    await nextTurn()

    assert.deepEqual(cursors, [500])
    assert.equal(session.lastPullAt, 840)
  })

  it('pulls only the selected sessions', async () => {
    const sessions = ['a', 'b', 'c'].map(createSessionWithId)
    const dataSource = { ...createDataSource(), sessions }
    const files = sessions.map(() =>
      writeTempJson({
        messages: [{ platformMessageId: 'm1', timestamp: 200, content: 'x' }],
        sync: { hasMore: false, nextSince: 200 },
      })
    )
    const fetchCalls: string[] = []
    const engine = createEngine({
      files,
      dataSource,
      importResult: { success: true, newMessageCount: 1 },
      fetchCalls,
    })
    const result = await engine.pullSessions(dataSource.id, ['a', 'c'])
    assert.equal(result.success, true)
    assert.equal(result.newMessages, 2)
    assert.deepEqual(fetchCalls, ['remote_a', 'remote_c'])
    assert.deepEqual(result.errors, [])
  })

  it('rejects a second range pull while one is running', async () => {
    const sessions = ['a', 'b'].map(createSessionWithId)
    const dataSource = { ...createDataSource(), sessions }
    const files = sessions.map(() =>
      writeTempJson({
        messages: [{ platformMessageId: 'm1', timestamp: 200, content: 'x' }],
        sync: { hasMore: false, nextSince: 200 },
      })
    )
    const engine = createEngine({
      files,
      dataSource,
      importResult: { success: true, newMessageCount: 0 },
    })
    const [first, second] = await Promise.all([
      engine.pullSessions(dataSource.id, ['a']),
      engine.pullSessions(dataSource.id, ['b']),
    ])
    assert.equal(first.success, true)
    assert.deepEqual(second.errors, ['Pull already in progress'])
  })

  it('publishes successful idle pulls for pending catch-up and supports unsubscribing listeners', async () => {
    const session = createSession()
    const dataSource = { ...createDataSource(), sessions: [session] }
    const payload = { messages: [], sync: { hasMore: false, nextSince: 100 } }
    const engine = createEngine({
      files: [writeTempJson(payload), writeTempJson(payload)],
      dataSource,
      importResult: { success: true, newMessageCount: 0 },
    })
    const notifications: string[] = []
    const unsubscribe = engine.subscribeSessionImported((id) => notifications.push(id))
    engine.subscribeSessionImported(() => {
      throw new Error('Post-import side effect failed')
    })
    const first = await withImmediateTimers(() => engine.executePullSession(dataSource.id, session.id))
    assert.equal(first.success, true)
    assert.deepEqual(notifications, [session.targetSessionId])
    unsubscribe()
    const second = await withImmediateTimers(() => engine.executePullSession(dataSource.id, session.id))
    assert.equal(second.success, true)
    assert.deepEqual(notifications, [session.targetSessionId])
  })
  it('finishes an idle incremental chat in one request without import or retries', async () => {
    const session = createSession()
    const source = createDataSource()
    source.sessions = [session]
    const updates: Array<{ sessionId: string; updates: Partial<ImportSession> }> = []
    const calls: string[] = []
    const engine = createEngine({
      files: [writeTempJson({ messages: [], sync: { hasMore: false, nextSince: 5000 } })],
      dataSource: source,
      fetchCalls: calls,
      sessionUpdates: updates,
      importResult: { success: false, newMessageCount: 0, error: 'Empty page must not be imported' },
    })
    const result = await engine.executePullSession(source.id, session.id)
    assert.equal(result.success, true)
    assert.equal(calls.length, 1)
    assert.equal(updates.at(-1)?.updates.lastPullAt, 4940)
  })
  it('config write failure reports failure without advancing the cursor or leaving progress running', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlab-pull-config-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const manager = new DataSourceManager(root)
    const source = manager.add({ baseUrl: 'https://example.test', token: '', intervalMinutes: 1 })
    const [session] = manager.addSessions(source.id, [{ name: 'Chat', remoteSessionId: 'remote-1' }])
    manager.updateSession(source.id, session.id, { lastPullAt: 100, targetSessionId: 'local-1' })
    const file = path.join(root, 'data-sources.json')
    const original = fs.readFileSync(file, 'utf-8')
    const emptyPage = writeTempJson({})
    const results: string[] = []
    const engine = new PullEngine({
      dsManager: manager,
      fetcher: { fetchToTempFile: async () => emptyPage },
      importer: { sessionExists: () => true, importFile: async () => ({ success: true, newMessageCount: 0 }) },
      notifier: {
        onSessionListChanged: () => {},
        onPullResult: (_sourceId, _sessionId, status) => results.push(status),
      },
    })
    const writeFileSync = fs.writeFileSync
    let failNextWrite = true
    t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
      if (failNextWrite && typeof args[0] === 'string' && path.dirname(args[0]) === root) {
        failNextWrite = false
        throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' })
      }
      return writeFileSync(...args)
    })

    await withImmediateTimers(async () => {
      await assert.rejects(engine.triggerPull(source.id, session.id), DataSourceConfigError)
      assert.deepEqual(engine.getProgress(), [])
    })
    assert.deepEqual(results, ['error'])
    assert.equal(fs.readFileSync(file, 'utf-8'), original)
    assert.equal(manager.get(source.id)?.sessions[0].lastPullAt, 100)
  })

  it('imports a small final page instead of treating it as empty', async () => {
    const session = createSession()
    const dataSource = createDataSource()
    dataSource.sessions = [session]
    const smallFinalPage = writeTempJson({
      chatlab: { version: '0.0.2', exportedAt: 100 },
      meta: { name: 'Test Session', platform: 'test', type: 'group' },
      members: [{ platformId: 'u1', accountName: 'Alice' }],
      messages: [{ sender: 'u1', timestamp: 101, type: 0, content: 'hi' }],
      sync: { hasMore: false, nextSince: 101 },
    })
    let importCount = 0
    const engine = createEngine({
      files: [smallFinalPage],
      dataSource,
      importResult: {
        success: true,
        newMessageCount: 1,
        sessionId: session.targetSessionId,
      },
    })
    ;(engine as any).importer.importFile = async () => {
      importCount++
      return { success: true, newMessageCount: 1, sessionId: session.targetSessionId }
    }

    const result = await withImmediateTimers(() => engine.executePullSession(dataSource.id, session.id))

    assert.equal(result.success, true)
    assert.equal(result.newMessageCount, 1)
    assert.equal(importCount, 1)
  })

  it('does not skip pulls when a different local session is importing', async () => {
    const session = createSession()
    session.targetSessionId = 'local_session_b'
    const dataSource = createDataSource()
    dataSource.sessions = [session]
    const page = writeTempJson({
      chatlab: { version: '0.0.2', exportedAt: 100 },
      meta: { name: 'Test Session', platform: 'test', type: 'group' },
      members: [{ platformId: 'u1', accountName: 'Alice' }],
      messages: [{ sender: 'u1', timestamp: 101, type: 0, content: 'hi' }],
      sync: { hasMore: false, nextSince: 101 },
    })
    const checkedSessionIds: Array<string | undefined> = []
    const engine = createEngine({
      files: [page],
      dataSource,
      isImporting: (sessionId) => {
        checkedSessionIds.push(sessionId)
        return sessionId === 'local_session_a'
      },
      importResult: {
        success: true,
        newMessageCount: 1,
        sessionId: session.targetSessionId,
      },
    })

    const result = await withImmediateTimers(() => engine.executePullSession(dataSource.id, session.id))

    assert.equal(result.success, true)
    assert.equal(result.newMessageCount, 1)
    assert.deepEqual(checkedSessionIds, ['local_session_b'])
  })

  it('keeps the pull cursor stable when an import is deferred by another writer', async () => {
    const session = createSession()
    const dataSource = createDataSource()
    dataSource.sessions = [session]
    const page = writeTempJson({
      chatlab: { version: '0.0.2', exportedAt: 100 },
      meta: { name: 'Test Session', platform: 'test', type: 'group' },
      members: [{ platformId: 'u1', accountName: 'Alice' }],
      messages: [{ sender: 'u1', timestamp: 101, type: 0, content: 'hi' }],
      sync: { hasMore: false, nextSince: 101 },
    })
    const sessionUpdates: Array<{ sessionId: string; updates: Partial<ImportSession> }> = []
    const engine = createEngine({
      files: [page],
      dataSource,
      sessionUpdates,
      importResult: {
        success: false,
        newMessageCount: 0,
        error: 'error.import_in_progress',
        retryable: true,
      },
    })

    const result = await withImmediateTimers(() => engine.executePullSession(dataSource.id, session.id))

    assert.equal(result.success, false)
    assert.equal(result.error, 'error.import_in_progress')
    assert.deepEqual(sessionUpdates, [])
  })

  it('keeps the pull cursor stable when a retry-page import is deferred', async () => {
    const session = createSession()
    session.lastPullAt = 0
    const dataSource = createDataSource()
    dataSource.sessions = [session]
    const emptyInitialPage = writeTempJson({
      chatlab: { version: '0.0.2', exportedAt: 100 },
      meta: { name: 'Test Session', platform: 'test', type: 'group' },
      members: [],
      messages: [],
      sync: { hasMore: false, nextSince: 100 },
    })
    const retryPage = writeTempJson({
      chatlab: { version: '0.0.2', exportedAt: 100 },
      meta: { name: 'Test Session', platform: 'test', type: 'group' },
      members: [{ platformId: 'u1', accountName: 'Alice' }],
      messages: [{ sender: 'u1', timestamp: 101, type: 0, content: 'x'.repeat(1200) }],
      sync: { hasMore: false, nextSince: 101 },
    })
    const sessionUpdates: Array<{ sessionId: string; updates: Partial<ImportSession> }> = []
    const engine = createEngine({
      files: [emptyInitialPage, retryPage],
      dataSource,
      sessionUpdates,
      importResult: {
        success: false,
        newMessageCount: 0,
        error: 'error.import_in_progress',
        retryable: true,
      },
    })

    const result = await withImmediateTimers(() => engine.executePullSession(dataSource.id, session.id))

    assert.equal(result.success, false)
    assert.equal(result.error, 'error.import_in_progress')
    assert.deepEqual(sessionUpdates, [])
  })

  it('reports retry import failure instead of marking the pull successful', async () => {
    const session = createSession()
    session.lastPullAt = 0
    const dataSource = createDataSource()
    dataSource.sessions = [session]
    const emptyInitialPage = writeTempJson({
      chatlab: { version: '0.0.2', exportedAt: 100 },
      meta: { name: 'Test Session', platform: 'test', type: 'group' },
      members: [],
      messages: [],
      sync: { hasMore: false, nextSince: 100 },
    })
    const retryPage = writeTempJson({
      chatlab: { version: '0.0.2', exportedAt: 100 },
      meta: { name: 'Test Session', platform: 'test', type: 'group' },
      members: [{ platformId: 'u1', accountName: 'Alice' }],
      messages: [
        {
          sender: 'u1',
          timestamp: 101,
          type: 0,
          content: 'x'.repeat(1200),
        },
      ],
      sync: { hasMore: false, nextSince: 101 },
    })
    const emptyTerminalPage = writeTempJson({
      chatlab: { version: '0.0.2', exportedAt: 100 },
      meta: { name: 'Test Session', platform: 'test', type: 'group' },
      members: [],
      messages: [],
      sync: { hasMore: false, nextSince: 101 },
    })
    const emptyRetryPage1 = writeTempJson({
      chatlab: { version: '0.0.2', exportedAt: 100 },
      meta: { name: 'Test Session', platform: 'test', type: 'group' },
      members: [],
      messages: [],
      sync: { hasMore: false, nextSince: 101 },
    })
    const emptyRetryPage2 = writeTempJson({
      chatlab: { version: '0.0.2', exportedAt: 100 },
      meta: { name: 'Test Session', platform: 'test', type: 'group' },
      members: [],
      messages: [],
      sync: { hasMore: false, nextSince: 101 },
    })
    const emptyRetryPage3 = writeTempJson({
      chatlab: { version: '0.0.2', exportedAt: 100 },
      meta: { name: 'Test Session', platform: 'test', type: 'group' },
      members: [],
      messages: [],
      sync: { hasMore: false, nextSince: 101 },
    })
    const sessionUpdates: Array<{ sessionId: string; updates: Partial<ImportSession> }> = []
    const pullResults: Array<{ status: 'success' | 'error'; detail: string }> = []
    const engine = createEngine({
      files: [emptyInitialPage, retryPage, emptyTerminalPage, emptyRetryPage1, emptyRetryPage2, emptyRetryPage3],
      dataSource,
      sessionUpdates,
      pullResults,
      importResult: {
        success: false,
        newMessageCount: 0,
        sessionId: session.targetSessionId,
        error: 'retry import failed',
      },
    })
    const result = await withImmediateTimers(() => engine.executePullSession(dataSource.id, session.id))

    assert.equal(result.success, false)
    assert.equal(result.error, 'retry import failed')
    assert.equal(pullResults.at(-1)?.status, 'error')
    assert.equal(sessionUpdates.at(-1)?.updates.lastStatus, 'error')
  })

  it('continues pagination with nextOffset when nextSince is absent', async () => {
    const session = createSession()
    session.lastPullAt = 0
    const dataSource = createDataSource()
    dataSource.sessions = [session]
    const firstPage = writeTempJson({
      chatlab: { version: '0.0.2', exportedAt: 100 },
      meta: { name: 'Test Session', platform: 'test', type: 'group' },
      members: [{ platformId: 'u1', accountName: 'Alice' }],
      messages: [
        { sender: 'u1', timestamp: 100, type: 0, content: 'page 1a' },
        { sender: 'u1', timestamp: 101, type: 0, content: 'page 1b' },
      ],
      sync: { hasMore: true, nextOffset: 2, watermark: 200 },
    })
    const secondPage = writeTempJson({
      chatlab: { version: '0.0.2', exportedAt: 100 },
      meta: { name: 'Test Session', platform: 'test', type: 'group' },
      members: [{ platformId: 'u1', accountName: 'Alice' }],
      messages: [{ sender: 'u1', timestamp: 200, type: 0, content: 'page 2' }],
      sync: { hasMore: false, watermark: 200 },
    })
    const fetchParams: FetchParams[] = []
    const engine = createEngine({
      files: [firstPage, secondPage],
      dataSource,
      fetchParams,
      importResult: {
        success: true,
        newMessageCount: 1,
        sessionId: session.targetSessionId,
      },
    })

    const result = await withImmediateTimers(() => engine.executePullSession(dataSource.id, session.id))

    assert.equal(result.success, true)
    assert.equal(fetchParams.length, 2)
    assert.equal(fetchParams[0]?.offset, undefined)
    assert.equal(fetchParams[1]?.offset, 2)
  })

  it('persists the imported message cursor with overlap instead of the wall clock', async () => {
    const session = createSession()
    session.lastPullAt = 0
    const dataSource = createDataSource()
    dataSource.sessions = [session]
    const page = writeTempJson({
      chatlab: { version: '0.0.2', exportedAt: 100 },
      meta: { name: 'Test Session', platform: 'test', type: 'group' },
      members: [{ platformId: 'u1', accountName: 'Alice' }],
      messages: [{ sender: 'u1', timestamp: 2000, type: 0, content: 'latest imported message' }],
      sync: { hasMore: false, watermark: 999999 },
    })
    const sessionUpdates: Array<{ sessionId: string; updates: Partial<ImportSession> }> = []
    const engine = createEngine({
      files: [page],
      dataSource,
      sessionUpdates,
      importResult: {
        success: true,
        newMessageCount: 1,
        sessionId: session.targetSessionId,
      },
    })

    const result = await withImmediateTimers(() => engine.executePullSession(dataSource.id, session.id))

    assert.equal(result.success, true)
    assert.equal(sessionUpdates.at(-1)?.updates.lastPullAt, 1940)
  })

  it('persists terminal retry nextSince when it is newer than imported messages', async () => {
    const session = createSession()
    session.lastPullAt = 0
    const dataSource = createDataSource()
    dataSource.sessions = [session]
    const emptyInitialPage = writeTempJson({
      chatlab: { version: '0.0.2', exportedAt: 100 },
      meta: { name: 'Test Session', platform: 'test', type: 'group' },
      members: [],
      messages: [],
      sync: { hasMore: false, nextSince: 100 },
    })
    const terminalRetryPage = writeTempJson({
      chatlab: { version: '0.0.2', exportedAt: 100 },
      meta: { name: 'Test Session', platform: 'test', type: 'group' },
      members: [{ platformId: 'u1', accountName: 'Alice' }],
      messages: [{ sender: 'u1', timestamp: 2000, type: 0, content: 'late retry message' }],
      sync: { hasMore: false, nextSince: 5000 },
    })
    const sessionUpdates: Array<{ sessionId: string; updates: Partial<ImportSession> }> = []
    const engine = createEngine({
      files: [emptyInitialPage, terminalRetryPage],
      dataSource,
      sessionUpdates,
      importResult: {
        success: true,
        newMessageCount: 1,
        sessionId: session.targetSessionId,
      },
    })

    const result = await withImmediateTimers(() => engine.executePullSession(dataSource.id, session.id))

    assert.equal(result.success, true)
    assert.equal(sessionUpdates.at(-1)?.updates.lastPullAt, 4940)
  })

  it('persists terminal retry nextSince from empty retry pages', async () => {
    const session = createSession()
    session.lastPullAt = 0
    const dataSource = createDataSource()
    dataSource.sessions = [session]
    const emptyPages = Array.from({ length: 4 }, () =>
      writeTempJson({
        chatlab: { version: '0.0.2', exportedAt: 100 },
        meta: { name: 'Test Session', platform: 'test', type: 'group' },
        members: [],
        messages: [],
        sync: { hasMore: false, nextSince: 5000 },
      })
    )
    const sessionUpdates: Array<{ sessionId: string; updates: Partial<ImportSession> }> = []
    const engine = createEngine({
      files: emptyPages,
      dataSource,
      sessionUpdates,
      importResult: {
        success: true,
        newMessageCount: 0,
        sessionId: session.targetSessionId,
      },
    })

    const result = await withImmediateTimers(() => engine.executePullSession(dataSource.id, session.id))

    assert.equal(result.success, true)
    assert.equal(result.newMessageCount, 0)
    assert.equal(sessionUpdates.at(-1)?.updates.lastPullAt, 4940)
  })

  it('keeps the pull cursor stable when a successful pull returns no new cursor', async () => {
    const session = createSession()
    session.lastPullAt = 100
    const dataSource = createDataSource()
    dataSource.sessions = [session]
    const emptyPages = Array.from({ length: 4 }, () =>
      writeTempJson({
        chatlab: { version: '0.0.2', exportedAt: 100 },
        meta: { name: 'Test Session', platform: 'test', type: 'group' },
        members: [],
        messages: [],
        sync: { hasMore: false },
      })
    )
    const sessionUpdates: Array<{ sessionId: string; updates: Partial<ImportSession> }> = []
    const engine = createEngine({
      files: emptyPages,
      dataSource,
      sessionUpdates,
      importResult: {
        success: true,
        newMessageCount: 0,
        sessionId: session.targetSessionId,
      },
    })

    const result = await withImmediateTimers(() => engine.executePullSession(dataSource.id, session.id))

    assert.equal(result.success, true)
    assert.equal(result.newMessageCount, 0)
    assert.equal(sessionUpdates.at(-1)?.updates.lastPullAt, 100)
  })

  it('stops the source pull after a network failure and marks remaining sessions failed', async () => {
    const dataSource = createDataSource()
    dataSource.sessions = ['a', 'b', 'c'].map(createSessionWithId)
    const sessionUpdates: Array<{ sessionId: string; updates: Partial<ImportSession> }> = []
    const pullResults: Array<{ status: 'success' | 'error'; detail: string }> = []
    const fetchCalls: string[] = []
    const warns: string[] = []
    const errors: Array<{ message: string; err?: unknown }> = []
    const engine = createEngine({
      files: [],
      dataSource,
      fetchError: createFetchFailedError(),
      fetchCalls,
      sessionUpdates,
      pullResults,
      logger: {
        info: () => {},
        warn: (message) => warns.push(message),
        error: (message, err) => errors.push({ message, err }),
      },
      importResult: {
        success: true,
        newMessageCount: 0,
      },
    })

    await engine.pullAllSessions(dataSource)

    assert.deepEqual(fetchCalls, ['remote_a'])
    assert.ok(sessionUpdates.every((item) => item.updates.lastPullAt === undefined))
    assert.equal(warns.length, 1)
    assert.match(warns[0], /Source http:\/\/example\.test\/api\/v1 unavailable: ECONNREFUSED 127\.0\.0\.1:5031/)
    assert.match(warns[0], /skipped 3 sessions/)
    assert.deepEqual(errors, [])
    assert.deepEqual(
      sessionUpdates.map((item) => [item.sessionId, item.updates.lastStatus, item.updates.lastError]),
      [
        ['a', 'error', 'ECONNREFUSED 127.0.0.1:5031'],
        ['b', 'error', 'ECONNREFUSED 127.0.0.1:5031'],
        ['c', 'error', 'ECONNREFUSED 127.0.0.1:5031'],
      ]
    )
    assert.deepEqual(
      pullResults.map((item) => [item.status, item.detail]),
      [
        ['error', 'ECONNREFUSED 127.0.0.1:5031'],
        ['error', 'ECONNREFUSED 127.0.0.1:5031'],
        ['error', 'ECONNREFUSED 127.0.0.1:5031'],
      ]
    )
  })

  it('suppresses repeated source unavailable logs during the cooldown window', async () => {
    const dataSource = createDataSource()
    dataSource.sessions = ['a', 'b'].map(createSessionWithId)
    const warns: string[] = []
    const engine = createEngine({
      files: [],
      dataSource,
      fetchError: createFetchFailedError(),
      logger: {
        info: () => {},
        warn: (message) => warns.push(message),
        error: () => {},
      },
      importResult: {
        success: true,
        newMessageCount: 0,
      },
    })

    await engine.pullAllSessions(dataSource)
    await engine.pullAllSessions(dataSource)

    assert.equal(warns.length, 1)
  })
})
