#!/usr/bin/env -S node --import tsx
/** Register or verify the installed local source. Stop Desktop before running sync. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DataSourceManager, PullEngine, deriveLocalSessionId } from '../../packages/sync/src/index'
import { DirectImporter, NodeFetcher, NoopNotifier } from '../../apps/cli/src/sync/adapters'
import { initRuntime } from '../../apps/cli/src/runtime'

const root = process.env.CHATLAB_WECOM_HOME ?? path.join(os.homedir(), '.local/share/chatlab-wecom')
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'))
const baseUrl = `http://127.0.0.1:${config.port}/api/v1`
const manager = new DataSourceManager(path.join(os.homedir(), '.chatlab/settings'))
let source = manager.loadAll().find((s) => s.baseUrl === baseUrl)
if (!source) {
  source = manager.add({
    name: '企业微信（本机全部会话）',
    baseUrl,
    token: config.token,
    intervalMinutes: 1,
    pullLimit: 1000,
    autoDiscoverSessions: true,
  })
} else if (!source.autoDiscoverSessions) {
  source = manager.update(source.id, { autoDiscoverSessions: true })!
}

if (process.argv[2] === 'register') {
  console.log(JSON.stringify({ configured: true, sourceId: source.id, intervalMinutes: source.intervalMinutes }))
} else if (process.argv[2] === 'sync' || process.argv[2] === 'verify') {
  const { dbManager } = initRuntime()
  try {
    if (process.argv[2] === 'sync') {
      for (const session of manager.get(source.id)!.sessions) {
        if (!session.targetSessionId && session.lastStatus === 'error') {
          manager.updateSession(source.id, session.id, { lastPullAt: 0 })
        }
      }
      const engine = new PullEngine({
        dsManager: manager,
        fetcher: new NodeFetcher(),
        importer: new DirectImporter(dbManager),
        notifier: new NoopNotifier(),
      })
      const result = await engine.triggerPull(source.id)
      if (!result.success) throw new Error('WeCom import failed; inspect per-session source status')
    }
    const response = await fetch(`${baseUrl}/sessions`, { headers: { Authorization: `Bearer ${config.token}` } })
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`)
    const { sessions } = (await response.json()) as { sessions: Array<{ id: string; messageCount: number }> }
    let actualMessages = 0
    let expectedMessages = 0
    let mismatchedConversations = 0
    for (const session of sessions) {
      const id = deriveLocalSessionId(baseUrl, session.id)
      if (!fs.existsSync(dbManager.getDbPath(id))) {
        mismatchedConversations++
        expectedMessages += session.messageCount
        continue
      }
      const db = dbManager.openRawSessionDatabase(id, { readonly: true })
      const count = db.prepare('SELECT COUNT(*) AS count FROM message').get() as { count: number }
      db.close()
      actualMessages += count.count
      expectedMessages += session.messageCount
      if (count.count !== session.messageCount) mismatchedConversations++
    }
    const result = { conversations: sessions.length, expectedMessages, actualMessages, mismatchedConversations }
    console.log(JSON.stringify(result))
    fs.writeFileSync(path.join(root, 'verification.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
    if (mismatchedConversations) process.exitCode = 1
  } finally {
    dbManager.closeAll()
  }
} else {
  throw new Error('Usage: connect.mts register|sync|verify')
}
