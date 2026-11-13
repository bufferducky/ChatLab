/** Exercise Python Pull paging against the real importer using synthetic data only. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import test from 'node:test'
import { DatabaseManager } from '../../packages/node-runtime/src/database-manager'
import { DataSourceManager, PullEngine } from '../../packages/sync/src/index'
import { DirectImporter, NodeFetcher } from '../../apps/cli/src/sync/adapters'

test('Telegram source imports every page, deduplicates replays, and imports late history', async (t) => {
  const python = process.env.CHATLAB_TELEGRAM_PYTHON ?? 'python3'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlab-telegram-smoke-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const integration = path.resolve('integrations/telegram')
  const sourceRoot = path.join(root, 'source')
  const sourceProgram = `
import sys,json
sys.path.insert(0,sys.argv[1])
from bridge import Cache,make_server,private_json
c=Cache(sys.argv[2]); c.bind_account(1)
sid=c.session(1,-2,'Synthetic Telegram group','group')
def payload(mid,stamp=100):
 return {'platformMessageId':str(mid),'sender':'42','accountName':'Alice','timestamp':stamp,'type':0,'content':'same text'}
c.ingest(sid,[payload(1),payload(2),{**payload(3),'replyToMessageId':'1'}]); c.finish()
server=make_server(c,{'token':'synthetic-token','port':0})
private_json(c.root/'config.json',{'port':server.server_port})
print(server.server_port,flush=True)
server.serve_forever()
`
  const server = spawn(python, ['-u', '-c', sourceProgram, integration, sourceRoot], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, 'exit')
      server.kill()
      await exited
    }
  })
  const lines = readline.createInterface({ input: server.stdout })
  const line = once(lines, 'line')
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Python source did not start')), 10_000)
    timer.unref()
    void line.finally(() => clearTimeout(timer))
  })
  const [port] = await Promise.race([line, timeout])
  lines.close()
  const runtimeRoot = path.join(root, 'runtime')
  const manager = new DatabaseManager(
    {
      getSystemDir: () => runtimeRoot,
      getUserDataDir: () => runtimeRoot,
      getDatabaseDir: () => path.join(runtimeRoot, 'databases'),
      getVectorDir: () => path.join(runtimeRoot, 'vector'),
      getAiDataDir: () => path.join(runtimeRoot, 'ai'),
      getSettingsDir: () => path.join(runtimeRoot, 'settings'),
      getCacheDir: () => path.join(runtimeRoot, 'cache'),
      getTempDir: () => path.join(runtimeRoot, 'temp'),
      getLogsDir: () => path.join(runtimeRoot, 'logs'),
      getDownloadsDir: () => runtimeRoot,
    },
    { nativeBinding: path.resolve('apps/cli/native/better_sqlite3.node'), allowMissingRuntimeForTests: true }
  )
  t.after(() => manager.closeAll())
  const sources = new DataSourceManager(path.join(runtimeRoot, 'settings'))
  const source = sources.add({
    name: 'Synthetic Telegram',
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    token: 'synthetic-token',
    intervalMinutes: 180,
    pullLimit: 1,
    autoDiscoverSessions: true,
  })
  const engine = new PullEngine({
    dsManager: sources,
    fetcher: new NodeFetcher(),
    importer: new DirectImporter(manager),
    notifier: {
      onSessionListChanged() {
        // Synthetic tests do not update a desktop UI.
      },
      onPullResult() {
        // Assertions below verify persisted results directly.
      },
    },
  })
  assert.equal((await engine.triggerPull(source.id)).success, true)
  const session = sources.get(source.id)!.sessions[0]
  const database = manager.openRawSessionDatabase(session.targetSessionId, { readonly: true })
  try {
    const count = () => (database.prepare('SELECT COUNT(*) AS n FROM message').get() as { n: number }).n
    assert.equal(count(), 3)
    assert.equal((await engine.triggerPull(source.id)).success, true)
    assert.equal(count(), 3)
    const added = spawnSync(
      python,
      [
        '-c',
        `
import sys
sys.path.insert(0,sys.argv[1])
from bridge import Cache
c=Cache(sys.argv[2]);c.ingest('telegram:1:-2',[{'platformMessageId':'4','sender':'42','accountName':'Alice','timestamp':1,'type':0,'content':'late history'}]);c.finish()
`,
        integration,
        sourceRoot,
      ],
      { encoding: 'utf8' }
    )
    assert.equal(added.status, 0, added.stderr)
    assert.equal((await engine.triggerPull(source.id)).success, true)
    assert.equal(count(), 4)
  } finally {
    database.close()
  }
  const audit = spawnSync(
    python,
    [path.join(integration, 'audit.py'), '--home', sourceRoot, '--database-dir', path.join(runtimeRoot, 'databases')],
    { encoding: 'utf8' }
  )
  assert.equal(audit.status, 0, audit.stderr || audit.stdout)
  assert.equal(JSON.parse(audit.stdout).mismatchedMessages, 0)
  const modified = manager.openRawSessionDatabase(session.targetSessionId)
  try {
    modified.prepare("UPDATE message SET reply_to_message_id='missing' WHERE platform_message_id='3'").run()
  } finally {
    modified.close()
  }
  const corrupted = spawnSync(
    python,
    [path.join(integration, 'audit.py'), '--home', sourceRoot, '--database-dir', path.join(runtimeRoot, 'databases')],
    { encoding: 'utf8' }
  )
  assert.equal(corrupted.status, 1)
  assert.equal(JSON.parse(corrupted.stdout).mismatchedMessages, 1)
})
