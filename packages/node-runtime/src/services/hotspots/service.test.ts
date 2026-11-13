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
      const input = JSON.parse(prompts.userPrompt)
      if (input.window)
        return {
          text: JSON.stringify({
            overview: 'Period overview',
            sections: [{ title: 'Useful changes', text: 'Review discussion sources', refs: [input.topics[0].ref] }],
          }),
          inputTokens: 50,
          outputTokens: 20,
        }
      if (input.query)
        return {
          text: JSON.stringify({
            matches: input.topics.slice(0, 1).map((item: any) => ({ ref: item.ref, reason: 'Related to your intent' })),
          }),
          inputTokens: 50,
          outputTokens: 20,
        }
      calls++
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
            kind: 'news',
            topic: 'AI news',
            discussionMessageIds: [m.id],
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
    reopen(id: string) {
      databases.get(id)!.close()
      databases.set(id, openBetterSqliteDatabase(path.join(dir, `${id}.db`), { nativeBinding }))
    },
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
      kind: 'news',
      topic: 'Model X',
      discussionMessageIds: [],
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
      kind: 'news',
      topic: 'AI',
      discussionMessageIds: [],
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

// These cases protect visible feed selection, reading state and persisted user preferences.
function event(input: any, overrides: Record<string, unknown> = {}) {
  return {
    ...(input.existing[0] ? { mergeId: input.existing[0].id } : {}),
    title: 'CPA compatibility discussion',
    summary: 'Group members compare compatibility',
    why: 'Useful',
    category: 'ai',
    confidence: 'discussion',
    kind: 'discussion',
    topic: 'CPA compatibility',
    messageIds: input.newMessages.map((m: any) => m.id),
    discussionMessageIds: input.newMessages.map((m: any) => m.id),
    advancement: false,
    ...overrides,
  }
}

test('three independent rounds in rolling 24h resurface once; continuous chat and copies do not', async (t) => {
  const f = fixture(t, (input) => [event(input)])
  f.group('one', [{ daysAgo: 0, text: 'First compatibility report' }])
  f.group('two', [])
  f.configure(['one', 'two'])
  f.service.start()
  await f.service.waitForIdle()
  const initial = f.service.feed().items[0]
  f.service.mark(initial.id, { read: true, saved: true })
  f.advance(10 / 1440)
  f.append('one', [{ daysAgo: 0, text: 'Same conversation continues' }])
  f.service.start()
  await f.service.waitForIdle()
  assert.equal(f.service.feed().items[0].rounds.length, 1, 'batch boundary is not a new round')
  f.advance(2 / 24)
  f.append('two', [{ daysAgo: 0, text: 'First compatibility report' }])
  f.service.start()
  await f.service.waitForIdle()
  assert.equal(f.service.feed().items[0].rounds.length, 1, 'copied message is not another discussion')
  f.append('two', [{ daysAgo: 0, text: 'Another group compares a different experience' }])
  f.service.start()
  await f.service.waitForIdle()
  assert.notEqual(f.service.feed().items[0].readAt, null)
  f.append('one', [{ daysAgo: 0, text: 'Original group starts talking about compatibility again' }])
  f.service.start()
  await f.service.waitForIdle()
  const renewed = f.service.feed().items[0]
  assert.equal(renewed.rounds.length, 3)
  assert.equal(renewed.activity, 'renewed')
  assert.equal(renewed.readAt, null)
  assert.equal(renewed.saved, true)
  assert.equal(renewed.updates.length, 0, 'renewed interest must not invent substantive progress')
  f.service.mark(initial.id, { read: true })
  const readAt = f.service.feed().items[0].readAt
  f.advance(2 / 24)
  f.append('two', [{ daysAgo: 0, text: 'Fourth round with a new comparison' }])
  const restarted = createHotspotService(f.deps)
  try {
    restarted.start()
    await restarted.waitForIdle()
    assert.equal(restarted.feed().items[0].updatedAt, renewed.updatedAt)
    assert.equal(restarted.feed().items[0].readAt, readAt, 'same wave stays read after restart')
  } finally {
    await restarted.close()
  }
})

test('expired discussions and plain forwards cannot resurface old topics', async (t) => {
  let forward = false
  const f = fixture(t, (input) => [
    event(input, { discussionMessageIds: forward ? [] : input.newMessages.map((m: any) => m.id) }),
  ])
  f.group('one', [{ daysAgo: 0, text: 'First report' }])
  f.group('two', [{ daysAgo: 0, text: 'Independent second report' }])
  f.configure(['one', 'two'])
  f.service.start()
  await f.service.waitForIdle()
  const initial = f.service.feed().items[0]
  f.service.mark(initial.id, { read: true })
  f.advance(1.1)
  f.append('one', [{ daysAgo: 0, text: 'One new discussion after old rounds expire' }])
  f.service.start()
  await f.service.waitForIdle()
  assert.equal(f.service.feed().items.length, 0)
  forward = true
  f.append('two', [{ daysAgo: 0, text: 'Just forwarding https://example.com' }])
  f.service.start()
  await f.service.waitForIdle()
  assert.equal(f.service.feed().items.length, 0)
  assert.notEqual(f.service.feed('month').items[0].readAt, null)
})

test('even a model advancement flag cannot make identical copied evidence unread again', async (t) => {
  const f = fixture(t, (input) => [event(input, { advancement: true })])
  f.group('one', [{ daysAgo: 0, text: 'A concrete solution' }])
  f.configure(['one'])
  f.service.start()
  await f.service.waitForIdle()
  const item = f.service.feed().items[0]
  f.service.mark(item.id, { read: true })
  f.advance(2 / 24)
  f.append('one', [{ daysAgo: 0, text: 'A concrete solution' }])
  f.service.start()
  await f.service.waitForIdle()
  assert.notEqual(f.service.feed().items[0].readAt, null)
  assert.equal(f.service.feed().items[0].updatedAt, item.updatedAt)
})

test('highlights cap at 15, balance categories, demote unanswered questions and persist reversible feedback', async (t) => {
  const f = fixture(t, (input) =>
    input.newMessages.map((m: any) =>
      event(input, {
        mergeId: undefined,
        title: m.content,
        messageIds: [m.id],
        discussionMessageIds: [],
        kind: m.content === 'Question' ? 'question' : m.content === 'Spam' ? 'noise' : 'tool',
        category: m.content === 'Useful news' ? 'news' : 'ai',
        topic: m.content,
      })
    )
  )
  f.group('one', [])
  f.configure(['one'])
  // Separate batches reflect incremental imports and avoid exceeding the model event contract.
  for (let i = 0; i < 3; i++) {
    f.append(
      'one',
      Array.from({ length: 6 }, (_, n) => ({ daysAgo: 0, text: `AI tool ${i * 6 + n}` }))
    )
    f.service.start()
    await f.service.waitForIdle()
  }
  f.append(
    'one',
    ['Question', 'Spam', 'Useful news'].map((text) => ({ daysAgo: 0, text }))
  )
  f.service.start()
  await f.service.waitForIdle()
  let feed = f.service.feed()
  assert.equal(feed.highlights.length, 15)
  assert.ok(feed.highlights.some((id) => feed.items.find((item) => item.id === id)?.category === 'news'))
  assert.ok(!feed.items.some((item) => item.kind === 'noise'))
  assert.ok(feed.items.some((item) => item.kind === 'question' && !feed.highlights.includes(item.id)))
  const target = feed.items.find((item) => item.title === 'AI tool 0')!
  f.service.feedback(target.id, { topic: true, reduced: true })
  assert.ok(!f.service.feed().highlights.includes(target.id))
  const restarted = createHotspotService(f.deps)
  try {
    assert.deepEqual(restarted.feed().config.reducedTopics, [target.topic])
    restarted.feedback(target.id, { topic: true, reduced: false })
    assert.deepEqual(restarted.feed().config.reducedTopics, [])
    restarted.feedback(target.id, { sessionId: 'one', reduced: true })
    assert.deepEqual(restarted.feed().config.reducedSessionIds, ['one'])
    assert.ok(restarted.feed().highlights.length > 0, 'a deprioritized group still contributes useful tools')
    assert.throws(() => restarted.feedback(target.id, { sessionId: 'unknown', reduced: true }), /source/)
    restarted.configure({ ...restarted.feed().config, categoryPriorities: { ai: 0 } })
    feed = restarted.feed()
    assert.equal(feed.items[0].title, 'Useful news')
    restarted.mark(target.id, { dismissed: true, saved: true })
    assert.ok(!restarted.feed().items.some((item) => item.id === target.id))
    assert.ok(restarted.feed('month', true).items.some((item) => item.id === target.id))
  } finally {
    await restarted.close()
  }
})

test('upgrade from the local prototype preserves favorites, reading state, source evidence and cursors', async (t) => {
  const f = fixture(t)
  f.group('one', [{ daysAgo: 0, text: 'An older saved tool' }])
  f.configure(['one'])
  f.service.start()
  await f.service.waitForIdle()
  const item = f.service.feed().items[0]
  f.service.mark(item.id, { saved: true, read: true })
  const db = openBetterSqliteDatabase(path.join(f.deps.dataDir, 'insight', 'hotspots.db'), { nativeBinding })
  const old = JSON.parse(String(db.prepare('SELECT payload FROM hotspot WHERE id=?').get(item.id)!.payload))
  for (const key of ['kind', 'topic', 'activity', 'rounds', 'heatThrough']) delete old[key]
  db.prepare('UPDATE hotspot SET payload=? WHERE id=?').run(JSON.stringify(old), item.id)
  db.close()
  const restarted = createHotspotService(f.deps)
  try {
    const upgraded = restarted.feed('month', true).items[0]
    assert.equal(upgraded.saved, true)
    assert.notEqual(upgraded.readAt, null)
    assert.deepEqual(upgraded.sources, item.sources)
    assert.deepEqual(upgraded.rounds, [])
    restarted.start()
    await restarted.waitForIdle()
    assert.equal(f.calls, 1, 'upgrade must not reset the analysis checkpoint')
  } finally {
    await restarted.close()
  }
})

test('omitted optional discussion evidence keeps useful shares but forged discussion IDs retain the checkpoint', async (t) => {
  let forged = false
  const f = fixture(t, (input) => [
    event(input, {
      kind: 'tool',
      discussionMessageIds: forged ? [999] : undefined,
    }),
  ])
  f.group('one', [{ daysAgo: 0, text: 'Useful tool https://example.com' }])
  f.configure(['one'])
  f.service.start()
  await f.service.waitForIdle()
  assert.equal(f.service.feed().highlights.length, 1)
  assert.deepEqual(f.service.feed().items[0].rounds, [])
  forged = true
  f.append('one', [{ daysAgo: 0, text: 'Another tool reference' }])
  f.service.start()
  await f.service.waitForIdle()
  assert.equal(f.service.feed().status.backlog, 1)
  assert.match(f.service.feed().status.error!, /discussionIdsValid.*false/)
})

test('reanalyzing old results retires omitted noise only after success and preserves bookmarks across retry', async (t) => {
  let mode = 'initial'
  const f = fixture(t, (input) => {
    if (mode === 'fail') return [event(input, { messageIds: [999] })]
    if (mode === 'review') {
      const useful = input.existing.find((item: any) => item.title === 'Useful tool')
      return [
        event(input, {
          mergeId: useful?.id,
          title: 'Useful tool',
          kind: 'tool',
          messageIds: [input.newMessages[0].id],
          discussionMessageIds: [],
          advancement: false,
        }),
      ]
    }
    return input.newMessages.map((m: any) =>
      event(input, { title: m.content, mergeId: undefined, messageIds: [m.id], discussionMessageIds: [] })
    )
  })
  f.group('one', [
    { daysAgo: 0, text: 'Useful tool' },
    { daysAgo: 0, text: 'Old group administration noise' },
  ])
  f.configure(['one'])
  f.service.start()
  await f.service.waitForIdle()
  const useful = f.service.feed().items.find((item) => item.title === 'Useful tool')!
  const noise = f.service.feed().items.find((item) => item.id !== useful.id)!
  f.service.mark(useful.id, { saved: true, read: true })
  f.service.mark(noise.id, { saved: true })
  mode = 'fail'
  f.service.start(30, true)
  await f.service.waitForIdle()
  assert.equal(f.service.feed().items.length, 2, 'failed rebuild must keep the old results visible')
  assert.equal(f.service.feed().status.backlog, 2)
  mode = 'review'
  const restarted = createHotspotService(f.deps)
  try {
    restarted.start()
    await restarted.waitForIdle()
    assert.equal(restarted.feed().status.error, null)
    assert.deepEqual(
      restarted.feed().items.map((item) => item.id),
      [useful.id]
    )
    assert.notEqual(restarted.feed().items[0].readAt, null)
    const saved = restarted.feed('month', true).items
    assert.equal(saved.length, 2, 'retired results remain accessible as bookmarks')
    assert.equal(saved.find((item) => item.id === noise.id)!.archived, true)
    assert.equal(saved.find((item) => item.id === useful.id)!.kind, 'tool')
  } finally {
    await restarted.close()
  }
})

test('model question confidence is normalized conservatively and never promoted into highlights', async (t) => {
  const f = fixture(t, (input) => [event(input, { kind: 'question', confidence: 'question' })])
  f.group('one', [{ daysAgo: 0, text: 'Does 429 imply risk controls?' }])
  f.configure(['one'])
  f.service.start()
  await f.service.waitForIdle()
  assert.equal(f.service.feed().status.error, null)
  assert.equal(f.service.feed().items[0].confidence, 'rumor')
  assert.deepEqual(f.service.feed().highlights, [])
})

test('empty model merge targets mean a new topic; unknown IDs are never silently attached elsewhere', async (t) => {
  let mergeId: string | null = null
  const f = fixture(t, (input) => [event(input, { mergeId })])
  f.group('one', [{ daysAgo: 0, text: 'New topic' }])
  f.configure(['one'])
  f.service.start()
  await f.service.waitForIdle()
  assert.equal(f.service.feed().items.length, 1)
  mergeId = 'not-an-existing-topic'
  f.append('one', [{ daysAgo: 0, text: 'A new report' }])
  f.service.start()
  await f.service.waitForIdle()
  assert.equal(f.service.feed().status.backlog, 1)
  assert.match(f.service.feed().status.error!, /merge target/)
})

test('unexpected category labels preserve sourced topics under Other instead of blocking the feed', async (t) => {
  const f = fixture(t, (input) => [event(input, { category: 'discussion' })])
  f.group('one', [{ daysAgo: 0, text: 'A sourced discussion' }])
  f.configure(['one'])
  f.service.start()
  await f.service.waitForIdle()
  assert.equal(f.service.feed().status.error, null)
  assert.equal(f.service.feed().items[0].category, 'other')
  assert.equal(f.service.feed().status.backlog, 0)
})

// These cases prevent unbudgeted requests, misleading cached summaries, out-of-scope search and destructive note exports.
test('summaries use existing topics, cache across restarts, stay current after reading and invalidate after progress', async (t) => {
  let progress = false
  const f = fixture(t, (input) => [
    event(input, {
      advancement: progress,
      summary: progress ? 'Fixed in version 2' : 'Useful discussion',
      outcome: progress ? 'resolved' : 'open',
      conclusion: progress ? 'Version 2 fixes the reported issue' : '',
    }),
  ])
  f.group('one', [{ daysAgo: 0, text: 'Original discussion' }])
  f.configure(['one'])
  f.service.start()
  await f.service.waitForIdle()
  const feed = f.service.feed()
  assert.equal(feed.digest?.stale, false)
  assert.equal(feed.usage.calls, 4, 'analysis plus three period summaries')
  f.service.mark(feed.items[0].id, { read: true, saved: true })
  await f.service.summarize('day')
  assert.equal(f.service.feed().usage.calls, 4)
  const restarted = createHotspotService(f.deps)
  try {
    await restarted.summarize('day')
    assert.equal(restarted.feed().usage.calls, 4, 'cache survives restart')
  } finally {
    await restarted.close()
  }
  progress = true
  f.advance(0.1)
  f.append('one', [{ daysAgo: 0, text: 'Version 2 is confirmed fixed in this discussion' }])
  f.service.start()
  await f.service.waitForIdle()
  assert.equal(f.service.feed().items[0].outcome, 'resolved')
  assert.equal(f.service.feed().items[0].conclusion, 'Version 2 fixes the reported issue')
  assert.equal(f.service.feed().usage.calls, 8)
})

test('semantic search includes retained older topics, caches intent results, and respects selected source scope', async (t) => {
  const f = fixture(t)
  f.group('one', [{ daysAgo: 20, text: 'A dashboard to manage CPA' }])
  f.group('two', [{ daysAgo: 0, text: 'Private unrelated group' }])
  f.configure(['one', 'two'])
  f.service.start()
  await f.service.waitForIdle()
  f.configure(['one'])
  const result = await f.service.search('以前有人介绍的管理面板')
  assert.equal(result.scanned, 1)
  assert.equal(result.matches[0].item.title, 'A dashboard to manage CPA')
  const calls = f.service.feed().usage.calls
  f.service.mark(result.matches[0].item.id, { read: true })
  const again = await f.service.search('以前有人介绍的管理面板')
  assert.notEqual(again.matches[0].item.readAt, null)
  assert.equal(f.service.feed().usage.calls, calls)
  f.configure([])
  assert.deepEqual((await f.service.search('以前有人介绍的管理面板')).matches, [])
  await assert.rejects(() => f.service.search(''), /query/)
})

test('zero budget blocks requests, missing prices block budgeted calls, and usage survives failures and month rollover', async (t) => {
  const f = fixture(t)
  f.group('one', [{ daysAgo: 0, text: 'AI tool' }])
  f.configure(['one'])
  const budget = {
    monthlyLimit: 0,
    currency: 'CNY' as const,
    modelId: 'fixture',
    inputPerMillion: 1,
    outputPerMillion: 2,
  }
  f.service.configure({ ...f.service.feed().config, budget })
  assert.throws(() => f.service.start(), /budget paused/)
  assert.equal(f.service.feed().usage.calls, 0)
  f.service.configure({ ...f.service.feed().config, budget: { ...budget, monthlyLimit: 10, inputPerMillion: null } })
  assert.equal(f.service.feed().usage.reason, 'pricing')
  assert.throws(() => f.service.start(), /pricing/)
  f.service.configure({ ...f.service.feed().config, budget: { ...budget, monthlyLimit: 0.000001 } })
  f.service.start()
  await f.service.waitForIdle()
  assert.equal(f.service.feed().usage.calls, 0, 'reservation refuses a request before spending')
  assert.equal(f.calls, 0)
  f.service.configure({ ...f.service.feed().config, budget: { ...budget, monthlyLimit: 10 } })
  f.service.start()
  await f.service.waitForIdle()
  const usage = f.service.feed().usage
  assert.equal(usage.calls, 4)
  assert.ok(usage.estimatedCost > 0)
  assert.equal(usage.unpricedCalls, 0)
  assert.equal(usage.byGroup[0].calls, 1)
  const restarted = createHotspotService(f.deps)
  try {
    assert.deepEqual(restarted.feed().usage, usage)
  } finally {
    await restarted.close()
  }
  const actual = f.deps.getModelClient()
  f.deps.getModelClient = () => ({
    ...actual,
    complete: async () => {
      throw new Error('Network failed after sending')
    },
  })
  f.append('one', [{ daysAgo: 0, text: 'New tool' }])
  f.service.start()
  await f.service.waitForIdle()
  assert.equal(f.service.feed().usage.reason, 'uncertain')
  assert.equal(f.service.feed().usage.uncertainCalls, 1)
  assert.throws(() => f.service.start(), /uncertain/)
  f.service.reconcileUsage(0.01)
  assert.equal(f.service.feed().usage.paused, false)
  assert.ok(f.service.feed().usage.estimatedCost >= 0.01)
  f.advance(31)
  assert.equal(f.service.feed().usage.estimatedCost, 0)
  assert.equal(f.service.feed().usage.calls, 0)
  assert.equal(f.service.feed().usage.month, '2026-12')
})

test('invalid model output is charged and legacy unpriced receipts require explicit cost reconciliation', async (t) => {
  const f = fixture(t, () => [{ invalid: true }])
  f.group('one', [{ daysAgo: 0, text: 'AI tool' }])
  f.configure(['one'])
  f.service.start()
  await f.service.waitForIdle()
  assert.equal(f.service.feed().usage.calls, 1)
  assert.equal(f.service.feed().usage.unpricedCalls, 1)
  f.service.configure({
    ...f.service.feed().config,
    budget: { monthlyLimit: 1, currency: 'CNY', modelId: 'fixture', inputPerMillion: 1, outputPerMillion: 2 },
  })
  assert.throws(() => f.service.start(), /uncertain/)
  assert.throws(() => f.service.reconcileUsage(-1), /cost/)
  f.service.reconcileUsage(0.5)
  assert.equal(f.service.feed().usage.estimatedCost, 0.5)
  assert.equal(f.service.feed().usage.unpricedCalls, 0)
  f.service.start()
  await f.service.waitForIdle()
  assert.ok(f.service.feed().usage.estimatedCost > 0.5, 'invalid JSON or evidence still has real model usage')
})

test('knowledge export requires approval, preserves edited files, rejects symlinks and tracks substantive changes', async (t) => {
  const f = fixture(t, (input) => [
    event(input, {
      kind: 'tool',
      title: 'CPA tool',
      outcome: 'proposed',
      conclusion: 'Try this tool for a CPA dashboard',
    }),
  ])
  f.group('one', [{ daysAgo: 0, text: 'CPA dashboard https://example.com/tool' }])
  f.configure(['one'])
  f.service.start()
  await f.service.waitForIdle()
  const item = f.service.feed().items[0]
  const vault = path.join(f.deps.dataDir, 'vault')
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true })
  f.service.configure({ ...f.service.feed().config, obsidianVault: vault })
  const draft = f.service.knowledgeDraft(item.id)
  assert.ok(draft.content.includes('https://example.com/tool'))
  assert.ok(draft.content.includes('Try this tool'))
  assert.equal(fs.existsSync(path.join(vault, 'ChatLab')), false, 'preview never writes a note')
  const exported = f.service.exportKnowledge(item.id, draft.content)
  assert.equal(fs.readFileSync(exported.path, 'utf8'), draft.content)
  assert.equal(f.service.feed().knowledge[0].changed, false)
  f.service.mark(item.id, { read: true, saved: true })
  assert.equal(f.service.feed().knowledge[0].changed, false, 'reading state is not a knowledge revision')
  fs.writeFileSync(exported.path, 'User edited note')
  const revised = f.service.exportKnowledge(item.id, draft.content + '\nReviewed conditions')
  assert.notEqual(revised.path, exported.path)
  assert.equal(fs.readFileSync(exported.path, 'utf8'), 'User edited note')
  assert.equal(f.service.exportKnowledge(item.id, draft.content + '\nReviewed conditions').path, revised.path)
  assert.throws(() => f.service.exportKnowledge('missing', draft.content), /candidate/)
  const otherVault = path.join(f.deps.dataDir, 'other-vault')
  fs.mkdirSync(path.join(otherVault, '.obsidian'), { recursive: true })
  fs.symlinkSync(vault, path.join(otherVault, 'ChatLab'))
  f.service.configure({ ...f.service.feed().config, obsidianVault: otherVault })
  assert.throws(() => f.service.exportKnowledge(item.id, draft.content), /symbolic link/)
})

test('group recommendations use analyzed useful content within the allowed scope and disclose insufficient samples', async (t) => {
  const f = fixture(t, (input) => (input.newMessages[0].content === 'Tool' ? [event(input, { kind: 'tool' })] : []))
  f.group(
    'useful',
    Array.from({ length: 25 }, () => ({ daysAgo: 0, text: 'Tool' }))
  )
  f.group(
    'chatty',
    Array.from({ length: 100 }, () => ({ daysAgo: 0, text: 'Chat' }))
  )
  f.group('small', [{ daysAgo: 0, text: 'Tool' }])
  f.configure(['useful', 'chatty', 'small'])
  f.service.start()
  await f.service.waitForIdle()
  const recommendations = f.service.recommendations()
  assert.equal(recommendations[0].sessionId, 'useful')
  assert.equal(recommendations[0].recommendation, 'focus')
  assert.equal(recommendations.find((row) => row.sessionId === 'chatty')?.recommendation, 'less')
  assert.equal(recommendations.find((row) => row.sessionId === 'small')?.recommendation, 'insufficient')
  f.configure(['useful'])
  assert.equal(f.service.recommendations().length, 1)
})

test('invalid digest references and fabricated search results are rejected while their usage remains recorded', async (t) => {
  const f = fixture(t)
  f.group('one', [{ daysAgo: 0, text: 'A real topic' }])
  f.configure(['one'])
  f.service.start()
  await f.service.waitForIdle()
  const model = f.deps.getModelClient()
  f.deps.getModelClient = () => ({
    ...model,
    complete: async (prompts) => ({
      text: JSON.stringify(
        JSON.parse(prompts.userPrompt).query
          ? { matches: [{ ref: 'topic-999', reason: 'Fabricated' }] }
          : {
              overview: 'Fabricated summary',
              sections: [{ title: 'Unrelated', text: 'Not in the source', refs: ['topic-999'] }],
            }
      ),
      inputTokens: 10,
      outputTokens: 10,
    }),
  })
  // Change the locale so an old summary cannot satisfy this request from cache.
  f.service.configure({ ...f.service.feed().config, locale: 'en-US' })
  const before = f.service.feed().usage.calls
  await assert.rejects(() => f.service.summarize('day'), /digest evidence/)
  assert.equal(f.service.feed().digest?.stale, true, 'failed refresh keeps the previous summary labeled stale')
  await assert.rejects(() => f.service.search('Find a nonexistent tool'), /search evidence/)
  assert.equal(f.service.feed().usage.calls, before + 2)
})

test('abandoned reservations survive restart and cache tokens contribute to estimated input cost', async (t) => {
  const f = fixture(t)
  f.group('one', [{ daysAgo: 0, text: 'A useful tool' }])
  f.configure(['one'])
  const model = f.deps.getModelClient()
  f.deps.getModelClient = () => ({
    ...model,
    complete: async (prompts, options) => ({
      ...(await model.complete(prompts, options)),
      cacheReadTokens: 60,
      cacheWriteTokens: 40,
    }),
  })
  f.service.configure({
    ...f.service.feed().config,
    budget: { monthlyLimit: 10, currency: 'CNY', modelId: 'fixture', inputPerMillion: 1, outputPerMillion: 2 },
  })
  f.service.start()
  await f.service.waitForIdle()
  assert.equal(f.service.feed().usage.inputTokens, 650, '250 uncached + 400 cached tokens across four calls')
  const db = openBetterSqliteDatabase(path.join(f.deps.dataDir, 'insight', 'hotspots.db'), { nativeBinding })
  db.prepare(
    `INSERT INTO hotspot_usage (id,timestamp,month,model_id,purpose,reserved,currency,status) VALUES ('abandoned',0,'2026-11','fixture','search',0.2,'CNY','reserved')`
  ).run()
  db.close()
  const restarted = createHotspotService(f.deps)
  try {
    const usage = restarted.feed().usage
    assert.equal(usage.uncertainCalls, 1)
    assert.equal(usage.reason, 'uncertain')
    assert.ok(usage.estimatedCost >= 0.2)
    assert.throws(() => restarted.start(), /uncertain/)
  } finally {
    await restarted.close()
  }
})

test('period summary caches never expose a previous group scope after the selected groups change', async (t) => {
  const f = fixture(t)
  f.group('one', [{ daysAgo: 0, text: 'First scope topic' }])
  f.group('two', [{ daysAgo: 0, text: 'Second scope topic' }])
  f.configure(['one'])
  f.service.start()
  await f.service.waitForIdle()
  assert.ok(f.service.feed().digest)
  f.configure(['two'])
  assert.equal(f.service.feed().digest, null)
  f.service.start()
  await f.service.waitForIdle()
  const second = f.service.feed()
  assert.equal(second.digest?.stale, false)
  assert.deepEqual(second.digest?.sections[0].hotspotIds, [second.items[0].id])
})

test('disputed outcomes cannot become resolved and a resolution without an answer retains its checkpoint', async (t) => {
  let valid = false
  const f = fixture(t, (input) => [
    event(input, {
      outcome: 'resolved',
      conclusion: valid ? 'Two conflicting reports' : '',
      confidence: valid ? 'disputed' : 'discussion',
    }),
  ])
  f.group('one', [{ daysAgo: 0, text: 'A problem without a clear answer' }])
  f.configure(['one'])
  f.service.start()
  await f.service.waitForIdle()
  assert.equal(f.service.feed().status.backlog, 1)
  valid = true
  f.service.start()
  await f.service.waitForIdle()
  assert.equal(f.service.feed().items[0].outcome, 'disputed')
})

test('background synchronization can replace a source connection while a model request is running', async (t) => {
  const f = fixture(t, (input) => [event(input, { title: 'Useful tools', kind: 'tool' })])
  f.group('one', [
    { daysAgo: 0, text: 'A'.repeat(5000) },
    { daysAgo: 0, text: 'B'.repeat(5000) },
  ])
  f.configure(['one'])
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const model = f.deps.getModelClient()
  let first = true
  f.deps.getModelClient = () => ({
    ...model,
    complete: async (prompts, options) => {
      if (first) {
        first = false
        entered()
        await gate
      }
      return model.complete(prompts, options)
    },
  })
  f.service.start()
  await started
  f.reopen('one')
  release()
  await f.service.waitForIdle()
  assert.equal(f.service.feed().status.error, null)
  assert.equal(f.service.feed().status.backlog, 0)
  assert.equal(f.calls, 2, 'both batches finish after the sync adapter replaces its cached connection')
})
