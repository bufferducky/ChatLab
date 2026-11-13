import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Fastify from 'fastify'
import { CHAT_DB_SCHEMA } from '@openchatlab/core'
import { openBetterSqliteDatabase, type SessionRuntimeAdapter } from '@openchatlab/node-runtime'
import { registerHotspotRoutes } from './hotspots'

test('hotspot routes validate windows and actions, persist group settings and report missing model configuration', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hotspot-routes-'))
  const nativeBinding = path.resolve('apps/cli/native/better_sqlite3.node')
  const db = openBetterSqliteDatabase(path.join(root, 'group.db'), { nativeBinding })
  db.exec(CHAT_DB_SCHEMA)
  db.prepare("INSERT INTO meta(name,platform,type,imported_at) VALUES ('Test group','qq','group',0)").run()
  const server = Fastify()
  registerHotspotRoutes(server, {
    pathProvider: { getUserDataDir: () => root } as Parameters<typeof registerHotspotRoutes>[1]['pathProvider'],
    nativeBinding,
    sessionAdapter: { ensureReadonly: () => db } as unknown as SessionRuntimeAdapter,
  })
  t.after(async () => {
    await server.close()
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  await server.ready()
  for (const window of ['day', 'week', 'month']) {
    const response = await server.inject({ method: 'GET', url: `/_web/hotspots?window=${window}` })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().items, [])
  }
  assert.equal((await server.inject({ method: 'GET', url: '/_web/hotspots?window=year' })).statusCode, 400)
  assert.equal(
    (await server.inject({ method: 'PATCH', url: '/_web/hotspots/anything', payload: { saved: 'yes' } })).statusCode,
    400
  )
  assert.equal(
    (await server.inject({ method: 'PUT', url: '/_web/hotspots/config', payload: { sessionIds: 'group' } })).statusCode,
    400
  )
  const config = { sessionIds: ['group'], enabled: false, locale: 'zh-CN', interests: 'AI coding' }
  assert.equal((await server.inject({ method: 'PUT', url: '/_web/hotspots/config', payload: config })).statusCode, 200)
  assert.deepEqual((await server.inject({ method: 'GET', url: '/_web/hotspots' })).json().config, {
    ...config,
    categoryPriorities: {},
    reducedTopics: [],
    reducedSessionIds: [],
    budget: { monthlyLimit: null, currency: 'CNY', modelId: '', inputPerMillion: null, outputPerMillion: null },
    obsidianVault: '',
  })
  for (const payload of [
    { reduced: true },
    { topic: true, sessionId: 'group', reduced: true },
    { topic: true, reduced: 'yes' },
  ]) {
    assert.equal(
      (await server.inject({ method: 'POST', url: '/_web/hotspots/missing/feedback', payload })).statusCode,
      400
    )
  }
  assert.equal(
    (
      await server.inject({
        method: 'PUT',
        url: '/_web/hotspots/config',
        payload: { ...config, categoryPriorities: { ai: 3 } },
      })
    ).statusCode,
    400
  )
  assert.equal(
    (await server.inject({ method: 'POST', url: '/_web/hotspots/update', payload: { rebuild: 'yes' } })).statusCode,
    400
  )
  const store = openBetterSqliteDatabase(path.join(root, 'insight', 'hotspots.db'), { nativeBinding })
  store.prepare('INSERT INTO hotspot VALUES (?,?)').run(
    'example',
    JSON.stringify({
      id: 'example',
      title: 'Shared tool',
      summary: 'A useful tool',
      why: '',
      category: 'tech',
      confidence: 'discussion',
      kind: 'tool',
      topic: 'Developer tools',
      activity: 'new',
      rounds: [],
      heatThrough: 0,
      firstSeen: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
      readAt: null,
      saved: false,
      dismissed: false,
      links: [],
      updates: [],
      sources: [{ sessionId: 'group', sessionName: 'Test group', messageId: 1, timestamp: 0, snippet: 'tool' }],
    })
  )
  store.close()
  const feedback = await server.inject({
    method: 'POST',
    url: '/_web/hotspots/example/feedback',
    payload: { topic: true, reduced: true },
  })
  assert.equal(feedback.statusCode, 200)
  assert.deepEqual(feedback.json().reducedTopics, ['Developer tools'])
  assert.equal(
    (
      await server.inject({
        method: 'POST',
        url: '/_web/hotspots/example/feedback',
        payload: { sessionId: 'another', reduced: true },
      })
    ).statusCode,
    400
  )
  for (const [url, payload] of [
    ['/_web/hotspots/search', { query: '' }],
    ['/_web/hotspots/digest', { window: 'year' }],
    ['/_web/hotspots/usage/reconcile', { amount: -1 }],
  ] as const)
    assert.equal((await server.inject({ method: 'POST', url, payload })).statusCode, 400)
  assert.equal((await server.inject({ method: 'GET', url: '/_web/hotspots/recommendations' })).statusCode, 200)
  const knowledge = await server.inject({ method: 'GET', url: '/_web/hotspots/example/knowledge' })
  assert.equal(knowledge.statusCode, 200)
  assert.ok(knowledge.json().content.includes('Shared tool'))
  assert.equal(
    (
      await server.inject({
        method: 'POST',
        url: '/_web/hotspots/example/knowledge',
        payload: { content: knowledge.json().content },
      })
    ).statusCode,
    400
  )
  const update = await server.inject({ method: 'POST', url: '/_web/hotspots/update' })
  assert.equal(update.statusCode, 400)
  assert.match(update.json().message, /LLM service is not configured/)
  assert.equal(
    (await server.inject({ method: 'PATCH', url: '/_web/hotspots/missing', payload: { saved: true } })).statusCode,
    404
  )
})
