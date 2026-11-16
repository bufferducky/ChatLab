import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Fastify from 'fastify'
import { CHAT_DB_SCHEMA } from '@openchatlab/core'
import { openBetterSqliteDatabase, type SessionRuntimeAdapter } from '@openchatlab/node-runtime'
import { registerPriceWatchRoutes } from './price-watch'

// Guards the shared Desktop/CLI Web contract: saved rules start at the current
// message, historical backfills stay silent, and new imported deals become hits.
test('price watch routes persist rules, skip old deals and deliver newly imported messages', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'price-watch-routes-'))
  const nativeBinding = path.resolve('apps/cli/native/better_sqlite3.node')
  const db = openBetterSqliteDatabase(path.join(root, 'group.db'), { nativeBinding })
  db.exec(CHAT_DB_SCHEMA)
  db.prepare("INSERT INTO meta(name,platform,type,imported_at) VALUES ('Test group','qq','group',0)").run()
  db.prepare("INSERT INTO member(id, platform_id, account_name) VALUES (1, 'member', 'Test member')").run()
  const insert = (id: number) =>
    db
      .prepare('INSERT INTO message(id, sender_id, ts, type, content) VALUES (?, ?, ?, ?, ?)')
      .run(id, 1, Math.floor(Date.now() / 1000), 0, 'RTX4070 显卡 券后3599元')
  insert(1)
  const context = {
    pathProvider: { getUserDataDir: () => root } as Parameters<typeof registerPriceWatchRoutes>[1]['pathProvider'],
    nativeBinding,
    sessionAdapter: {
      listSessionIds: () => ['group'],
      openReadonly: () => db,
    } as unknown as SessionRuntimeAdapter,
  }
  const server = Fastify()
  registerPriceWatchRoutes(server, context)
  t.after(async () => {
    await server.close()
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const deliveries: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    deliveries.push(url)
    return new Response('{}', { status: 200 })
  })
  await server.ready()
  for (const resource of ['rules', 'channels', 'hits', 'sessions']) {
    assert.equal((await server.inject(`/_web/price-watch/${resource}`)).statusCode, 200)
  }
  const channel = await server.inject({
    method: 'POST',
    url: '/_web/price-watch/channels',
    payload: { name: 'Local test', type: 'webhook', url: 'https://example.invalid/hook' },
  })
  assert.equal(channel.statusCode, 200)
  const created = await server.inject({
    method: 'POST',
    url: '/_web/price-watch/rules',
    payload: {
      name: 'GPU deals',
      sessionIds: ['group'],
      keywords: ['4070'],
      maxPrice: 3999,
      channelIds: [channel.json().channel.id],
    },
  })
  assert.equal(created.statusCode, 200)
  const scan = () => server.inject({ method: 'POST', url: '/_web/price-watch/scan/group', payload: {} })
  assert.equal((await scan()).json().hits, 0)
  const backfill = await server.inject({
    method: 'POST',
    url: '/_web/price-watch/backfill/group',
    payload: { days: 30 },
  })
  assert.equal(backfill.statusCode, 200)
  assert.equal(backfill.json().observations, 1)
  assert.equal(deliveries.length, 0)

  insert(2)
  const scanned = await scan()
  assert.equal(scanned.statusCode, 200)
  assert.equal(scanned.json().delivered, 1)
  assert.equal(deliveries.length, 1)
  const hits = (await server.inject('/_web/price-watch/hits')).json().hits
  assert.equal(hits.length, 1)
  assert.equal(hits[0].status, 'sent')
  assert.equal((await scan()).json().messagesRead, 0)
  const removed = await server.inject({ method: 'DELETE', url: `/_web/price-watch/rules/${created.json().rule.id}` })
  assert.equal(removed.statusCode, 200)
  assert.deepEqual((await server.inject('/_web/price-watch/rules')).json().rules, [])
})
