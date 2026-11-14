import assert from 'node:assert/strict'
import test from 'node:test'
import { CollectCoordinator } from './collect'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

function createClock() {
  const clock = { value: 0 }
  return {
    clock,
    now: () => clock.value,
    sleep: async (_ms: number) => {
      clock.value += 500
    },
  }
}

test('collect waits for the remote round to finish', async () => {
  const calls: string[] = []
  const restore = installFetch((url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url === 'http://source.test/health') return jsonResponse({ capabilities: ['collect'] })
    if (url.endsWith('/collect') && init?.method === 'POST') {
      return jsonResponse({ state: 'running', collectId: 'c1' }, 202)
    }
    if (url.endsWith('/collect')) {
      return jsonResponse(calls.length >= 4 ? { state: 'done', changed: 3 } : { state: 'running' })
    }
    throw new Error(`unexpected request ${url}`)
  })
  const time = createClock()
  try {
    const coordinator = new CollectCoordinator({
      now: time.now,
      sleep: time.sleep,
      pollIntervalMs: 500,
      timeoutMs: 5000,
    })
    const outcome = await coordinator.collect('http://source.test/api/v1', 'token')
    assert.equal(outcome.supported, true)
    assert.equal(outcome.state, 'done')
    assert.equal(outcome.changed, 3)
    assert.ok(calls.length >= 4)
  } finally {
    restore()
  }
})

test('sources without the capability degrade to a plain pull', async () => {
  const restore = installFetch(() => jsonResponse({ ready: true }))
  try {
    const coordinator = new CollectCoordinator({ now: () => 0 })
    const outcome = await coordinator.collect('http://source.test/api/v1', 'token')
    assert.equal(outcome.supported, false)
    assert.equal(outcome.state, 'skipped')
  } finally {
    restore()
  }
})

test('a 404 from POST /collect marks the source unsupported', async () => {
  const restore = installFetch((url, init) => {
    if (url.endsWith('/health')) return jsonResponse({ capabilities: ['collect'] })
    if (url.endsWith('/collect') && init?.method === 'POST') return jsonResponse({ error: 'Not found' }, 404)
    throw new Error(`unexpected request ${url}`)
  })
  try {
    const coordinator = new CollectCoordinator({ now: () => 0 })
    const outcome = await coordinator.collect('http://source.test/api/v1', 'token')
    assert.equal(outcome.supported, false)
    assert.equal(outcome.state, 'skipped')
  } finally {
    restore()
  }
})

test('collection times out without blocking the caller', async () => {
  const restore = installFetch((url, init) => {
    if (url.endsWith('/health')) return jsonResponse({ capabilities: ['collect'] })
    if (url.endsWith('/collect') && init?.method === 'POST') return jsonResponse({ state: 'running' }, 202)
    if (url.endsWith('/collect')) return jsonResponse({ state: 'running' })
    throw new Error(`unexpected request ${url}`)
  })
  const time = createClock()
  try {
    const coordinator = new CollectCoordinator({
      now: time.now,
      sleep: time.sleep,
      pollIntervalMs: 500,
      timeoutMs: 2000,
    })
    const outcome = await coordinator.collect('http://source.test/api/v1', 'token')
    assert.equal(outcome.supported, true)
    assert.equal(outcome.state, 'timeout')
  } finally {
    restore()
  }
})

test('a failed trigger reports failure instead of throwing', async () => {
  const restore = installFetch((url, init) => {
    if (url.endsWith('/health')) return jsonResponse({ capabilities: ['collect'] })
    if (url.endsWith('/collect') && init?.method === 'POST') return jsonResponse({ error: 'boom' }, 500)
    throw new Error(`unexpected request ${url}`)
  })
  try {
    const coordinator = new CollectCoordinator({ now: () => 0 })
    const outcome = await coordinator.collect('http://source.test/api/v1', 'token')
    assert.equal(outcome.supported, true)
    assert.equal(outcome.state, 'failed')
    assert.match(outcome.error ?? '', /500/)
  } finally {
    restore()
  }
})

test('repeated clicks within the throttle window skip a second collection', async () => {
  let requests = 0
  const restore = installFetch((url) => {
    requests += 1
    if (url.endsWith('/health')) return jsonResponse({ capabilities: ['collect'] })
    if (url.endsWith('/collect')) return jsonResponse({ state: 'done', changed: 1 })
    throw new Error(`unexpected request ${url}`)
  })
  const time = createClock()
  try {
    const coordinator = new CollectCoordinator({ now: time.now, throttleMs: 30_000 })
    const first = await coordinator.collect('http://source.test/api/v1', 'token')
    assert.equal(first.state, 'done')

    const second = await coordinator.collect('http://source.test/api/v1', 'token')
    assert.equal(second.state, 'skipped')
    assert.equal(second.supported, true)
    assert.equal(requests, 2)
  } finally {
    restore()
  }
})
