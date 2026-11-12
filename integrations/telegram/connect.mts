#!/usr/bin/env -S node --import tsx
/** Register, import, and verify the selected local Telegram source. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { DataSourceManager, PullEngine, deriveLocalSessionId } from '../../packages/sync/src/index'
import { DirectImporter, NodeFetcher } from '../../apps/cli/src/sync/adapters'
import { initRuntime } from '../../apps/cli/src/runtime'

const command = process.argv[2]
if (!['register', 'sync', 'verify'].includes(command)) throw new Error('Usage: connect.mts register|sync|verify')
if (command !== 'verify') {
  let running = false
  try {
    execFileSync('pgrep', ['-x', 'ChatLab'], { stdio: 'ignore' })
    running = true
  } catch {
    // pgrep exits with status 1 when Desktop is stopped. Collector apps may remain active.
  }
  if (running) throw new Error('Quit ChatLab Desktop before registering or importing this source')
}

const root = process.env.CHATLAB_TELEGRAM_HOME ?? path.join(os.homedir(), '.local/share/chatlab-telegram')
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'))
const baseUrl = `http://127.0.0.1:${config.port}/api/v1`
const manager = new DataSourceManager(path.join(os.homedir(), '.chatlab/settings'))
let source = manager.loadAll().find((s) => s.baseUrl === baseUrl)
if (!source && command === 'verify') throw new Error('Telegram source is not registered')
if (!source) {
  source = manager.add({
    name: config.allDialogs ? 'Telegram（本机全部会话）' : 'Telegram（本机已选会话）',
    baseUrl,
    token: config.token,
    intervalMinutes: 180,
    pullLimit: 1000,
    autoDiscoverSessions: true,
  })
}
if (config.allDialogs && source.name !== 'Telegram（本机全部会话）') {
  source = manager.update(source.id, { name: 'Telegram（本机全部会话）' })!
}
if (command === 'register') {
  console.log(JSON.stringify({ configured: true, sourceId: source.id, intervalMinutes: source.intervalMinutes }))
} else {
  const { dbManager } = initRuntime()
  try {
    if (command === 'sync') {
      let completedSessions = 0
      const engine = new PullEngine({
        dsManager: manager,
        fetcher: new NodeFetcher(),
        importer: new DirectImporter(dbManager),
        notifier: {
          onSessionListChanged() {
            // Desktop reloads the session list after this offline import.
          },
          onPullResult(_sourceId, _sessionId, status) {
            console.log(JSON.stringify({ completedSessions: ++completedSessions, status }))
          },
        },
      })
      const result = await engine.triggerPull(source.id)
      if (!result.success) throw new Error('Telegram import failed; inspect source status')
    }
    const response = await fetch(`${baseUrl}/sessions`, { headers: { Authorization: `Bearer ${config.token}` } })
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`)
    const { sessions } = (await response.json()) as { sessions: Array<{ id: string; messageCount: number }> }
    let actualMessages = 0
    let expectedMessages = 0
    let mismatchedConversations = 0
    for (const session of sessions) {
      expectedMessages += session.messageCount
      const id = deriveLocalSessionId(baseUrl, session.id)
      if (!fs.existsSync(dbManager.getDbPath(id))) {
        mismatchedConversations++
        continue
      }
      const db = dbManager.openRawSessionDatabase(id, { readonly: true })
      try {
        const count = db.prepare('SELECT COUNT(*) AS count FROM message').get() as { count: number }
        actualMessages += count.count
        if (count.count !== session.messageCount) mismatchedConversations++
      } finally {
        db.close()
      }
    }
    const result = { conversations: sessions.length, expectedMessages, actualMessages, mismatchedConversations }
    console.log(JSON.stringify(result))
    fs.writeFileSync(path.join(root, 'verification.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
    if (mismatchedConversations) process.exitCode = 1
  } finally {
    dbManager.closeAll()
  }
}
