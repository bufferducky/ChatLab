import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerAutomationRoutes } from './automation'
import type { AutomationRouteHostContext } from '../../context/automation'

interface RemoteResponse {
  status: number
  body?: unknown
}

interface RemoteRequest {
  method?: string
  path: string
  authorization?: string
  body: string
}

function createRemote(respond: (request: RemoteRequest) => RemoteResponse) {
  const seen: RemoteRequest[] = []
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const entry: RemoteRequest = {
        method: request.method,
        path: (request.url ?? '').split('?')[0],
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString('utf-8'),
      }
      seen.push(entry)
      const result = respond(entry)
      response.writeHead(result.status, { 'Content-Type': 'application/json' })
      response.end(result.body === undefined ? '' : JSON.stringify(result.body))
    })
  })
  return new Promise<{ origin: string; seen: RemoteRequest[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        origin: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      })
    })
  })
}

function createApp(automation: AutomationRouteHostContext['automation']): FastifyInstance {
  const app = Fastify()
  registerAutomationRoutes(app, { automation })
  return app
}

function createAutomation(
  sources: Array<{ baseUrl: string; token: string }>
): AutomationRouteHostContext['automation'] {
  return { dsManager: { loadAll: () => sources } } as unknown as AutomationRouteHostContext['automation']
}

test('applies the media policy to every data source and aggregates the supported ones', async (t) => {
  const remote = await createRemote((request) => {
    if (request.path === '/a/api/v1/media-policy') {
      assert.equal(request.authorization, 'Bearer token-a')
      return { status: 200, body: { videoPrefetch: true } }
    }
    if (request.path === '/b/api/v1/media-policy') {
      assert.equal(request.authorization, 'Bearer token-b')
      return { status: 200, body: { videoPrefetch: false } }
    }
    return { status: 404, body: { error: 'Not Found' } }
  })
  t.after(() => remote.close())
  const app = createApp(
    createAutomation([
      { baseUrl: `${remote.origin}/a`, token: 'token-a' },
      { baseUrl: `${remote.origin}/b/api/v1`, token: 'token-b' },
      { baseUrl: `${remote.origin}/legacy`, token: 'token-c' },
    ])
  )
  t.after(() => app.close())

  const response = await app.inject({
    method: 'PATCH',
    url: '/_web/automation/media-policy',
    payload: { videoPrefetch: true },
  })

  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json(), { videoPrefetch: true, supported: true })
  assert.deepEqual(
    remote.seen.map((request) => ({ method: request.method, path: request.path, body: request.body })),
    [
      { method: 'PUT', path: '/a/api/v1/media-policy', body: '{"videoPrefetch":true}' },
      { method: 'PUT', path: '/b/api/v1/media-policy', body: '{"videoPrefetch":true}' },
      { method: 'PUT', path: '/legacy/api/v1/media-policy', body: '{"videoPrefetch":true}' },
    ]
  )
})

test('reads the current policy from the data sources', async (t) => {
  const remote = await createRemote((request) =>
    request.path === '/a/api/v1/media-policy'
      ? { status: 200, body: { videoPrefetch: false } }
      : { status: 200, body: { videoPrefetch: true } }
  )
  t.after(() => remote.close())
  const app = createApp(
    createAutomation([
      { baseUrl: `${remote.origin}/a`, token: 'token-a' },
      { baseUrl: `${remote.origin}/b`, token: 'token-b' },
    ])
  )
  t.after(() => app.close())

  const response = await app.inject({ method: 'GET', url: '/_web/automation/media-policy' })

  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json(), { videoPrefetch: true, supported: true })
  assert.deepEqual(
    remote.seen.map((request) => request.method),
    ['GET', 'GET']
  )
})

test('ignores data sources that do not implement the endpoint', async (t) => {
  const statuses = [400, 404, 405, 501]
  const statusByPath = new Map(statuses.map((status) => [`/s${status}/api/v1/media-policy`, status]))
  const remote = await createRemote((request) => {
    const status = statusByPath.get(request.path)
    if (status === undefined) throw new Error(`Unexpected media policy request: ${request.path}`)
    return { status }
  })
  t.after(() => remote.close())
  const app = createApp(
    createAutomation(statuses.map((status) => ({ baseUrl: `${remote.origin}/s${status}`, token: 'token' })))
  )
  t.after(() => app.close())

  const response = await app.inject({
    method: 'PATCH',
    url: '/_web/automation/media-policy',
    payload: { videoPrefetch: true },
  })

  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json(), { videoPrefetch: false, supported: false })
})

test('keeps the successful value when only part of the sources answer', async (t) => {
  const remote = await createRemote((request) =>
    request.path === '/ok/api/v1/media-policy' ? { status: 200, body: { videoPrefetch: true } } : { status: 500 }
  )
  t.after(() => remote.close())
  const app = createApp(
    createAutomation([
      { baseUrl: `${remote.origin}/ok`, token: 'token-ok' },
      { baseUrl: `${remote.origin}/broken`, token: 'token-broken' },
    ])
  )
  t.after(() => app.close())

  const response = await app.inject({
    method: 'PATCH',
    url: '/_web/automation/media-policy',
    payload: { videoPrefetch: true },
  })

  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json(), { videoPrefetch: true, supported: true })
})

test('reports the first failure when no data source answers successfully', async (t) => {
  const remote = await createRemote((request) =>
    request.path === '/gone/api/v1/media-policy' ? { status: 500 } : { status: 503 }
  )
  t.after(() => remote.close())
  const app = createApp(
    createAutomation([
      { baseUrl: `${remote.origin}/gone`, token: 'token-gone' },
      { baseUrl: `${remote.origin}/unavailable`, token: 'token-unavailable' },
    ])
  )
  t.after(() => app.close())

  const response = await app.inject({ method: 'GET', url: '/_web/automation/media-policy' })

  assert.equal(response.statusCode, 502, response.body)
  assert.equal(response.json().error, 'Remote server returned HTTP 500')
})

test('reports an unsupported policy when no data source is configured', async (t) => {
  const app = createApp(createAutomation([]))
  t.after(() => app.close())

  const response = await app.inject({ method: 'GET', url: '/_web/automation/media-policy' })

  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json(), { videoPrefetch: false, supported: false })
})

test('rejects a policy body that is not a boolean without contacting any remote', async (t) => {
  const remote = await createRemote(() => ({ status: 200, body: { videoPrefetch: true } }))
  t.after(() => remote.close())
  const app = createApp(createAutomation([{ baseUrl: `${remote.origin}/a`, token: 'token-a' }]))
  t.after(() => app.close())

  for (const payload of [{ videoPrefetch: 'true' }, { videoPrefetch: 1 }, {}, { enabled: true }]) {
    const response = await app.inject({ method: 'PATCH', url: '/_web/automation/media-policy', payload })
    assert.equal(response.statusCode, 400, response.body)
    assert.deepEqual(response.json(), { error: 'Invalid media policy' })
  }
  assert.equal(remote.seen.length, 0)
})

test('answers 404 for both routes when automation is disabled', async (t) => {
  const app = createApp(undefined)
  t.after(() => app.close())

  for (const method of ['GET', 'PATCH'] as const) {
    const response = await app.inject({
      method,
      url: '/_web/automation/media-policy',
      ...(method === 'PATCH' ? { payload: { videoPrefetch: true } } : {}),
    })
    assert.equal(response.statusCode, 404, response.body)
    assert.deepEqual(response.json(), { error: 'Automation is not enabled' })
  }
})
