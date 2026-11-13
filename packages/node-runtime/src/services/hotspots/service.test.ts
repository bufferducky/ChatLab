import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { DatabaseAdapter } from '@openchatlab/core'
import { CHAT_DB_SCHEMA } from '@openchatlab/core'
import { openBetterSqliteDatabase } from '../../better-sqlite3-adapter'
import type { SessionRuntimeAdapter } from '../adapters'
import type { ChatTopicModelClient } from '../topics/model-client'
import { createHotspotService } from './service'

const nativeBinding = path.resolve('apps/cli/native/better_sqlite3.node')
const day = 86400000
const initialTime = Date.parse('2026-11-13T12:00:00Z')
function fixture(t: { after: (fn: () => void | Promise<void>) => void }, handler?: (input: any) => unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlab-hotspot-test-'))
  let time = initialTime
  let calls = 0
  const databases = new Map<string, DatabaseAdapter>()
  function group(id: string, messages: Array<{ daysAgo: number; text: string }>, type = 'group') {
    const db = openBetterSqliteDatabase(path.join(dir, `${id}.db`), { nativeBinding })
    db.exec(CHAT_DB_SCHEMA)
    db.prepare("INSERT INTO meta(name,platform,type,imported_at) VALUES (?,'qq',?,?)").run(
      id,
      type,
      Math.floor(time / 1000)
    )
    db.prepare("INSERT INTO member(id,platform_id,account_name) VALUES (1,'alice','Alice')").run()
    databases.set(id, db)
    append(id, messages)
    return db
  }
  function append(id: string, messages: Array<{ daysAgo: number; text: string }>) {
    for (const m of messages)
      databases
        .get(id)!
        .prepare('INSERT INTO message(sender_id,ts,type,content) VALUES (1,?,0,?)')
        .run(Math.floor((time - m.daysAgo * day) / 1000), m.text)
  }
  const model: ChatTopicModelClient = {
    modelId: 'fixture',
    async complete(prompts) {
      calls++
      const input = JSON.parse(prompts.userPrompt)
      const events = handler
        ? handler(input)
        : input.newMessages.map((m: any) => ({
            title: m.content,
            summary: m.content,
            why: 'Useful',
            category: 'ai',
            confidence: 'discussion',
            messageIds: [m.id],
            advancement: true,
          }))
      return { text: JSON.stringify({ events }), inputTokens: 100, outputTokens: 30 }
    },
  }
  const runtime = {
    ensureReadonly: (id: string) => {
      const db = databases.get(id)
      if (!db) throw new Error('Group missing')
      return db
    },
  } as SessionRuntimeAdapter
  const deps = { dataDir: dir, nativeBinding, runtime, getModelClient: () => model, now: () => time }
  const service = createHotspotService(deps)
  t.after(async () => {
    await service.close()
    for (const db of databases.values()) db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  function configure(ids: string[], enabled = false) {
    service.configure({ sessionIds: ids, enabled, locale: 'zh-CN', interests: '' })
  }
  return {
    service,
    group,
    append,
    configure,
    deps,
    get calls() {
      return calls
    },
    advance: (days: number) => {
      time += days * day
    },
  }
}

test('rolling day/week/month windows use message time, retain favorites and never delete source chats', async (t) => {
  const f = fixture(t)
  const db = f.group('group', [
    { daysAgo: 0.2, text: 'AI today' },
    { daysAgo: 4, text: 'AI week' },
    { daysAgo: 20, text: 'AI month' },
    { daysAgo: 31, text: 'Too old' },
  ])
  f.configure(['group'])
  f.service.start()
  await f.service.waitForIdle()
  assert.deepEqual(
    ['day', 'week', 'month'].map((w) => f.service.feed(w as 'day').items.length),
    [1, 2, 3]
  )
  assert.equal(f.service.feed('month').status.backlog, 0)
  const monthly = f.service.feed('month').items.find((item) => item.title === 'AI month')!
  f.service.mark(monthly.id, { saved: true, read: true })
  f.append('group', [{ daysAgo: 2, text: 'Late imported AI news' }])
  f.service.start()
  await f.service.waitForIdle()
  assert.equal(f.service.feed('week').items.length, 3, 'late imports use the local message ID checkpoint')
  f.advance(31)
  f.service.start()
  await f.service.waitForIdle()
  assert.equal(f.service.feed('month').items.length, 0)
  assert.equal(f.service.feed('month', true).items[0].id, monthly.id)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message').get()?.n, 5)
  assert.equal(f.calls, 2, 'no new messages should avoid model calls')
})

test('cross-group repeats merge without refreshing freshness; substantive progress resets read status', async (t) => {
  let advancement = false
  const f = fixture(t, (input) =>
    input.newMessages.map((m: any) => ({
      ...(input.existing[0] ? { mergeId: input.existing[0].id } : {}),
      title: 'Model X released',
      summary: advancement ? 'New benchmark results' : 'Model X release',
      why: 'Useful',
      category: 'ai',
      confidence: 'rumor',
      messageIds: [m.id],
      advancement,
    }))
  )
  f.group('one', [{ daysAgo: 4, text: 'Model X released https://example.com/model-x' }])
  f.group('two', [{ daysAgo: 0, text: 'Model X released https://example.com/model-x' }])
  f.configure(['one', 'two'])
  f.service.start()
  await f.service.waitForIdle()
  assert.equal(f.service.feed('month').items.length, 1)
  const item = f.service.feed('month').items[0]
  assert.equal(item.sources.length, 2)
  assert.equal(f.service.feed('day').items.length, 0, 'repeat forwarding is not new progress')
  f.service.mark(item.id, { read: true, saved: true })
  advancement = true
  f.append('two', [{ daysAgo: 0, text: 'Model X benchmark results' }])
  f.service.start()
  await f.service.waitForIdle()
  const progressed = f.service.feed('day').items[0]
  assert.equal(progressed.id, item.id)
  assert.equal(progressed.readAt, null)
  assert.equal(progressed.saved, true)
  assert.equal(progressed.updates.length, 1)
  assert.equal(progressed.confidence, 'rumor')
})

test('invalid evidence retains the checkpoint; restart retries only the failed batch', async (t) => {
  let invalid = true
  const f = fixture(t, (input) => [
    {
      title: 'Test',
      summary: 'Summary',
      why: 'Useful',
      category: 'ai',
      confidence: 'discussion',
      messageIds: [invalid ? 999 : input.newMessages[0].id],
      advancement: true,
    },
  ])
  f.group('one', [{ daysAgo: 0, text: 'AI release' }])
  f.configure(['one'])
  f.service.start()
  await f.service.waitForIdle()
  assert.match(f.service.feed().status.error!, /evidence/)
  assert.equal(f.service.feed().status.backlog, 1)
  assert.equal(f.service.feed().items.length, 0)
  invalid = false
  const other = createHotspotService(f.deps)
  try {
    other.start()
    await other.waitForIdle()
    assert.equal(other.feed().items.length, 1)
    assert.equal(other.feed().status.error, null)
    other.start()
    await other.waitForIdle()
    assert.equal(f.calls, 2)
  } finally {
    await other.close()
  }
})

test('shared lease blocks concurrent model calls and preserves bookmark edits during analysis', async (t) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = fixture(t)
  f.group('one', [{ daysAgo: 0, text: 'AI release' }])
  f.configure(['one'])
  const model = f.deps.getModelClient()
  f.deps.getModelClient = () => ({
    ...model,
    async complete(prompts, options) {
      await gate
      return model.complete(prompts, options)
    },
  })
  const other = createHotspotService(f.deps)
  try {
    f.service.start()
    assert.equal(other.start().running, true)
    assert.throws(() => other.configure({ sessionIds: [], enabled: false, locale: 'en-US', interests: '' }), /Wait/)
    release()
    await f.service.waitForIdle()
    assert.equal(f.calls, 1)
    const item = other.feed().items[0]
    other.mark(item.id, { saved: true })
    assert.equal(f.service.feed().items[0].saved, true)
  } finally {
    release()
    await other.close()
  }
})

test('per-run budget rotates group coverage instead of starving later groups', async (t) => {
  const f = fixture(t, () => [])
  const ids = Array.from({ length: 14 }, (_, i) => `group-${i}`)
  for (const id of ids) f.group(id, [{ daysAgo: 0, text: 'AI news' }])
  f.configure(ids, true)
  f.service.tick()
  await f.service.waitForIdle()
  assert.equal(f.calls, 12)
  assert.equal(f.service.feed().status.backlog, 2)
  f.service.tick()
  await f.service.waitForIdle()
  assert.equal(f.calls, 12, 'automatic runs respect the interval')
  f.service.start()
  await f.service.waitForIdle()
  assert.equal(f.calls, 14)
  assert.equal(f.service.feed().status.backlog, 0)
  f.group('private', [], 'private')
  assert.throws(() => f.configure(['private']), /group/)
})

test('a seven-day preview analyzes only the requested period and retains older derived highlights', async (t) => {
  const f = fixture(t)
  f.group('one', [
    { daysAgo: 20, text: 'AI monthly release' },
    { daysAgo: 4, text: 'AI weekly release' },
    { daysAgo: 0.2, text: 'AI daily release' },
  ])
  f.configure(['one'])
  f.service.start(7)
  await f.service.waitForIdle()
  assert.equal(f.service.feed('week').items.length, 2)
  assert.equal(f.service.feed('day').items.length, 1)
  assert.equal(f.service.feed('month').items.length, 2)
  assert.equal(f.service.feed().status.backlog, 0)
  assert.throws(() => f.service.start(2 as 7), /lookback/)
})
