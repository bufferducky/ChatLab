import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { DataSourceManager } from './data-source-manager'
import { PullEngine } from './pull-engine'

test('opted-in sources discover paginated groups and private chats, including on later pulls', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlab-discovery-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let fail = false
  let includeNewChat = false
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-token')
    res.setHeader('Content-Type', 'application/json')
    if (fail) {
      res.writeHead(503).end('{}')
    } else if (req.url?.includes('cursor=next')) {
      res.end(JSON.stringify({ sessions: [{ id: 'private', name: 'Private', type: 'private' }] }))
    } else {
      res.end(
        JSON.stringify({
          sessions: [
            { id: 'group', name: 'Group', type: 'group' },
            ...(includeNewChat ? [{ id: 'new', name: 'New', type: 'group' }] : []),
          ],
          page: { hasMore: true, nextCursor: 'next' },
        })
      )
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const manager = new DataSourceManager(root)
  const source = manager.add({
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`,
    token: 'test-token',
    intervalMinutes: 1,
    autoDiscoverSessions: true,
  })
  const imported: string[] = []
  const engine = new PullEngine({
    dsManager: manager,
    fetcher: {
      async fetchToTempFile(_base, id) {
        imported.push(id)
        const file = path.join(root, `${id}.json`)
        fs.writeFileSync(file, JSON.stringify({ messages: [{ timestamp: 100 }], sync: { hasMore: false } }))
        return file
      },
    },
    importer: {
      sessionExists: () => true,
      async importFile(_file, _target, id) {
        return { success: true, newMessageCount: 1, sessionId: id }
      },
    },
    notifier: { onSessionListChanged: () => undefined, onPullResult: () => undefined },
  })
  await engine.pullAllSessions(source)
  assert.deepEqual(
    manager
      .get(source.id)
      ?.sessions.map((s) => s.remoteSessionId)
      .sort(),
    ['group', 'private']
  )
  includeNewChat = true
  await engine.triggerPull(source.id)
  assert.equal(manager.get(source.id)?.sessions.length, 3)
  assert.ok(imported.includes('new'))
  const before = manager.get(source.id)
  fail = true
  await assert.rejects(engine.pullAllSessions(before!), /503/)
  assert.deepEqual(manager.get(source.id), before)
})
