import assert from 'node:assert/strict'
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import type { DataSource } from './apiServer'

test('desktop collection switches to pull progress before the request finishes', async (t) => {
  await t.mock.module('@/utils/platform', { namedExports: { IS_ELECTRON: true, IS_WEB_WASM: false } })
  await t.mock.module('./session', { namedExports: { useSessionStore: () => ({ loadSessions: async () => {} }) } })
  await t.mock.module('@/services/session-index/service', {
    namedExports: { useSessionIndexService: () => ({ generateIncremental: async () => {} }) },
  })
  await t.mock.module('@/composables/useUiConfig', { namedExports: { getSessionGapThreshold: () => 1800 } })
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { apiServerApi: {} } })
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  t.mock.timers.enable({ apis: ['setInterval'] })
  const source: DataSource = {
    id: 'source',
    name: 'Source',
    baseUrl: 'http://source.test/api/v1',
    token: '',
    intervalMinutes: 30,
    pullLimit: 1000,
    enabled: true,
    createdAt: 1,
    sessions: [
      {
        id: 'subscription',
        name: 'Chat',
        remoteSessionId: 'remote',
        targetSessionId: '',
        lastPullAt: 1,
        lastStatus: 'idle',
        lastError: '',
        lastNewMessages: 0,
      },
    ],
  }
  let finish!: (response: Response) => void
  const request = new Promise<Response>((resolve) => {
    finish = resolve
  })
  let progress: Array<{ sessionId: string; current: number; pages: number; done: boolean }> = []
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = String(input)
    if (url.endsWith('/collect-and-pull')) return request
    if (url.endsWith('/sync-progress')) return Response.json(progress)
    if (url.endsWith('/data-sources')) return Response.json([source])
    throw new Error(`Unexpected URL: ${url}`)
  })
  setActivePinia(createPinia())
  const { useApiServerStore } = await import('./apiServer')
  const store = useApiServerStore()
  store.dataSources = [source]
  const running = store.collectAndPull(source.id)
  try {
    assert.equal(store.collectingIds.has(source.id), true)
    // A completed earlier pull must not hide the current collection phase.
    progress = [{ sessionId: 'subscription', current: 7, pages: 1, done: true }]
    t.mock.timers.tick(3000)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(store.collectingIds.has(source.id), true)

    progress = [{ sessionId: 'subscription', current: 12, pages: 2, done: false }]
    t.mock.timers.tick(3000)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(store.collectingIds.has(source.id), false)
    assert.deepEqual(store.syncProgress.get('subscription'), { current: 12, pages: 2 })
    assert.equal(store.pullingIds.has(source.id), true)
  } finally {
    finish(
      Response.json({
        collect: { supported: true, state: 'done', changed: 12 },
        pull: { sessions: 1, newMessages: 12, errors: [] },
      })
    )
    await running
  }
  assert.equal(store.pullingIds.size, 0)
  assert.equal(store.collectingIds.size, 0)
  assert.equal(store.syncProgress.size, 0)
})
