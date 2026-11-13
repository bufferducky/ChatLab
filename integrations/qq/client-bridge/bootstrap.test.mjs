import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('a client launched without shell variables uses its configured data source and exits on SIGTERM', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bootstrap-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.copyFileSync(new URL('./bootstrap.cjs', import.meta.url), path.join(root, 'bootstrap.cjs'))
  const home = path.join(root, 'collector')
  const dataRoot = path.join(root, 'qq-data')
  const resultPath = path.join(root, 'result.json')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '7.0.1-52892' }))
  fs.writeFileSync(
    path.join(root, 'chatlab-image-bridge.json'),
    JSON.stringify({ main: 'launcher.cjs', home, dataRoot })
  )
  fs.writeFileSync(path.join(root, 'wrapper.node'), '')
  fs.writeFileSync(
    path.join(root, 'image-bridge.cjs'),
    `exports.createBridge = (options) => {
      require('node:fs').writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
        home: options.home, dataRoot: options.qqRoot, version: options.qqVersion,
        sessionCaptured: typeof options.session.getMsgService === 'function'
      }))
      return { start: async () => {}, shutdownSync() {} }
    }`
  )
  fs.writeFileSync(
    path.join(root, 'launcher.cjs'),
    `require.extensions['.node'] = (module) => {
      module.exports = { NodeIQQNTWrapperSession: {
        getNTWrapperSession() { return { getMsgService() {} } }
      } }
    }
    require('./wrapper.node').NodeIQQNTWrapperSession.getNTWrapperSession()
    setInterval(() => {}, 1000)
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 30)`
  )
  const env = { ...process.env }
  for (const key of ['CHATLAB_QQ_HOME', 'CHATLAB_QQ_DATA_ROOT', 'CHATLAB_QQ_LAUNCHER', 'CHATLAB_QQ_BRIDGE']) {
    delete env[key]
  }
  const child = spawnSync(process.execPath, [path.join(root, 'bootstrap.cjs')], { env, timeout: 2000 })
  assert.equal(child.error, undefined)
  assert.equal(child.signal, 'SIGTERM')
  assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, 'utf8')), {
    home,
    dataRoot,
    version: '7.0.1-52892',
    sessionCaptured: true,
  })
})
