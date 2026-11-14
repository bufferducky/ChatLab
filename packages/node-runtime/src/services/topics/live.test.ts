import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import Database from 'better-sqlite3'
import { CHAT_DB_SCHEMA, type PathProvider } from '@openchatlab/core'
import { DatabaseManager } from '../../database-manager'
import { createDatabaseManagerAdapter } from '../adapters'
import { applyLiveTopicResponse, buildLiveTopicPrompt, DEFAULT_TOPIC_AUTOMATION, isTopicAutomationTime } from './live'
import { createChatTopicService } from './service'
import type { ChatTopicModelClient } from './model-client'
import { ChatTopicStore } from './store'
import { getChatTopicsDbPath } from './paths'

const nativeBinding = path.resolve('apps/cli/native/better_sqlite3.node')

test('the continuous response example can create a topic with a readable development', () => {
  const raw = new Database(':memory:', { nativeBinding })
  raw.exec(CHAT_DB_SCHEMA)
  raw
    .prepare(
      "INSERT INTO meta (name, platform, type, imported_at, schema_version) VALUES ('Test', 'qq', 'group', 0, 10)"
    )
    .run()
  raw.prepare("INSERT INTO member (id, platform_id, account_name) VALUES (1, 'alice', 'Alice')").run()
  const message = {
    id: 1,
    timestamp: 1794630000,
    senderName: 'Alice',
    type: 0,
    content: 'Login fails after the upgrade',
  }
  raw
    .prepare('INSERT INTO message (id, sender_id, ts, type, content) VALUES (?, 1, ?, 0, ?)')
    .run(message.id, message.timestamp, message.content)
  const db = { prepare: (sql: string) => raw.prepare(sql), exec: (sql: string) => raw.exec(sql) } as any
  const block = { index: 0, estimatedChars: 50, messages: [message] }
  try {
    const prompts = buildLiveTopicPrompt({
      db,
      sessionId: 'group',
      settings: DEFAULT_TOPIC_AUTOMATION,
      candidates: [],
      block,
      totalBlocks: 1,
    })
    const example = JSON.parse(prompts.userPrompt.match(/Example create item: (\{[^\n]+\})\./)![1]!)
    example.evidence = [{ messageId: message.id, timestamp: message.timestamp, role: 'primary' }]
    const result = applyLiveTopicResponse({
      text: JSON.stringify({ operations: [example], assignments: [{ topicRef: example.localId, messageIds: [1] }] }),
      sessionId: 'group',
      settings: DEFAULT_TOPIC_AUTOMATION,
      candidates: [],
      block,
      db,
      now: Date.now(),
    })
    assert.equal(result.topics.length, 1)
    assert.ok(result.topics[0]!.updates[0]!.text)
    assert.equal(result.topics[0]!.version, 1)
  } finally {
    raw.close()
  }
})

// These tests protect user-visible scheduling, catch-up, cross-day continuity and unread data.
function harness(t: TestContext) {
  const root = fs.mkdtempSync(path.join(process.env.CHATLAB_TEST_TMPDIR ?? os.tmpdir(), 'chatlab-live-topics-'))
  const dataDir = path.join(root, 'data')
  const databaseDir = path.join(dataDir, 'databases')
  fs.mkdirSync(databaseDir, { recursive: true })
  const db = new Database(path.join(databaseDir, 'group.db'), { nativeBinding })
  db.exec(CHAT_DB_SCHEMA)
  db.prepare(
    "INSERT INTO meta (name, platform, type, imported_at, schema_version) VALUES ('Test', 'qq', 'group', 0, 10)"
  ).run()
  db.prepare("INSERT INTO member (id, platform_id, account_name) VALUES (1, 'alice', 'Alice')").run()
  const paths: PathProvider = {
    getSystemDir: () => root,
    getUserDataDir: () => dataDir,
    getDatabaseDir: () => databaseDir,
    getVectorDir: () => path.join(root, 'vector'),
    getAiDataDir: () => path.join(root, 'ai'),
    getSettingsDir: () => path.join(root, 'settings'),
    getCacheDir: () => path.join(root, 'cache'),
    getTempDir: () => path.join(root, 'temp'),
    getLogsDir: () => path.join(root, 'logs'),
    getDownloadsDir: () => path.join(root, 'downloads'),
  }
  const identity = { version: '0.37.7', kind: 'cli' } as const
  const manager = new DatabaseManager(paths, { nativeBinding, runtime: identity })
  let clock = Date.parse('2026-11-13T09:29:00+08:00')
  let calls = 0
  let fail = false
  let repetition = false
  let omitProgress = false
  let afterCall: (() => void) | null = null
  const model: ChatTopicModelClient = {
    modelId: 'test',
    async complete(prompts) {
      calls += 1
      if (fail) throw new Error('Model temporarily unavailable')
      const messages = prompts.userPrompt
        .split('\n')
        .filter((line) => line.startsWith('{"messageId":'))
        .map((line) => JSON.parse(line) as { messageId: number; timestamp: number })
      assert.ok(messages.length)
      const existingId = prompts.userPrompt.match(/"id":"(topic:[0-9a-f]+)"/)?.[1]
      const evidence = [{ messageId: messages[0]!.messageId, timestamp: messages[0]!.timestamp, role: 'primary' }]
      const callback = afterCall
      afterCall = null
      callback?.()
      const payload = {
        operations: existingId
          ? [
              {
                operation: 'append',
                topicId: existingId,
                summary: repetition ? 'Initial problem' : 'Configuration fixed; one user reports recovery',
                progress: repetition ? '' : 'A user reports recovery after changing the callback URL',
                evidence,
              },
            ]
          : [
              {
                operation: 'create',
                localId: 'login',
                title: 'Login failure',
                summary: 'Initial problem',
                progress: 'A login failure was reported',
                state: 'active',
                evidence,
              },
            ],
        assignments: [{ topicRef: existingId ?? 'login', messageIds: messages.map((message) => message.messageId) }],
      }
      if (omitProgress) {
        for (const operation of payload.operations) Reflect.deleteProperty(operation, 'progress')
      }
      return { inputTokens: 1, outputTokens: 1, text: JSON.stringify(payload) }
    },
  }
  const create = () =>
    createChatTopicService({
      runtime: createDatabaseManagerAdapter(manager),
      pathProvider: paths,
      runtimeIdentity: identity,
      nativeBinding,
      getModelClient: () => model,
      now: () => clock,
    })
  let service = create()
  t.after(async () => {
    service.close()
    await new Promise((resolve) => setTimeout(resolve, 20))
    manager.closeAll()
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    get service() {
      return service
    },
    get calls() {
      return calls
    },
    root,
    paths,
    time(value: string) {
      clock = Date.parse(value)
    },
    insert(id: number, timestamp = clock / 1000, content = 'CPA callback login failure') {
      db.prepare('INSERT INTO message (id, sender_id, ts, type, content) VALUES (?, 1, ?, 0, ?)').run(
        id,
        timestamp,
        content
      )
    },
    fail(value: boolean) {
      fail = value
    },
    repeat(value: boolean) {
      repetition = value
    },
    omitProgress(value: boolean) {
      omitProgress = value
    },
    afterNextCall(callback: () => void) {
      afterCall = callback
    },
    restart() {
      service.close()
      service = create()
    },
  }
}

async function settle(service: ReturnType<typeof createChatTopicService>, status = 'completed') {
  for (let index = 0; index < 200; index += 1) {
    const run = service.getLatestRun('group')
    if (run?.status === status) return run
    if (run?.status === 'failed' && status !== 'failed') throw new Error(run.lastError ?? 'Topic run failed')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`Run did not reach ${status}`)
}

test('automatic summaries start at 09:30 and stop at 23:40 in the configured timezone', () => {
  for (const [time, expected] of [
    ['09:29:59', false],
    ['09:30:00', true],
    ['23:39:59', true],
    ['23:40:00', false],
    ['00:30:00', false],
  ] as const) {
    assert.equal(isTopicAutomationTime(DEFAULT_TOPIC_AUTOMATION, Date.parse(`2026-11-13T${time}+08:00`)), expected)
  }
  assert.equal(
    isTopicAutomationTime({ ...DEFAULT_TOPIC_AUTOMATION, enabled: false }, Date.parse('2026-11-13T12:00:00+08:00')),
    false
  )
})

test('nighttime pulls accumulate and morning catches up even when the latest pull adds no messages', async (t) => {
  const h = harness(t)
  h.time('2026-11-12T23:50:00+08:00')
  h.insert(1)
  h.service.noteSync('group')
  h.time('2026-11-13T03:00:00+08:00')
  h.insert(2)
  h.service.noteSync('group')
  assert.equal(h.calls, 0)
  assert.equal(h.service.getFeed('group').pendingMessages, 2)
  h.restart()
  h.time('2026-11-13T09:30:00+08:00')
  h.service.tickAutomation()
  await settle(h.service)
  assert.equal(h.calls, 1)
  assert.equal(h.service.getFeed('group').pendingMessages, 0)
  assert.deepEqual(h.service.getFeed('group').topics[0]!.messageIds, [1, 2])
  h.service.noteSync('group')
  h.service.tickAutomation()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(h.calls, 1)
})

test('a cross-day continuation keeps its identity and stale read requests cannot hide new progress', async (t) => {
  const h = harness(t)
  h.time('2026-11-13T10:00:00+08:00')
  h.insert(1)
  h.service.noteSync('group')
  await settle(h.service)
  const original = h.service.getFeed('group').topics[0]!
  h.service.markRead('group', [{ id: original.id, version: original.version }])
  h.time('2026-11-14T10:00:00+08:00')
  h.insert(2)
  h.service.noteSync('group')
  await settle(h.service)
  const updated = h.service.getFeed('group').topics[0]!
  assert.equal(updated.id, original.id)
  assert.equal(updated.title, original.title)
  assert.equal(updated.version, 2)
  assert.equal(updated.readVersion, 1)
  assert.deepEqual(updated.messageIds, [1, 2])
  assert.match(updated.updates[1]!.text, /recovery/)
  assert.deepEqual(
    updated.updates[1]!.evidence.map((item) => item.messageId),
    [2]
  )
  h.service.markRead('group', [{ id: original.id, version: 1 }])
  h.restart()
  assert.equal(h.service.getFeed('group').topics[0]!.readVersion, 1)
})

test('repeated discussion updates membership without creating another unread development', async (t) => {
  const h = harness(t)
  h.time('2026-11-13T10:00:00+08:00')
  h.insert(1)
  h.service.noteSync('group')
  await settle(h.service)
  const original = h.service.getFeed('group').topics[0]!
  h.service.markRead('group', [{ id: original.id, version: original.version }])
  h.time('2026-11-13T10:30:00+08:00')
  h.repeat(true)
  h.insert(2)
  h.service.noteSync('group')
  await settle(h.service)
  const topic = h.service.getFeed('group').topics[0]!
  assert.equal(topic.version, topic.readVersion)
  assert.equal(topic.updates.length, 1)
  assert.deepEqual(topic.messageIds, [1, 2])
})

test('provider responses omitting progress retain grounded summaries and do not mark repetitions unread', async (t) => {
  const h = harness(t)
  h.omitProgress(true)
  h.time('2026-11-13T10:00:00+08:00')
  h.insert(1)
  h.service.noteSync('group')
  await settle(h.service)
  const original = h.service.getFeed('group').topics[0]!
  assert.equal(original.updates[0]!.text, original.summary)
  h.service.markRead('group', [{ id: original.id, version: original.version }])
  h.repeat(true)
  h.insert(2)
  h.service.noteSync('group')
  await settle(h.service)
  const repeated = h.service.getFeed('group').topics[0]!
  assert.equal(repeated.version, repeated.readVersion)
  assert.equal(repeated.updates.length, 1)
  assert.deepEqual(repeated.messageIds, [1, 2])
})

test('failed updates retain the cursor and seven-day backfills use ingestion IDs without processing older history', async (t) => {
  const h = harness(t)
  h.time('2026-11-13T10:00:00+08:00')
  h.insert(1)
  h.fail(true)
  h.service.noteSync('group')
  await settle(h.service, 'failed')
  assert.equal(h.service.getFeed('group').pendingMessages, 1)
  h.fail(false)
  h.time('2026-11-13T23:50:00+08:00')
  h.service.updateFeed('group')
  await settle(h.service)
  h.insert(2, Date.parse('2026-11-10T10:00:00+08:00') / 1000)
  h.insert(3, Date.parse('2026-10-01T10:00:00+08:00') / 1000)
  h.insert(4, 1)
  h.service.noteSync('group')
  assert.equal(h.service.getFeed('group').pendingMessages, 1)
  h.service.updateFeed('group')
  await settle(h.service)
  assert.equal(h.service.getFeed('group').pendingMessages, 0)
  assert.deepEqual(h.service.getFeed('group').topics[0]!.messageIds, [2, 1])
  h.insert(5)
  h.time('2026-11-21T10:00:00+08:00')
  assert.equal(h.service.getFeed('group').pendingMessages, 0)
  const calls = h.calls
  assert.equal(h.service.updateFeed('group'), null)
  assert.equal(h.calls, calls)
  assert.equal(h.service.getFeed('group').topics.length, 1)
})

test('live tables are additive to existing daily data and session deletion clears derived live data', async (t) => {
  const h = harness(t)
  h.time('2026-11-13T10:00:00+08:00')
  h.insert(1)
  h.service.noteSync('group')
  await settle(h.service)
  h.service.close()
  const store = new ChatTopicStore(getChatTopicsDbPath(h.paths.getUserDataDir()), { nativeBinding })
  try {
    assert.ok(store.getLiveSession('group'))
    assert.equal(store.getLiveTopics('group').length, 1)
    assert.equal(store.deleteSession('group'), true)
    assert.equal(store.getLiveSession('group'), null)
    assert.equal(store.getLiveTopics('group').length, 0)
  } finally {
    store.close()
  }
})

test('crossing 23:40 stops further model calls and resumes from the committed batch the next morning', async (t) => {
  const h = harness(t)
  h.time('2026-11-13T23:39:59+08:00')
  for (let id = 1; id <= 200; id += 1) h.insert(id)
  h.afterNextCall(() => h.time('2026-11-13T23:40:00+08:00'))
  h.service.noteSync('group')
  await settle(h.service, 'paused')
  assert.equal(h.calls, 1)
  const pending = h.service.getFeed('group').pendingMessages
  assert.ok(pending > 0 && pending < 200)
  h.service.tickAutomation()
  assert.equal(h.calls, 1)
  h.time('2026-11-14T09:30:00+08:00')
  h.service.tickAutomation()
  await settle(h.service)
  assert.equal(h.service.getFeed('group').pendingMessages, 0)
  assert.equal(h.service.getFeed('group').topics[0]!.messageIds.length, 200)
  assert.equal(h.calls, 2)
})
