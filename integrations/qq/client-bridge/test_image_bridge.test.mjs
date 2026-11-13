import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { createBridge, validateFetchRequest, pictureMd5s, normalizeUin } = require('./image-bridge.cjs')

const UID = 'u_synthetic'
const UIN = '100000000'
const IMAGE = Buffer.from('\x89PNG\r\n\x1a\nsynthetic-image-bytes')

function md5(value) {
  return crypto.createHash('md5').update(value).digest('hex')
}

function accountFolder(root, uid) {
  const inner = md5(uid)
  return path.join(root, 'nt_qq_' + md5(inner + 'nt_kernel'))
}

function makeQqRoot(root, { uid = UID, version = '7.0.1-52892' } = {}) {
  const folder = accountFolder(root, uid)
  fs.mkdirSync(path.join(folder, 'nt_db'), { recursive: true })
  fs.writeFileSync(path.join(folder, 'nt_db', 'nt_msg.db'), 'synthetic')
  fs.mkdirSync(path.join(root, 'versions'), { recursive: true })
  fs.writeFileSync(path.join(root, 'versions', 'config.json'), JSON.stringify({ curVersion: version }))
  return folder
}

function fakeQq({ image = IMAGE, pictureMd5 = md5(IMAGE), uid = UID, uin = UIN } = {}) {
  const listeners = []
  const loginListeners = []
  const downloads = []
  const options = { delay: 0, neverComplete: false, writeBytes: null }
  const service = {
    addKernelMsgListener(listener) {
      listeners.push(listener)
    },
    removeKernelMsgListener() {
      // The fake QQ client never receives a removal in these tests.
    },
    async getMsgsByMsgId(_peer, ids) {
      return {
        result: 0,
        msgList: [
          {
            msgId: ids[0],
            elements: [
              {
                elementType: 2,
                elementId: 'element-1',
                picElement: pictureMd5
                  ? { md5HexStr: pictureMd5.toUpperCase(), fileName: `${pictureMd5}.png` }
                  : { fileName: 'image.bin' },
              },
              { elementType: 1, elementId: 'element-0', textElement: { content: 'caption' } },
            ],
          },
        ],
      }
    },
    async downloadRichMedia(args) {
      downloads.push(args)
      if (options.neverComplete) return {}
      const complete = () => {
        fs.writeFileSync(args.filePath, options.writeBytes || image)
        const data = { msgId: args.msgId, msgElementId: args.elementId, filePath: args.filePath, fileErrCode: 0 }
        for (const listener of listeners) {
          try {
            listener.onRichMediaDownloadComplete(data)
          } catch {
            // The bridge must tolerate listener shape differences.
          }
        }
      }
      if (options.delay) setTimeout(complete, options.delay)
      else queueMicrotask(complete)
      return {}
    },
  }
  const login = {
    addKernelLoginListener(listener) {
      loginListeners.push(listener)
    },
    getLoginList() {
      return { LocalLoginInfoList: [{ uin, uid, nickName: 'Synthetic' }] }
    },
  }
  return {
    options,
    downloads,
    service,
    session: { getMsgService: () => service },
    wrapper: { NodeIKernelLoginService: { get: () => login } },
    login(listener) {
      assert.equal(loginListeners.length, 1)
      loginListeners[0].onUserLoggedIn({ uin, uid, nickName: 'Synthetic' })
    },
    logout() {
      loginListeners[0].onLogoutSucceed()
    },
    completePending() {
      assert.equal(downloads.length, 1)
      const args = downloads[0]
      fs.writeFileSync(args.filePath, image)
      const data = { msgId: args.msgId, msgElementId: args.elementId, filePath: args.filePath, fileErrCode: 0 }
      for (const listener of listeners) listener.onRichMediaDownloadComplete(data)
    },
  }
}

async function startBridge(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlab-qq-bridge-'))
  const qqRoot = path.join(home, 'qq')
  fs.mkdirSync(qqRoot, { recursive: true })
  makeQqRoot(qqRoot)
  const qq = options.qq || fakeQq(options.qqOptions)
  const bridge = createBridge({
    home,
    qqRoot,
    electronVersion: '40.0.0',
    session: qq.session,
    wrapper: qq.wrapper,
    ...options.bridge,
  })
  const baseUrl = await bridge.start()
  t.after(async () => {
    await bridge.stop()
    fs.rmSync(home, { recursive: true, force: true })
  })
  const discovery = JSON.parse(fs.readFileSync(bridge.discoveryPath, 'utf8'))
  return { home, qqRoot, qq, bridge, baseUrl, discovery }
}

function call(baseUrl, token, method, route, body, extraHeaders = {}) {
  return fetch(baseUrl + route, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...extraHeaders,
    },
    body:
      body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  })
}

const validRequest = () => ({
  chatType: 2,
  peerUid: '28070330',
  msgId: '9007199254740993',
  imageIndex: 0,
  expectedMd5: md5(IMAGE),
})

test('validateFetchRequest accepts exactly the documented shape and rejects everything else', () => {
  assert.deepEqual(validateFetchRequest(validRequest()), validRequest())
  assert.equal(
    validateFetchRequest({ ...validRequest(), expectedMd5: md5(IMAGE).toUpperCase() }).expectedMd5,
    md5(IMAGE)
  )
  for (const invalid of [
    null,
    [],
    'text',
    { ...validRequest(), extra: true },
    { ...validRequest(), chatType: 3 },
    { ...validRequest(), chatType: '2' },
    { ...validRequest(), msgId: Number.MAX_SAFE_INTEGER + 2 },
    { ...validRequest(), msgId: '0' },
    { ...validRequest(), peerUid: '../escape' },
    { ...validRequest(), imageIndex: -1 },
    { ...validRequest(), imageIndex: 1.5 },
    { ...validRequest(), expectedMd5: 'zz' },
  ]) {
    assert.throws(
      () => validateFetchRequest(invalid),
      (error) => error.code === 'INVALID_IMAGE_REQUEST'
    )
  }
})

test('picture hashes and uin normalization are bounded to safe values', () => {
  assert.equal(normalizeUin('100000000'), '100000000')
  assert.equal(normalizeUin(100000000), '100000000')
  assert.equal(normalizeUin('abc'), null)
  assert.equal(normalizeUin(Number.MAX_SAFE_INTEGER + 2), null)
  assert.deepEqual([...pictureMd5s({ picElement: { md5HexStr: md5(IMAGE).toUpperCase() } })], [md5(IMAGE)])
  assert.deepEqual([...pictureMd5s({ picElement: {} })], [])
})

test('discovery, health and login state use only verified facts', async (t) => {
  const { home, qqRoot, qq, bridge, baseUrl, discovery } = await startBridge(t)
  assert.equal(discovery.protocolVersion, '1')
  assert.equal(discovery.baseUrl, baseUrl)
  assert.ok(discovery.token.length >= 43)
  assert.equal(fs.statSync(path.join(home, 'runtime')).mode & 0o777, 0o700)
  assert.equal(fs.statSync(bridge.discoveryPath).mode & 0o777, 0o600)

  const before = await call(baseUrl, bridge.token, 'GET', '/v1/health')
  assert.equal(before.status, 200)
  const offline = await before.json()
  assert.equal(offline.loggedIn, false)
  assert.equal(offline.ready, false)
  assert.equal(offline.accountUin, null)
  assert.equal(offline.sessionCaptured, true)
  assert.equal(offline.qqVersion, '7.0.1-52892')
  assert.equal(offline.electronVersion, '40.0.0')
  assert.deepEqual(offline.capabilities, ['fetch-image-original'])

  qq.login()
  const online = await (await call(baseUrl, bridge.token, 'GET', '/v1/health')).json()
  assert.equal(online.loggedIn, true)
  assert.equal(online.ready, true)
  assert.equal(online.accountUin, UIN)
  assert.equal(online.accountDataDir, fs.realpathSync(accountFolder(qqRoot, UID)))
  assert.equal(online.instanceId, bridge.instanceId)
})

test('fetch returns verified original bytes and cleans its temporary file', async (t) => {
  const { qq, bridge, baseUrl } = await startBridge(t)
  qq.login()
  const response = await call(baseUrl, bridge.token, 'POST', '/v1/images/fetch', validRequest())
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/octet-stream')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  const body = Buffer.from(await response.arrayBuffer())
  assert.deepEqual(body, IMAGE)
  assert.equal(qq.downloads[0].msgId, '9007199254740993')
  assert.equal(qq.downloads[0].chatType, 2)
  assert.equal(qq.downloads[0].downloadType, 1)
  assert.equal(fs.readdirSync(path.join(bridge.runtimeDir, 'image-downloads')).length, 0)
})

test('authentication, unsupported routes and oversized bodies are rejected', async (t) => {
  const { bridge, baseUrl } = await startBridge(t)
  assert.equal((await call(baseUrl, 'wrong', 'GET', '/v1/health')).status, 401)
  assert.equal((await call(baseUrl, bridge.token, 'GET', '/v1/unknown')).status, 404)
  const oversized = await call(baseUrl, bridge.token, 'POST', '/v1/images/fetch', 'x'.repeat(17 * 1024))
  assert.equal(oversized.status, 413)
  const malformed = await call(baseUrl, bridge.token, 'POST', '/v1/images/fetch', '{')
  assert.equal(malformed.status, 400)
  const extra = await call(baseUrl, bridge.token, 'POST', '/v1/images/fetch', { ...validRequest(), filePath: '/tmp/x' })
  assert.equal(extra.status, 400)
  assert.deepEqual(await extra.json(), {
    error: 'Invalid image request',
    code: 'INVALID_IMAGE_REQUEST',
    retryable: false,
  })
})

test('offline and incompatible clients never start a download', async (t) => {
  const { qq, bridge, baseUrl } = await startBridge(t)
  const offline = await call(baseUrl, bridge.token, 'POST', '/v1/images/fetch', validRequest())
  assert.equal(offline.status, 503)
  assert.equal((await offline.json()).code, 'QQ_OFFLINE')
  assert.equal(qq.downloads.length, 0)

  qq.login()
  bridge.session = { getMsgService: () => ({}) }
  const incompatible = await call(baseUrl, bridge.token, 'POST', '/v1/images/fetch', validRequest())
  assert.equal(incompatible.status, 503)
  assert.equal((await incompatible.json()).code, 'QQ_BRIDGE_INCOMPATIBLE')
  assert.equal(qq.downloads.length, 0)
})

test('index, reference and integrity failures never return image bytes', async (t) => {
  const { qq, bridge, baseUrl } = await startBridge(t)
  qq.login()
  const outOfRange = await call(baseUrl, bridge.token, 'POST', '/v1/images/fetch', { ...validRequest(), imageIndex: 1 })
  assert.equal(outOfRange.status, 404)
  assert.equal((await outOfRange.json()).code, 'IMAGE_NOT_FOUND')

  const mismatch = await call(baseUrl, bridge.token, 'POST', '/v1/images/fetch', {
    ...validRequest(),
    expectedMd5: md5('different'),
  })
  assert.equal(mismatch.status, 409)
  assert.equal((await mismatch.json()).code, 'IMAGE_REFERENCE_MISMATCH')
  assert.equal(qq.downloads.length, 0)

  qq.options.writeBytes = Buffer.from('not-the-expected-image')
  const corrupt = await call(baseUrl, bridge.token, 'POST', '/v1/images/fetch', validRequest())
  assert.equal(corrupt.status, 502)
  assert.equal((await corrupt.json()).code, 'IMAGE_INTEGRITY_FAILED')
})

test('concurrent requests for one attachment share a single native download', async (t) => {
  const { qq, bridge, baseUrl } = await startBridge(t)
  qq.login()
  qq.options.delay = 20
  const [first, second] = await Promise.all([
    call(baseUrl, bridge.token, 'POST', '/v1/images/fetch', validRequest()),
    call(baseUrl, bridge.token, 'POST', '/v1/images/fetch', validRequest()),
  ])
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(qq.downloads.length, 1)
})

test('the native download limit reports QQ_IMAGE_BUSY with Retry-After', async (t) => {
  const { qq, bridge, baseUrl } = await startBridge(t, {
    qqOptions: { pictureMd5: null },
    bridge: { maxDownloads: 1 },
  })
  qq.login()
  qq.options.delay = 60
  const first = call(baseUrl, bridge.token, 'POST', '/v1/images/fetch', validRequest())
  while (!qq.downloads.length) await new Promise((resolve) => setTimeout(resolve, 2))
  const busy = await call(baseUrl, bridge.token, 'POST', '/v1/images/fetch', {
    ...validRequest(),
    imageIndex: 0,
    expectedMd5: md5('another'),
  })
  assert.equal(busy.status, 429)
  assert.equal(busy.headers.get('retry-after'), '2')
  assert.equal((await busy.json()).code, 'QQ_IMAGE_BUSY')
  assert.equal((await first).status, 200)
})

test('a timed-out native task keeps its slot until the late completion event', async (t) => {
  const { qq, bridge, baseUrl } = await startBridge(t, {
    qqOptions: { pictureMd5: null },
    bridge: { downloadTimeoutMs: 30, maxDownloads: 1 },
  })
  qq.login()
  qq.options.neverComplete = true
  const timedOut = await call(baseUrl, bridge.token, 'POST', '/v1/images/fetch', validRequest())
  assert.equal(timedOut.status, 504)
  assert.equal((await timedOut.json()).code, 'QQ_DOWNLOAD_TIMEOUT')
  assert.equal(qq.downloads.length, 1)

  // The slot is still occupied until QQ reports the real completion.
  const busy = await call(baseUrl, bridge.token, 'POST', '/v1/images/fetch', {
    ...validRequest(),
    imageIndex: 0,
    expectedMd5: md5('another'),
  })
  assert.equal(busy.status, 429)

  qq.completePending()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(bridge.activeDownloads, 0)
  assert.equal(fs.readdirSync(path.join(bridge.runtimeDir, 'image-downloads')).length, 0)
})

test('logout is reported and stops further downloads', async (t) => {
  const { qq, bridge, baseUrl } = await startBridge(t)
  qq.login()
  assert.equal((await (await call(baseUrl, bridge.token, 'GET', '/v1/health')).json()).ready, true)
  qq.logout()
  const health = await (await call(baseUrl, bridge.token, 'GET', '/v1/health')).json()
  assert.equal(health.loggedIn, false)
  assert.equal(health.ready, false)
  assert.equal(health.accountUin, null)
  const response = await call(baseUrl, bridge.token, 'POST', '/v1/images/fetch', validRequest())
  assert.equal(response.status, 503)
  assert.equal(qq.downloads.length, 0)
})

test('stopping the bridge removes only its own discovery file', async (t) => {
  const { bridge } = await startBridge(t)
  assert.equal(fs.existsSync(bridge.discoveryPath), true)
  await bridge.stop()
  assert.equal(fs.existsSync(bridge.discoveryPath), false)
  // A stale foreign discovery file is left untouched.
  fs.writeFileSync(bridge.discoveryPath, JSON.stringify({ instanceId: 'other' }))
  await bridge.stop()
  assert.equal(fs.existsSync(bridge.discoveryPath), true)
  bridge.shutdownSync()
  assert.equal(fs.existsSync(bridge.discoveryPath), true)
  fs.rmSync(bridge.discoveryPath)
})
