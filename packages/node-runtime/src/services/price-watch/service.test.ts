import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createPriceWatchService, type PriceWatchMessage } from './service'
import { openPriceWatchStore, type PriceChannel, type PriceRule } from './store'
import { buildFingerprint } from './fingerprint'

/**
 * Behaviour guarded here: a rule must not push twice for the same deal, must not
 * push above the user's cap, must advance its cursor so a restart does not replay
 * old messages, and must stay silent instead of flooding when one import carries
 * many deals.
 */

const nativeBinding = path.resolve('apps/cli/native/better_sqlite3.node')
const SESSION = 'tg_test_group'

function fixture(
  t: { after: (fn: () => void | Promise<void>) => void },
  options: { messages?: PriceWatchMessage[]; rule?: Partial<PriceRule>; channel?: Partial<PriceChannel> } = {}
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlab-price-watch-'))
  const store = openPriceWatchStore(dir, nativeBinding)
  t.after(() => {
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const now = Date.now()
  const channel: PriceChannel = {
    id: 'ch-1',
    name: 'test webhook',
    type: 'webhook',
    url: 'https://example.invalid/hook',
    chatId: '',
    enabled: true,
    createdAt: now,
    ...options.channel,
  }
  store.saveChannel(channel)

  const rule: PriceRule = {
    id: 'rule-1',
    name: '显卡好价',
    sessionIds: [SESSION],
    keywords: ['4070'],
    excludeKeywords: ['收', '出'],
    maxPrice: 3999,
    historyPercentile: null,
    minHistorySamples: 5,
    cooldownMinutes: 720,
    channelIds: [channel.id],
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...options.rule,
  }
  store.saveRule(rule)

  let messages = options.messages ?? []
  const sent: string[] = []
  const calls: string[] = []
  const service = createPriceWatchService({
    store,
    loadMessages: async (_sessionId, afterId) => messages.filter((message) => message.id > afterId).slice(0, 500),
    resolveSessionName: () => '测试群',
    attemptDelaysMs: [0, 0, 0],
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  })

  return {
    store,
    service,
    sent,
    calls,
    setMessages(next: PriceWatchMessage[]) {
      messages = next
    },
  }
}

function mockFetch(t: { mock: { method: (target: unknown, name: string, impl: unknown) => void } }, calls: string[]) {
  t.mock.method(globalThis, 'fetch', async (url: string, init: { body: string }) => {
    calls.push(url)
    return { ok: true, status: 200, body: init.body } as unknown as Response
  })
}

test('pushes a deal under the price cap and records the hit', async (t) => {
  const f = fixture(t, {
    messages: [{ id: 10, ts: 1_700_000_000, content: 'RTX4070 显卡 券后3599元 速抢' }],
  })
  const calls: string[] = []
  mockFetch(t, calls)

  const result = await f.service.scanSession(SESSION)
  assert.equal(result.hits, 1)
  assert.equal(result.delivered, 1)
  assert.equal(calls.length, 1)
  assert.equal(f.store.listHits(10)[0].status, 'sent')
})

test('stays silent above the price cap but still records the observation', async (t) => {
  const f = fixture(t, {
    messages: [{ id: 11, ts: 1_700_000_000, content: 'RTX4070 显卡 券后4999元' }],
  })
  const calls: string[] = []
  mockFetch(t, calls)

  const result = await f.service.scanSession(SESSION)
  assert.equal(result.hits, 0)
  assert.equal(result.observations, 1)
  assert.equal(calls.length, 0)
})

test('matches keywords written with homophone substitutions', async (t) => {
  const f = fixture(t, {
    rule: { keywords: ['神价'], excludeKeywords: [], maxPrice: 3999 },
    messages: [{ id: 14, ts: 1_700_000_000, content: 'RTX4070 显卡 3599元 神圿快冲' }],
  })
  const calls: string[] = []
  mockFetch(t, calls)

  const result = await f.service.scanSession(SESSION)
  assert.equal(result.hits, 1)
  assert.equal(calls.length, 1)
})

test('ignores messages without the required keyword or with an excluded one', async (t) => {
  const f = fixture(t, {
    messages: [
      { id: 12, ts: 1_700_000_000, content: 'RTX3060 显卡 券后1999元' },
      { id: 13, ts: 1_700_000_100, content: 'RTX4070 收 一手 3999元' },
    ],
  })
  const calls: string[] = []
  mockFetch(t, calls)

  const result = await f.service.scanSession(SESSION)
  assert.equal(result.hits, 0)
  assert.equal(calls.length, 0)
})

test('does not push the same deal twice inside the cooldown window', async (t) => {
  const f = fixture(t, {
    messages: [{ id: 14, ts: 1_700_000_000, content: 'RTX4070 显卡 券后3599元' }],
  })
  const calls: string[] = []
  mockFetch(t, calls)

  await f.service.scanSession(SESSION)
  f.setMessages([{ id: 15, ts: 1_700_000_600, content: 'RTX4070 显卡 券后3599元 再发一次' }])
  const second = await f.service.scanSession(SESSION)

  assert.equal(calls.length, 1)
  assert.equal(second.hits, 0)
  assert.equal(second.suppressed, 1)
})

test('advances the cursor so a restart does not replay handled messages', async (t) => {
  const f = fixture(t, {
    messages: [{ id: 20, ts: 1_700_000_000, content: 'RTX4070 显卡 券后3599元' }],
  })
  const calls: string[] = []
  mockFetch(t, calls)

  await f.service.scanSession(SESSION)
  const second = await f.service.scanSession(SESSION)

  assert.equal(second.messagesRead, 0)
  assert.equal(calls.length, 1)
  assert.equal(f.store.getCursors('rule-1')[0].lastMessageId, 20)
})

test('keeps the percentile condition strict once enough history exists', async (t) => {
  const f = fixture(t, {
    rule: { maxPrice: 9999, historyPercentile: 20 },
    messages: [],
  })
  const calls: string[] = []
  mockFetch(t, calls)

  // Six historical observations around 3000; 20th percentile lands near 3000
  const history = [2900, 2950, 3000, 3050, 3100, 3150]
  f.store.addObservations(
    history.map((price, index) => ({
      ruleId: 'rule-1',
      fingerprint: buildFingerprint('RTX4070 显卡 券后3000元'),
      sessionId: SESSION,
      messageId: 100 + index,
      price,
      ts: 1_600_000_000 + index,
    }))
  )

  // A price change must preserve product identity and its historical baseline.
  f.setMessages([{ id: 200, ts: 1_700_000_000, content: 'RTX4070 显卡 券后3599元' }])
  const aboveP20 = await f.service.scanSession(SESSION)

  // A price below the percentile is still a hit
  f.setMessages([{ id: 201, ts: 1_700_000_100, content: 'RTX4070 显卡 券后2899元' }])
  const belowP20 = await f.service.scanSession(SESSION)

  assert.equal(belowP20.hits, 1)
  assert.equal(aboveP20.hits, 0)
})

test('coalesces repeated deals within one imported batch', async (t) => {
  const f = fixture(t, {
    messages: [
      { id: 30, ts: 1_700_000_000, content: 'RTX4070 显卡 券后3599元' },
      { id: 31, ts: 1_700_000_100, content: 'RTX4070 显卡 券后3599元' },
    ],
  })
  const calls: string[] = []
  mockFetch(t, calls)
  const result = await f.service.scanSession(SESSION)
  assert.equal(calls.length, 1)
  assert.equal(result.hits, 1)
  assert.equal(result.suppressed, 1)
})

test('retains same-numbered messages from different groups and counts overlapping rules once', (t) => {
  const f = fixture(t)
  const observation = {
    ruleId: 'rule-1',
    fingerprint: 'same-product',
    sessionId: SESSION,
    messageId: 1,
    price: 100,
    ts: 1_700_000_000,
  }
  f.store.addObservations([observation, { ...observation, sessionId: 'another-group', price: 200 }])
  assert.deepEqual(
    f.store
      .listObservationPrices('same-product', 10)
      .map((item) => item.price)
      .sort(),
    [100, 200]
  )
  f.store.addObservations([{ ...observation, ruleId: 'rule-2' }])
  assert.deepEqual(
    f.store
      .listObservationPrices('same-product', 10)
      .map((item) => item.price)
      .sort(),
    [100, 200]
  )
})

test('caps pushes per scan and keeps the rest visible as suppressed', async (t) => {
  const messages: PriceWatchMessage[] = Array.from({ length: 7 }, (_, index) => ({
    id: 300 + index,
    ts: 1_700_000_000 + index,
    content: `RTX4070 显卡 ${4500 + index} 元 券后 ${2000 + index} 元 第${index}款`,
  }))
  const f = fixture(t, { messages })
  const calls: string[] = []
  mockFetch(t, calls)

  const result = await f.service.scanSession(SESSION)
  assert.equal(calls.length, 5)
  assert.equal(result.suppressed, 2)
  const suppressed = f.store.listHits(20).filter((hit) => hit.status === 'suppressed')
  assert.equal(suppressed.length, 2)
})

test('marks the hit failed when the endpoint rejects it', async (t) => {
  const f = fixture(t, {
    messages: [{ id: 400, ts: 1_700_000_000, content: 'RTX4070 显卡 券后3599元' }],
  })
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 500 }) as unknown as Response)

  const result = await f.service.scanSession(SESSION)
  assert.equal(result.failed, 1)
  assert.equal(f.store.listHits(10)[0].status, 'failed')
})
