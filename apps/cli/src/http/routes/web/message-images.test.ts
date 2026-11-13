import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import Fastify from 'fastify'
import type { PathProvider } from '@openchatlab/core'
import { DatabaseManager } from '@openchatlab/node-runtime'
import { DataSourceManager } from '@openchatlab/sync'
import { initSync, cleanupSync } from '../../../sync'
import { registerWebRoutes } from './index'

test('CLI Web image routes use the subscriptions initialized by sync', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'chatlab-cli-images-'))
  await mkdir(path.join(root, 'nlp'))
  await writeFile(path.join(root, 'nlp/zh-CN.dict'), '')
  const pathProvider: PathProvider = {
    getSystemDir: () => root,
    getUserDataDir: () => path.join(root, 'data'),
    getDatabaseDir: () => path.join(root, 'data/databases'),
    getVectorDir: () => path.join(root, 'data/vector'),
    getAiDataDir: () => path.join(root, 'ai'),
    getSettingsDir: () => path.join(root, 'settings'),
    getCacheDir: () => path.join(root, 'cache'),
    getTempDir: () => path.join(root, 'temp'),
    getLogsDir: () => path.join(root, 'logs'),
    getDownloadsDir: () => root,
  }
  const nativeBinding = path.resolve('apps/cli/native/better_sqlite3.node')
  const manager = new DatabaseManager(pathProvider, { nativeBinding, allowMissingRuntimeForTests: true })
  const db = manager.openRawSessionDatabase('local', { create: true, initializeChatTables: true })
  db.exec("INSERT INTO meta(name,platform,type,imported_at) VALUES('Test','telegram','group',100)")
  db.exec("INSERT INTO member(id,platform_id,account_name) VALUES(1,'1','Test')")
  db.exec("INSERT INTO message(id,sender_id,ts,type,content,platform_message_id) VALUES(7,1,100,1,'[photo]','42')")
  db.close()
  const remote = Fastify()
  remote.get('/api/v1/sessions/:sid/messages/:mid/images', (request) => {
    assert.equal(request.headers.authorization, 'Bearer synthetic-secret')
    assert.deepEqual({ ...(request.params as object) }, { sid: 'telegram:1:-2', mid: '42' })
    return { images: [{ index: 0 }], caption: 'caption' }
  })
  const address = await remote.listen({ host: '127.0.0.1', port: 0 })
  const ds = new DataSourceManager(pathProvider.getSettingsDir())
  const source = ds.add({ baseUrl: `${address}/api/v1`, token: 'synthetic-secret', intervalMinutes: 60 })
  ds.update(source.id, { enabled: false })
  const [subscription] = ds.addSessions(source.id, [{ name: 'Test', remoteSessionId: 'telegram:1:-2' }])
  ds.updateSession(source.id, subscription.id, { targetSessionId: 'local' })
  const app = Fastify()
  t.after(async () => {
    cleanupSync()
    await app.close()
    await remote.close()
    manager.closeAll()
    await rm(root, { recursive: true, force: true })
  })
  const automation = initSync(app, manager, pathProvider, { port: 0, host: '127.0.0.1', token: 'test' })
  registerWebRoutes(app, manager, { pathProvider, nativeBinding, automation })
  const response = await app.inject('/_web/sessions/local/messages/7/images')
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json(), { images: [{ index: 0 }], caption: 'caption' })
})
