import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import Fastify from 'fastify'
import { openBetterSqliteDatabase } from '@openchatlab/node-runtime/src/better-sqlite3-adapter'
import { registerMessageImageRoutes } from './message-images'

test('a stored message resolves its original source ID without rewriting the message database', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'chatlab-image-routes-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const db = openBetterSqliteDatabase(':memory:', {
    nativeBinding: path.resolve('apps/cli/native/better_sqlite3.node'),
  })
  t.after(() => db.close())
  db.exec(
    "CREATE TABLE meta(platform TEXT); INSERT INTO meta VALUES('telegram'); CREATE TABLE message(id INTEGER PRIMARY KEY, platform_message_id TEXT, content TEXT); INSERT INTO message VALUES(7,'9007199254740993','[photo]');"
  )
  const remote = Fastify()
  remote.get('/api/v1/sessions/:sid/messages/:mid/images', (request) => {
    assert.equal(request.headers.authorization, 'Bearer synthetic-secret')
    assert.deepEqual(
      { ...(request.params as Record<string, string>) },
      { sid: 'telegram:1:-2', mid: '9007199254740993' }
    )
    return { images: [{ index: 0 }], caption: 'caption' }
  })
  const address = await remote.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => remote.close())
  const app = Fastify()
  const source = {
    id: 'tg',
    baseUrl: `${address}/api/v1`,
    token: 'synthetic-secret',
    sessions: [{ id: 'subscription', targetSessionId: 'local', remoteSessionId: 'telegram:1:-2' }],
  }
  registerMessageImageRoutes(app, {
    pathProvider: { getCacheDir: () => root } as Parameters<typeof registerMessageImageRoutes>[1]['pathProvider'],
    sessionAdapter: { ensureReadonly: () => db },
    automation: { dsManager: { loadAll: () => [source] } } as Parameters<
      typeof registerMessageImageRoutes
    >[1]['automation'],
  })
  t.after(() => app.close())
  const response = await app.inject('/_web/sessions/local/messages/7/images')
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json(), { images: [{ index: 0 }], caption: 'caption' })
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal((await app.inject('/_web/sessions/local/messages/7/images/0?size=invalid')).statusCode, 400)
  assert.equal((await app.inject('/_web/sessions/local/messages/8/images')).statusCode, 404)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM message').get() as { n: number }).n, 1)
  assert.equal(db.prepare('SELECT content FROM message WHERE id=7').get()?.content, '[photo]')
})

test('image failures keep the unified envelope, business code and Retry-After', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'chatlab-image-route-errors-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const db = openBetterSqliteDatabase(':memory:', {
    nativeBinding: path.resolve('apps/cli/native/better_sqlite3.node'),
  })
  t.after(() => db.close())
  db.exec(
    "CREATE TABLE meta(platform TEXT); INSERT INTO meta VALUES('qq'); CREATE TABLE message(id INTEGER PRIMARY KEY, platform_message_id TEXT, content TEXT); INSERT INTO message VALUES(7,'qq:origin:item','[image]');"
  )
  let status = 409
  let payload: Record<string, unknown> = {
    error: 'QQ account differs from the data source account',
    code: 'QQ_ACCOUNT_MISMATCH',
    retryable: false,
  }
  const remote = Fastify()
  remote.get('/api/v1/sessions/:sid/messages/:mid/images/:index', (_request, reply) => {
    reply.code(status).type('application/json').send(JSON.stringify(payload))
  })
  const address = await remote.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => remote.close())
  const app = Fastify()
  registerMessageImageRoutes(app, {
    pathProvider: { getCacheDir: () => root } as Parameters<typeof registerMessageImageRoutes>[1]['pathProvider'],
    sessionAdapter: { ensureReadonly: () => db },
    automation: {
      dsManager: {
        loadAll: () => [
          {
            id: 'qq',
            baseUrl: `${address}/api/v1`,
            token: 'synthetic-secret',
            sessions: [{ targetSessionId: 'local', remoteSessionId: 'conversation_1' }],
          },
        ],
      },
    } as Parameters<typeof registerMessageImageRoutes>[1]['automation'],
  })
  t.after(() => app.close())

  const mismatch = await app.inject('/_web/sessions/local/messages/7/images/0?size=preview')
  assert.equal(mismatch.statusCode, 409)
  assert.deepEqual(mismatch.json(), {
    success: false,
    error: {
      code: 'QQ_ACCOUNT_MISMATCH',
      message: 'QQ account differs from the data source account',
      retryable: false,
    },
  })

  status = 429
  payload = { error: 'QQ image download is busy', code: 'QQ_IMAGE_BUSY', retryable: true }
  const busy = await app.inject('/_web/sessions/local/messages/7/images/0?size=preview')
  assert.equal(busy.statusCode, 429)
  assert.equal(busy.headers['retry-after'], '2')
  assert.deepEqual(busy.json(), {
    success: false,
    error: { code: 'QQ_IMAGE_BUSY', message: 'QQ image download is busy', retryable: true },
  })

  for (const [path, statusCode] of [
    ['/_web/sessions/local/messages/7/images/0?size=huge', 400],
    ['/_web/sessions/local/messages/7/images/not-a-number', 400],
    ['/_web/sessions/local/messages/not-a-number/images', 400],
    ['/_web/sessions/local/messages/999/images', 404],
  ] as const) {
    const response = await app.inject(path)
    assert.equal(response.statusCode, statusCode)
    const body = response.json()
    assert.equal(body.success, false)
    assert.equal(body.error.code, statusCode === 400 ? 'INVALID_IMAGE_REQUEST' : 'MESSAGE_NOT_FOUND')
    assert.equal(response.headers['cache-control'], 'no-store')
  }
})
