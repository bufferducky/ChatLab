import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { CHAT_DB_SCHEMA } from '@openchatlab/core'
import { DatabaseManager, createDatabaseManagerAdapter } from '@openchatlab/node-runtime'
import type { PathProvider } from '@openchatlab/core'
import { registerAiChatTopicRoutes } from './ai-chat-topics'

const nativeBinding = path.resolve('apps/cli/native/better_sqlite3.node')

test('chat topic routes expose persisted run state and reject generation without an LLM', async (t) => {
  const root = fs.mkdtempSync(path.join(fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir(), 'topic-routes-'))
  const pathProvider: PathProvider = {
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
  const app = Fastify()
  t.after(() => app.close())
  fs.mkdirSync(pathProvider.getDatabaseDir(), { recursive: true })
  const database = new Database(path.join(pathProvider.getDatabaseDir(), 'group.db'), { nativeBinding })
  database.exec(CHAT_DB_SCHEMA)
  database
    .prepare(
      "INSERT INTO meta (name, platform, type, imported_at, schema_version) VALUES ('Test', 'qq', 'group', 0, 10)"
    )
    .run()
  database.close()
  const manager = new DatabaseManager(pathProvider, { nativeBinding, runtime: { version: '0.35.1', kind: 'cli' } })
  t.after(() => manager.closeAll())
  registerAiChatTopicRoutes(app, {
    sessionAdapter: createDatabaseManagerAdapter(manager),
    pathProvider,
    runtimeIdentity: { version: '0.35.1', kind: 'cli' },
    nativeBinding,
  })
  await app.ready()

  const latest = await app.inject({ method: 'GET', url: '/_web/sessions/group/topics/runs/latest' })
  assert.equal(latest.statusCode, 200)
  assert.equal(latest.body, 'null')

  const start = await app.inject({
    method: 'POST',
    url: '/_web/sessions/group/topics/runs',
    payload: { rangeKind: 'today', timezone: 'Asia/Shanghai', locale: 'zh-CN' },
  })
  assert.equal(start.statusCode, 400)
  assert.match(start.json().message, /LLM service is not configured/)

  const custom = await app.inject({
    method: 'POST',
    url: '/_web/sessions/group/topics/runs',
    payload: { rangeKind: 'custom', startDay: '2026-06-01', timezone: 'Asia/Shanghai' },
  })
  assert.equal(custom.statusCode, 400)
  assert.match(custom.json().message, /LLM service is not configured/)

  const missingStartDay = await app.inject({
    method: 'POST',
    url: '/_web/sessions/group/topics/runs',
    payload: { rangeKind: 'custom', timezone: 'Asia/Shanghai' },
  })
  assert.equal(missingStartDay.statusCode, 400)
  assert.match(missingStartDay.json().message, /start day is required/)

  const invalidStartDay = await app.inject({
    method: 'POST',
    url: '/_web/sessions/group/topics/runs',
    payload: { rangeKind: 'custom', startDay: '2026-02-30', timezone: 'Asia/Shanghai' },
  })
  assert.equal(invalidStartDay.statusCode, 400)
  assert.match(invalidStartDay.json().message, /Invalid day key/)

  const feed = await app.inject({ method: 'GET', url: '/_web/sessions/group/topics/feed' })
  assert.equal(feed.statusCode, 200)
  assert.equal(feed.json().settings.startTime, '09:30')
  assert.equal(feed.json().settings.endTime, '23:40')
  assert.equal(feed.json().modelConfigured, false)

  const changed = { ...feed.json().settings, enabled: false, startTime: '10:00', endTime: '22:00' }
  const save = await app.inject({ method: 'PUT', url: '/_web/sessions/group/topics/automation', payload: changed })
  assert.equal(save.statusCode, 200)
  assert.deepEqual(save.json().settings, changed)
  const invalid = await app.inject({
    method: 'PUT',
    url: '/_web/sessions/group/topics/automation',
    payload: { ...changed, startTime: '25:00' },
  })
  assert.equal(invalid.statusCode, 400)
  assert.deepEqual(
    (await app.inject({ method: 'GET', url: '/_web/sessions/group/topics/feed' })).json().settings,
    changed
  )

  const read = await app.inject({
    method: 'POST',
    url: '/_web/sessions/group/topics/feed/read',
    payload: { topics: [{ id: 't1', version: -1 }] },
  })
  assert.equal(read.statusCode, 400)
  const emptyUpdate = await app.inject({ method: 'POST', url: '/_web/sessions/group/topics/feed/update' })
  assert.equal(emptyUpdate.statusCode, 200)
  assert.equal(emptyUpdate.body, 'null')
})
