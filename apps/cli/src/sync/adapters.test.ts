import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import type { PathProvider } from '@openchatlab/core'
import { DataSourceManager, PullEngine } from '@openchatlab/sync'
import {
  DatabaseManager,
  DataDirCompatibilityError,
  IMPORT_IN_PROGRESS_ERROR_KEY,
  raiseDataDirMinRuntimeVersion,
  withDataDirImportLock,
} from '@openchatlab/node-runtime'
import { streamImport } from '../import/stream-import'
import { DirectImporter, NoopNotifier } from './adapters'

const nativeBinding = path.resolve('apps/cli/native/better_sqlite3.node')

function makeTempDir(): string {
  const baseDir = process.env.CHATLAB_TEST_TMPDIR ?? (fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir())
  return fs.mkdtempSync(path.join(baseDir, 'chatlab-cli-sync-'))
}

function createPathProvider(root: string): PathProvider {
  return {
    getSystemDir: () => root,
    getUserDataDir: () => path.join(root, 'data'),
    getDatabaseDir: () => path.join(root, 'data', 'databases'),
    getVectorDir: () => path.join(root, 'data', 'vector'),
    getAiDataDir: () => path.join(root, 'ai'),
    getSettingsDir: () => path.join(root, 'settings'),
    getCacheDir: () => path.join(root, 'cache'),
    getTempDir: () => path.join(root, 'temp'),
    getLogsDir: () => path.join(root, 'logs'),
    getDownloadsDir: () => path.join(root, 'downloads'),
  }
}

test('DirectImporter.sessionExists preserves session DBs when compatibility gate blocks access', () => {
  const root = makeTempDir()
  const pathProvider = createPathProvider(root)
  const dbDir = pathProvider.getDatabaseDir()
  fs.mkdirSync(dbDir, { recursive: true })
  const dbPath = path.join(dbDir, 'blocked.db')
  fs.writeFileSync(dbPath, 'sqlite content is not opened before the compatibility check', 'utf-8')
  raiseDataDirMinRuntimeVersion(pathProvider, {
    minRuntimeVersion: '0.26.0',
    dataCompatibilityVersion: 2,
    reason: 'future-schema',
    runtime: { version: '0.26.0', kind: 'desktop' },
    module: 'future-migration',
    now: () => 1780830000,
  })

  const manager = new DatabaseManager(pathProvider, {
    nativeBinding,
    runtime: { version: '0.25.1', kind: 'cli' },
  })
  const importer = new DirectImporter(manager)

  assert.throws(
    () => importer.sessionExists('blocked'),
    (error) => error instanceof DataDirCompatibilityError && error.code === 'DATA_DIR_REQUIRES_NEWER_RUNTIME'
  )
  assert.equal(fs.existsSync(dbPath), true)
})

test('DirectImporter marks an incremental import lock conflict as retryable', async (t) => {
  const root = makeTempDir()
  const pathProvider = createPathProvider(root)
  const manager = new DatabaseManager(pathProvider, {
    nativeBinding,
    runtime: { version: '0.30.2', kind: 'cli' },
  })
  t.after(() => {
    manager.closeAll()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const chatFile = path.join(root, 'chatlab.json')
  fs.writeFileSync(
    chatFile,
    JSON.stringify({
      chatlab: { version: '0.0.2', exportedAt: 100 },
      meta: { name: 'Test Session', platform: 'instagram', type: 'private', ownerId: 'u1' },
      members: [{ platformId: 'u1', accountName: 'Alice' }],
      messages: [{ sender: 'u1', accountName: 'Alice', timestamp: 101, type: 0, content: 'hi' }],
    }),
    'utf-8'
  )

  const seeded = await streamImport(manager, chatFile, { sessionId: 'local_session' })
  assert.equal(seeded.success, true)

  const importer = new DirectImporter(manager)
  const result = await withDataDirImportLock(manager.getUserDataDir(), () =>
    importer.importFile(chatFile, 'local_session', 'external_session')
  )

  assert.equal(result.success, false)
  assert.equal(result.error, IMPORT_IN_PROGRESS_ERROR_KEY)
  assert.equal(result.retryable, true)
})

test(
  'scheduled pull replays a partially imported chat after the data directory lock is released',
  { timeout: 5000 },
  async (t) => {
    const root = makeTempDir()
    const pathProvider = createPathProvider(root)
    const manager = new DatabaseManager(pathProvider, {
      nativeBinding,
      runtime: { version: '0.30.2', kind: 'cli' },
    })
    const dsManager = new DataSourceManager(pathProvider.getSettingsDir())
    const source = dsManager.add({ baseUrl: 'http://example.test', token: '', intervalMinutes: 30 })
    const [session] = dsManager.addSessions(source.id, [{ name: 'Test Session', remoteSessionId: 'remote' }])
    const targetId = 'local_session'
    dsManager.updateSession(source.id, session.id, { targetSessionId: targetId, lastPullAt: 100 })
    const cursors: number[] = []
    const { promise: holdLock, resolve: releaseLock } = Promise.withResolvers<void>()
    let concurrentImport: Promise<void> | undefined

    function writePage(fileName: string, id: string, timestamp: number, hasMore = false): string {
      const file = path.join(root, fileName)
      fs.writeFileSync(
        file,
        JSON.stringify({
          chatlab: { version: '0.0.2', exportedAt: 100 },
          meta: { name: 'Test Session', platform: 'telegram', type: 'group', ownerId: 'u1' },
          members: [{ platformId: 'u1', accountName: 'Alice' }],
          messages: [{ sender: 'u1', accountName: 'Alice', timestamp, type: 0, content: id, platformMessageId: id }],
          sync: { hasMore, nextSince: timestamp },
        })
      )
      return file
    }

    function storedMessageIds(): string[] {
      const db = manager.openRawSessionDatabase(targetId, { readonly: true })
      try {
        const rows = db.prepare('SELECT platform_message_id FROM message ORDER BY ts, id').all() as Array<{
          platform_message_id: string
        }>
        return rows.map((row) => row.platform_message_id)
      } finally {
        db.close()
      }
    }

    const engine = new PullEngine({
      fetcher: {
        async fetchToTempFile(_url, _id, _token, { since }) {
          cursors.push(since!)
          if (cursors.length === 2) concurrentImport = withDataDirImportLock(manager.getUserDataDir(), () => holdLock)
          return since === 100
            ? writePage(`page-${cursors.length}.json`, 'm1', 200, true)
            : writePage(`page-${cursors.length}.json`, 'm2', 400)
        },
      },
      importer: new DirectImporter(manager),
      notifier: new NoopNotifier(),
      dsManager,
    })
    t.after(async () => {
      engine.stopImportRetries()
      releaseLock()
      await concurrentImport
      manager.closeAll()
      fs.rmSync(root, { recursive: true, force: true })
    })
    const seeded = await streamImport(manager, writePage('seed.json', 'seed', 100), { sessionId: targetId })
    assert.equal(seeded.success, true, seeded.error)
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })

    await engine.pullAllSessions(dsManager.get(source.id)!)
    assert.deepEqual(storedMessageIds(), ['seed', 'm1'])
    assert.equal(dsManager.get(source.id)?.sessions[0].lastPullAt, 100)

    t.mock.timers.tick(2000)
    await nextTurn()
    assert.deepEqual(cursors, [100, 200, 100])
    assert.equal(dsManager.get(source.id)?.sessions[0].lastPullAt, 100)

    const { promise: recovered, resolve: signalRecovered } = Promise.withResolvers<void>()
    engine.subscribeSessionImported(signalRecovered)
    releaseLock()
    await concurrentImport
    t.mock.timers.tick(4999)
    await nextTurn()
    assert.deepEqual(cursors, [100, 200, 100])
    t.mock.timers.tick(1)
    await recovered

    assert.deepEqual(cursors, [100, 200, 100, 100, 200])
    assert.deepEqual(storedMessageIds(), ['seed', 'm1', 'm2'])
    const result = dsManager.get(source.id)?.sessions[0]
    assert.equal(result?.lastPullAt, 340)
    assert.equal(result?.lastStatus, 'success')
  }
)
