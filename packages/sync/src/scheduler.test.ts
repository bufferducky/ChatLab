import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { DataSourceManager } from './data-source-manager'
import { initScheduler, reloadTimer, stopAllTimers } from './scheduler'
import type { PullEngine } from './pull-engine'
import type { DataSource } from './types'

function createFixture(t: TestContext, baseUrl = 'https://example.test') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlab-sync-scheduler-'))
  t.after(() => {
    stopAllTimers()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const dsManager = new DataSourceManager(root)
  const source = dsManager.add({ baseUrl, token: '', intervalMinutes: 1 })
  dsManager.addSessions(source.id, [{ name: 'Test chat', remoteSessionId: 'remote-1' }])
  const pulls: string[] = []
  const pullEngine = {
    startImportRetries: () => {},
    stopImportRetries: () => {},
    async pullAllSessions(ds: DataSource) {
      pulls.push(ds.id)
      return true
    },
  } as PullEngine
  return { file: path.join(root, 'data-sources.json'), dsManager, source, pulls, pullEngine }
}

test('corrupt config pauses scheduler initialization without blocking the host and can be retried after repair', (t) => {
  const { file, dsManager, source, pulls, pullEngine } = createFixture(t)
  const original = fs.readFileSync(file, 'utf-8')
  fs.writeFileSync(file, '[')
  assert.doesNotThrow(() => initScheduler({ dsManager, pullEngine }))
  assert.deepEqual(pulls, [])
  assert.equal(fs.readFileSync(file, 'utf-8'), '[')

  fs.writeFileSync(file, original)
  initScheduler({ dsManager, pullEngine })
  assert.deepEqual(pulls, [source.id])
})

test('a scheduled read failure stops that timer without an uncaught exception or further pulls', (t) => {
  const { file, dsManager, source, pulls, pullEngine } = createFixture(t)
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  initScheduler({ dsManager, pullEngine })
  assert.deepEqual(pulls, [source.id])
  const original = fs.readFileSync(file, 'utf-8')
  fs.writeFileSync(file, '[')
  assert.doesNotThrow(() => t.mock.timers.tick(60_000))
  assert.deepEqual(pulls, [source.id])

  fs.writeFileSync(file, original)
  t.mock.timers.tick(60_000)
  assert.deepEqual(pulls, [source.id])
  reloadTimer(source.id, true)
  t.mock.timers.tick(60_000)
  assert.deepEqual(pulls, [source.id, source.id])
})

test('a local collector refresh triggers a pull ahead of the deadline and an outage preserves the fallback', async (t) => {
  const { source, pulls, dsManager, pullEngine } = createFixture(t, 'http://127.0.0.1:5035')
  dsManager.update(source.id, { intervalMinutes: 30 })
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  let lastRefresh = 100
  let reachable = true
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    assert.equal(url.pathname, '/health')
    if (!reachable) throw new Error('Bridge unavailable')
    return Response.json({ capabilities: ['collect'], lastRefresh, refresh: { state: 'done' } })
  })
  initScheduler({ dsManager, pullEngine })
  await nextTurn()
  assert.deepEqual(pulls, [source.id])

  t.mock.timers.tick(30_000)
  await nextTurn()
  assert.deepEqual(pulls, [source.id])
  lastRefresh++
  t.mock.timers.tick(30_000)
  await nextTurn()
  assert.deepEqual(pulls, [source.id, source.id])

  reachable = false
  t.mock.timers.tick(30 * 60_000)
  await nextTurn()
  assert.deepEqual(pulls, [source.id, source.id, source.id])
})
