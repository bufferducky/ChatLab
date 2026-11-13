'use strict'

/**
 * QQ in-process image bridge.
 *
 * Runs inside the user's already logged-in QQ main process. It captures the
 * session QQ itself creates, listens for login state, and exposes exactly two
 * loopback HTTP operations: a status query and an original-image fetch. It never
 * exposes arbitrary IPC, paths, URLs, expressions or native method names.
 *
 * The contract, error codes and limits are specified in IMAGE_BRIDGE_API.md.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const PROTOCOL_VERSION = '1'
const MAX_IMAGE_BYTES = 50 * 1024 * 1024
const MAX_BODY_BYTES = 16 * 1024
const DOWNLOAD_TIMEOUT_MS = 50_000
const MAX_CONCURRENT_DOWNLOADS = 2
const CAPABILITY = 'fetch-image-original'
const DISCOVERY_FILE = 'image-bridge.json'
const DOWNLOAD_PREFIX = 'chatlab-image-'
const IMAGE_ELEMENT_TYPE = 2
const LOG_LIMIT_BYTES = 1024 * 1024

const ERROR_STATUS = {
  INVALID_IMAGE_REQUEST: 400,
  UNAUTHORIZED: 401,
  MESSAGE_NOT_FOUND: 404,
  IMAGE_NOT_FOUND: 404,
  QQ_IMAGE_UNAVAILABLE: 404,
  QQ_ACCOUNT_MISMATCH: 409,
  QQ_DATA_SOURCE_MISMATCH: 409,
  IMAGE_REFERENCE_MISMATCH: 409,
  IMAGE_TOO_LARGE: 413,
  UNSUPPORTED_IMAGE: 415,
  QQ_IMAGE_BUSY: 429,
  QQ_DOWNLOAD_FAILED: 502,
  IMAGE_INTEGRITY_FAILED: 502,
  QQ_BRIDGE_UNAVAILABLE: 503,
  QQ_OFFLINE: 503,
  QQ_BRIDGE_INCOMPATIBLE: 503,
  QQ_DOWNLOAD_TIMEOUT: 504,
}

const MESSAGES = {
  INVALID_IMAGE_REQUEST: 'Invalid image request',
  UNAUTHORIZED: 'Unauthorized',
  MESSAGE_NOT_FOUND: 'Message not found',
  IMAGE_NOT_FOUND: 'Image not found',
  QQ_IMAGE_UNAVAILABLE: 'QQ cannot provide this image',
  QQ_ACCOUNT_MISMATCH: 'QQ account differs from the data source account',
  QQ_DATA_SOURCE_MISMATCH: 'QQ uses a different account data directory',
  IMAGE_REFERENCE_MISMATCH: 'Image reference does not match the original message',
  IMAGE_TOO_LARGE: 'Image exceeds the size limit',
  UNSUPPORTED_IMAGE: 'Unsupported or damaged image',
  QQ_IMAGE_BUSY: 'QQ image download is busy',
  QQ_DOWNLOAD_FAILED: 'QQ image download failed',
  IMAGE_INTEGRITY_FAILED: 'Downloaded image failed integrity verification',
  QQ_BRIDGE_UNAVAILABLE: 'QQ image bridge is unavailable',
  QQ_OFFLINE: 'QQ is offline',
  QQ_BRIDGE_INCOMPATIBLE: 'QQ image bridge is incompatible with this QQ version',
  QQ_DOWNLOAD_TIMEOUT: 'QQ image download timed out',
}

// Codes a retry may fix once the user logs in, restarts QQ or waits a moment.
const NON_RETRYABLE = new Set([
  'INVALID_IMAGE_REQUEST',
  'UNAUTHORIZED',
  'MESSAGE_NOT_FOUND',
  'IMAGE_NOT_FOUND',
  'QQ_IMAGE_UNAVAILABLE',
  'QQ_ACCOUNT_MISMATCH',
  'QQ_DATA_SOURCE_MISMATCH',
  'IMAGE_REFERENCE_MISMATCH',
  'IMAGE_TOO_LARGE',
  'UNSUPPORTED_IMAGE',
  'QQ_BRIDGE_INCOMPATIBLE',
])

class BridgeError extends Error {
  constructor(status, code, message) {
    super(message || MESSAGES[code] || 'Image unavailable')
    this.name = 'BridgeError'
    this.status = status || ERROR_STATUS[code] || 502
    this.code = code
    this.retryable = !NON_RETRYABLE.has(code)
  }

  payload() {
    return { error: this.message, code: this.code, retryable: this.retryable }
  }
}

function digest(value, algorithm = 'md5') {
  return crypto.createHash(algorithm).update(value).digest('hex')
}

function normalizeMd5(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{32}$/.test(value) ? value.toLowerCase() : null
}

function normalizeUin(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return typeof value === 'string' && /^[1-9][0-9]{4,11}$/.test(value) ? value : null
}

/** Validate the only request shape this bridge accepts. Extra fields are rejected. */
function validateFetchRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeError(400, 'INVALID_IMAGE_REQUEST')
  }
  const keys = Object.keys(value).sort()
  const expected = ['chatType', 'expectedMd5', 'imageIndex', 'msgId', 'peerUid']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new BridgeError(400, 'INVALID_IMAGE_REQUEST')
  }
  if (value.chatType !== 1 && value.chatType !== 2) {
    throw new BridgeError(400, 'INVALID_IMAGE_REQUEST')
  }
  if (typeof value.peerUid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.peerUid)) {
    throw new BridgeError(400, 'INVALID_IMAGE_REQUEST')
  }
  // Native 64-bit ids stay decimal strings; a JSON number is always rejected.
  if (typeof value.msgId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.msgId)) {
    throw new BridgeError(400, 'INVALID_IMAGE_REQUEST')
  }
  if (
    typeof value.imageIndex !== 'number' ||
    !Number.isInteger(value.imageIndex) ||
    value.imageIndex < 0 ||
    value.imageIndex > 99
  ) {
    throw new BridgeError(400, 'INVALID_IMAGE_REQUEST')
  }
  const expectedMd5 = normalizeMd5(value.expectedMd5)
  if (!expectedMd5) throw new BridgeError(400, 'INVALID_IMAGE_REQUEST')
  return {
    chatType: value.chatType,
    peerUid: value.peerUid,
    msgId: value.msgId,
    imageIndex: value.imageIndex,
    expectedMd5,
  }
}

/** MD5 values a QQ picture element claims for itself, if any. */
function pictureMd5s(element) {
  const picture = (element && element.picElement) || {}
  const found = new Set()
  for (const value of [picture.md5HexStr, picture.originImageMd5]) {
    const normalized = normalizeMd5(value)
    if (normalized) found.add(normalized)
  }
  if (typeof picture.fileName === 'string') {
    const stem = path.parse(picture.fileName).name
    if (/^[0-9a-fA-F]{32}$/.test(stem)) found.add(stem.toLowerCase())
  }
  return found
}

function realpath(value) {
  try {
    return fs.realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function ensureDirectory(directory, mode = 0o700) {
  fs.mkdirSync(directory, { recursive: true, mode })
  try {
    fs.chmodSync(directory, mode)
  } catch {
    // Best effort: POSIX modes are advisory on some filesystems.
  }
}

function within(parent, candidate) {
  const base = path.resolve(parent)
  const target = path.resolve(candidate)
  return target === base || target.startsWith(base + path.sep)
}

function defaultHome() {
  if (process.env.CHATLAB_QQ_HOME) return path.resolve(process.env.CHATLAB_QQ_HOME)
  return path.join(os.homedir(), '.local', 'share', 'chatlab-qq')
}

function defaultRoots() {
  const roots = []
  if (process.env.CHATLAB_QQ_DATA_ROOT) roots.push(process.env.CHATLAB_QQ_DATA_ROOT)
  if (process.platform === 'darwin') {
    roots.push(
      path.join(
        os.homedir(),
        'Library',
        'Containers',
        'com.tencent.qq',
        'Data',
        'Library',
        'Application Support',
        'QQ'
      ),
      path.join(os.homedir(), 'Library', 'Application Support', 'QQ')
    )
  } else if (process.platform === 'win32') {
    if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'Tencent', 'QQ'))
  } else {
    roots.push(path.join(os.homedir(), '.config', 'QQ'))
  }
  return roots.filter((root) => {
    try {
      return fs.statSync(root).isDirectory()
    } catch {
      return false
    }
  })
}

function readQqVersion(roots) {
  for (const root of roots) {
    const config = readJson(path.join(root, 'versions', 'config.json'))
    if (config && typeof config.curVersion === 'string' && /^\d+\.\d+\.\d+/.test(config.curVersion)) {
      return config.curVersion
    }
  }
  return null
}

class ImageBridge {
  constructor(options = {}) {
    this.home = path.resolve(options.home || defaultHome())
    this.qqRoot = options.qqRoot ? path.resolve(options.qqRoot) : null
    this.roots = this.qqRoot ? [this.qqRoot] : options.roots || defaultRoots()
    this.qqVersion = options.qqVersion || null
    this.electronVersion = options.electronVersion || null
    this.session = options.session || null
    this.wrapper = options.wrapper || null
    this.downloadTimeoutMs = options.downloadTimeoutMs || DOWNLOAD_TIMEOUT_MS
    this.maxDownloads = options.maxDownloads || MAX_CONCURRENT_DOWNLOADS
    this.now = options.now || Date.now
    this.runtimeDir = path.join(this.home, 'runtime')
    this.downloadsDir = path.join(this.runtimeDir, 'image-downloads')
    this.discoveryPath = path.join(this.runtimeDir, DISCOVERY_FILE)
    this.logPath = path.join(this.runtimeDir, 'image-bridge.log')
    this.instanceId = crypto.randomBytes(16).toString('hex')
    this.token = crypto.randomBytes(32).toString('base64url')
    this.server = null
    this.baseUrl = null
    this.pending = new Map()
    this.entries = new Map()
    this.activeDownloads = 0
    this.listenerInstalled = false
    this.sessions = []
    this.accountCache = null
    this.login = { loggedIn: false, uin: null, uid: null }
    this.kernelListener = new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === 'onRichMediaDownloadComplete') {
            return (data) => this.handleDownloadComplete(data)
          }
          return () => {}
        },
      }
    )
    this.loginListener = new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === 'onUserLoggedIn') return (info) => this.handleLoggedIn(info)
          if (
            property === 'onLoginDisConnected' ||
            property === 'onLogoutSucceed' ||
            property === 'onLogoutFailed' ||
            property === 'onLoginFailed' ||
            property === 'onLoginAbort'
          ) {
            return () => this.handleLoggedOut()
          }
          return () => {}
        },
      }
    )
  }

  // ---- logging -----------------------------------------------------------

  log(level, code, detail) {
    try {
      ensureDirectory(this.runtimeDir)
      try {
        if (fs.statSync(this.logPath).size > LOG_LIMIT_BYTES) fs.truncateSync(this.logPath, 0)
      } catch {
        // The log is created by appendFileSync below.
      }
      const line = JSON.stringify({
        at: new Date(this.now()).toISOString(),
        level,
        code,
        detail: typeof detail === 'string' ? detail.slice(0, 120) : undefined,
      })
      fs.appendFileSync(this.logPath, line + '\n', { mode: 0o600 })
    } catch {
      // Logging must never affect image delivery.
    }
  }

  // ---- lifecycle ---------------------------------------------------------

  async start() {
    ensureDirectory(this.home)
    ensureDirectory(this.runtimeDir)
    ensureDirectory(this.downloadsDir)
    this.cleanupDownloads()
    this.installListener()
    this.registerLoginListener()
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        if (response.headersSent) {
          response.destroy()
          return
        }
        this.respondJson(response, 503, new BridgeError(503, 'QQ_BRIDGE_UNAVAILABLE').payload())
        this.log('error', 'UNHANDLED_REQUEST', error && error.code)
      })
    })
    this.server.requestTimeout = 60_000
    this.server.headersTimeout = 15_000
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    this.baseUrl = `http://127.0.0.1:${this.server.address().port}`
    this.writeDiscovery()
    this.log('info', 'BRIDGE_STARTED', String(this.server.address().port))
    return this.baseUrl
  }

  async stop() {
    try {
      if (this.server) {
        await new Promise((resolve) => this.server.close(resolve))
        this.server = null
      }
    } catch {
      this.server = null
    }
    this.removeDiscovery()
    this.cleanupDownloads()
    this.entries.clear()
    this.pending.clear()
    this.activeDownloads = 0
    this.log('info', 'BRIDGE_STOPPED')
  }

  /** Synchronous best-effort cleanup for process-exit hooks. */
  shutdownSync() {
    this.removeDiscovery()
    this.cleanupDownloads()
    this.entries.clear()
    this.pending.clear()
  }

  writeDiscovery() {
    const payload = {
      protocolVersion: PROTOCOL_VERSION,
      baseUrl: this.baseUrl,
      token: this.token,
      pid: process.pid,
      instanceId: this.instanceId,
    }
    const temporary = `${this.discoveryPath}.${crypto.randomBytes(6).toString('hex')}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(payload) + '\n', { mode: 0o600 })
    fs.renameSync(temporary, this.discoveryPath)
    fs.chmodSync(this.discoveryPath, 0o600)
  }

  removeDiscovery() {
    const current = readJson(this.discoveryPath)
    if (!current || current.instanceId !== this.instanceId) return
    try {
      fs.rmSync(this.discoveryPath, { force: true })
    } catch {
      // Another process may have replaced it; leaving it is safe because the
      // collector health-checks the advertised instance before use.
    }
  }

  cleanupDownloads() {
    let names = []
    try {
      names = fs.readdirSync(this.downloadsDir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.startsWith(DOWNLOAD_PREFIX)) continue
      try {
        fs.rmSync(path.join(this.downloadsDir, name), { force: true })
      } catch {
        // Ignore; a later start retries cleanup.
      }
    }
  }

  // ---- login / account ---------------------------------------------------

  loginService() {
    const service = this.wrapper && this.wrapper.NodeIKernelLoginService
    try {
      if (service && typeof service.get === 'function') return service.get()
    } catch {
      return null
    }
    return null
  }

  registerLoginListener() {
    const service = this.loginService()
    if (!service || typeof service.addKernelLoginListener !== 'function') return
    try {
      service.addKernelLoginListener(this.loginListener)
      this.loginListenerInstalled = true
    } catch {
      this.loginListenerInstalled = false
    }
  }

  handleLoggedIn(info) {
    this.login.loggedIn = true
    const uin = normalizeUin(info && (info.uin || info.Uin))
    const uid = info && typeof info.uid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(info.uid) ? info.uid : null
    if (uin) this.login.uin = uin
    if (uid) this.login.uid = uid
    if (!this.login.uin || !this.login.uid) this.hydrateIdentity()
    this.accountCache = null
    this.log('info', 'QQ_LOGGED_IN')
  }

  handleLoggedOut() {
    this.login = { loggedIn: false, uin: null, uid: null }
    this.accountCache = null
    this.log('info', 'QQ_LOGGED_OUT')
  }

  /** Identity from the local login index; never used to claim online state. */
  hydrateIdentity() {
    const service = this.loginService()
    if (!service || typeof service.getLoginList !== 'function') return
    let list
    try {
      list = service.getLoginList()
    } catch {
      return
    }
    const entries =
      (list && (list.LocalLoginInfoList || list.localLoginInfoList || list.loginList)) ||
      (Array.isArray(list) ? list : [])
    if (!Array.isArray(entries) || !entries.length) return
    const matching = this.login.uin
      ? entries.filter((entry) => entry && normalizeUin(entry.uin || entry.Uin) === this.login.uin)
      : entries
    if (matching.length !== 1) return
    const entry = matching[0]
    const uin = normalizeUin(entry.uin || entry.Uin)
    const uid = typeof entry.uid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(entry.uid) ? entry.uid : null
    if (uin) this.login.uin = uin
    if (uid) this.login.uid = uid
  }

  qqRoots() {
    const found = []
    for (const root of this.roots) {
      try {
        if (fs.statSync(root).isDirectory()) found.push(realpath(root))
      } catch {
        // Skip roots that disappeared; another candidate may still work.
      }
    }
    return [...new Set(found)]
  }

  accountDir(root, uid) {
    // Compare resolved paths: macOS temporary and container paths are symlinked.
    const base = realpath(root)
    const valid = (candidate) => {
      try {
        const resolved = fs.realpathSync(candidate)
        if (!within(base, resolved)) return null
        if (!fs.statSync(path.join(resolved, 'nt_db', 'nt_msg.db')).isFile()) return null
        return resolved
      } catch {
        return null
      }
    }
    // Prefer the session accessor when this QQ version provides one.
    try {
      if (this.session && typeof this.session.getAccountPath === 'function') {
        const candidate = this.session.getAccountPath(uid)
        if (typeof candidate === 'string' && candidate) {
          const resolved = valid(candidate)
          if (resolved) return resolved
        }
      }
    } catch {
      // Fall through to the documented directory derivation.
    }
    const inner = digest(uid, 'md5')
    const suffix = digest(inner + 'nt_kernel', 'md5')
    return valid(path.join(base, `nt_qq_${suffix}`))
  }

  accountInfo() {
    const cached = this.accountCache
    if (cached && this.now() - cached.at < 5000) return cached.value
    if (!this.login.uin || !this.login.uid) this.hydrateIdentity()
    const roots = this.qqRoots()
    let root = roots[0] || (this.qqRoot ? realpath(this.qqRoot) : null)
    let dataDir = null
    if (root && this.login.uid) {
      for (const candidate of roots) {
        const resolved = this.accountDir(candidate, this.login.uid)
        if (resolved) {
          root = candidate
          dataDir = resolved
          break
        }
      }
    }
    const value = {
      uin: this.login.uin,
      uid: this.login.uid,
      dataDir,
      root,
      qqVersion: this.qqVersion || readQqVersion(roots),
    }
    this.accountCache = { at: this.now(), value }
    return value
  }

  // ---- health ------------------------------------------------------------

  sessionCaptured() {
    return Boolean(this.session && typeof this.session.getMsgService === 'function')
  }

  msgService() {
    if (!this.sessionCaptured()) return null
    try {
      return this.session.getMsgService()
    } catch {
      return null
    }
  }

  capabilityList() {
    if (!this.sessionCaptured()) return []
    const service = this.msgService()
    if (
      service &&
      typeof service.getMsgsByMsgId === 'function' &&
      typeof service.downloadRichMedia === 'function' &&
      typeof service.addKernelMsgListener === 'function' &&
      typeof service.removeKernelMsgListener === 'function'
    ) {
      return [CAPABILITY]
    }
    return []
  }

  healthPayload() {
    const account = this.accountInfo()
    const capabilities = this.capabilityList()
    const captured = this.sessionCaptured()
    const loggedIn = this.login.loggedIn === true
    return {
      protocolVersion: PROTOCOL_VERSION,
      instanceId: this.instanceId,
      ready: Boolean(captured && capabilities.length && loggedIn && account.uin && account.dataDir),
      sessionCaptured: captured,
      loggedIn,
      accountUin: loggedIn && account.uin ? account.uin : null,
      accountDataDir: loggedIn && account.dataDir ? account.dataDir : null,
      qqVersion: account.qqVersion || null,
      electronVersion: this.electronVersion || null,
      capabilities,
    }
  }

  // ---- HTTP --------------------------------------------------------------

  async handle(request, response) {
    try {
      if (!this.authorized(request.headers.authorization)) {
        throw new BridgeError(401, 'UNAUTHORIZED')
      }
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        if (url.search || url.hash) throw new BridgeError(400, 'INVALID_IMAGE_REQUEST')
        return this.respondJson(response, 200, this.healthPayload())
      }
      if (request.method === 'POST' && url.pathname === '/v1/images/fetch') {
        if (url.search || url.hash) throw new BridgeError(400, 'INVALID_IMAGE_REQUEST')
        const body = await this.readBody(request)
        let payload
        try {
          payload = JSON.parse(body.toString('utf8'))
        } catch {
          throw new BridgeError(400, 'INVALID_IMAGE_REQUEST')
        }
        const image = await this.fetchImage(validateFetchRequest(payload))
        return this.respondBytes(response, image)
      }
      throw new BridgeError(404, 'IMAGE_NOT_FOUND', 'Not found')
    } catch (error) {
      const failure = error instanceof BridgeError ? error : new BridgeError(502, 'QQ_DOWNLOAD_FAILED')
      this.log('warn', failure.code)
      const headers = failure.status === 429 ? { 'Retry-After': '2' } : undefined
      this.respondJson(response, failure.status, failure.payload(), headers)
    }
  }

  authorized(header) {
    if (typeof header !== 'string') return false
    const expected = 'Bearer ' + this.token
    const left = Buffer.from(header)
    const right = Buffer.from(expected)
    return left.length === right.length && crypto.timingSafeEqual(left, right)
  }

  readBody(request) {
    return new Promise((resolve, reject) => {
      const declared = Number(request.headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        reject(new BridgeError(413, 'IMAGE_TOO_LARGE'))
        request.resume()
        return
      }
      const chunks = []
      let size = 0
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(new BridgeError(413, 'IMAGE_TOO_LARGE'))
          request.destroy()
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => resolve(Buffer.concat(chunks)))
      request.on('error', () => reject(new BridgeError(400, 'INVALID_IMAGE_REQUEST')))
    })
  }

  respondJson(response, status, value, headers) {
    const body = Buffer.from(JSON.stringify(value))
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': String(body.length),
      ...(headers || {}),
    })
    response.end(body)
  }

  respondBytes(response, body) {
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': String(body.length),
    })
    response.end(body)
  }

  // ---- image download ----------------------------------------------------

  async fetchImage(request) {
    const key = [request.chatType, request.peerUid, request.msgId, request.imageIndex, request.expectedMd5].join(
      '\u0000'
    )
    const running = this.pending.get(key)
    if (running) return running
    const task = this.executeFetch(request)
    this.pending.set(key, task)
    try {
      return await task
    } finally {
      this.pending.delete(key)
    }
  }

  async executeFetch(request) {
    const health = this.healthPayload()
    if (!health.ready) {
      if (!health.sessionCaptured || !this.capabilityList().length) {
        throw new BridgeError(503, 'QQ_BRIDGE_INCOMPATIBLE')
      }
      if (!health.loggedIn) throw new BridgeError(503, 'QQ_OFFLINE')
      throw new BridgeError(503, 'QQ_BRIDGE_INCOMPATIBLE')
    }
    if (this.entries.size >= 16) throw new BridgeError(429, 'QQ_IMAGE_BUSY')
    const { element } = await this.queryMessage(request)
    const claimed = pictureMd5s(element)
    // When QQ reports picture hashes they must agree with the archived message.
    if (claimed.size && !claimed.has(request.expectedMd5)) {
      throw new BridgeError(409, 'IMAGE_REFERENCE_MISMATCH')
    }
    if (this.activeDownloads >= this.maxDownloads) {
      throw new BridgeError(429, 'QQ_IMAGE_BUSY')
    }
    this.activeDownloads += 1
    const entry = this.startDownload(request, element)
    try {
      return await this.waitFor(entry)
    } catch (error) {
      if (!entry.settled) {
        // The native task cannot be cancelled reliably; keep its slot and
        // listener until QQ emits the completion event or the session exits.
        this.log('warn', error.code || 'IMAGE_UNSETTLED')
      }
      throw error
    }
  }

  async queryMessage(request) {
    const service = this.msgService()
    let response
    try {
      response = await service.getMsgsByMsgId({ chatType: request.chatType, peerUid: request.peerUid }, [request.msgId])
    } catch {
      throw new BridgeError(502, 'QQ_DOWNLOAD_FAILED')
    }
    if (response && typeof response.result === 'number' && response.result !== 0) {
      throw new BridgeError(404, 'MESSAGE_NOT_FOUND')
    }
    const list = (response && (response.msgList || response.msgs)) || (Array.isArray(response) ? response : [])
    if (!Array.isArray(list) || !list.length) throw new BridgeError(404, 'QQ_IMAGE_UNAVAILABLE')
    const message = list.find((item) => item && String(item.msgId) === request.msgId) || list[0]
    if (!message || String(message.msgId) !== request.msgId) {
      throw new BridgeError(409, 'IMAGE_REFERENCE_MISMATCH')
    }
    const pictures = (Array.isArray(message.elements) ? message.elements : []).filter(
      (element) =>
        element &&
        element.elementType === IMAGE_ELEMENT_TYPE &&
        element.picElement &&
        typeof element.elementId === 'string' &&
        element.elementId
    )
    if (request.imageIndex >= pictures.length) throw new BridgeError(404, 'IMAGE_NOT_FOUND')
    return { message, element: pictures[request.imageIndex] }
  }

  installListener() {
    if (this.listenerInstalled) return
    const service = this.msgService()
    if (!service || typeof service.addKernelMsgListener !== 'function') return
    try {
      service.addKernelMsgListener(this.kernelListener)
      this.listenerInstalled = true
    } catch {
      this.listenerInstalled = false
    }
  }

  startDownload(request, element) {
    const filePath = path.join(this.downloadsDir, DOWNLOAD_PREFIX + crypto.randomUUID() + '.img')
    const entry = {
      key: request.msgId + '\u0000' + element.elementId,
      msgId: request.msgId,
      elementId: element.elementId,
      filePath,
      expectedMd5: request.expectedMd5,
      settled: false,
      bytes: null,
      error: null,
      resolve: null,
      promise: null,
    }
    entry.promise = new Promise((resolve) => {
      entry.resolve = resolve
    })
    this.entries.set(entry.key, entry)
    this.installListener()
    try {
      const service = this.msgService()
      const result = service.downloadRichMedia({
        fileModelId: '0',
        downSourceType: 0,
        downloadSourceType: 0,
        triggerType: 1,
        msgId: request.msgId,
        chatType: request.chatType,
        peerUid: request.peerUid,
        elementId: element.elementId,
        thumbSize: 0,
        downloadType: 1,
        filePath,
      })
      if (result && typeof result.catch === 'function') {
        result.catch(() => this.finishEntry(entry, new BridgeError(502, 'QQ_DOWNLOAD_FAILED'), null))
      }
    } catch {
      this.finishEntry(entry, new BridgeError(502, 'QQ_DOWNLOAD_FAILED'), null)
    }
    return entry
  }

  handleDownloadComplete(data) {
    const msgId = data ? String(data.msgId) : ''
    const elementId = data ? String(data.msgElementId) : ''
    let entry = this.entries.get(msgId + '\u0000' + elementId)
    if (!entry && msgId) {
      for (const candidate of this.entries.values()) {
        if (candidate.msgId === msgId) {
          entry = candidate
          break
        }
      }
    }
    if (!entry || entry.settled) return
    this.entries.delete(entry.key)
    this.finishEntryFromEvent(entry, data)
  }

  finishEntryFromEvent(entry, data) {
    const failureCode = data && data.fileErrCode
    const serviceCode = data && data.fileSrvErrCode
    if ((failureCode && failureCode !== 0) || (serviceCode && serviceCode !== 0)) {
      this.finishEntry(entry, new BridgeError(502, 'QQ_DOWNLOAD_FAILED'), null)
      return
    }
    const candidate = this.completionPath(entry, data && data.filePath)
    let info
    try {
      info = fs.statSync(candidate)
    } catch {
      this.finishEntry(entry, new BridgeError(502, 'QQ_DOWNLOAD_FAILED'), null)
      return
    }
    if (!info.isFile() || info.size <= 0) {
      this.finishEntry(entry, new BridgeError(502, 'QQ_DOWNLOAD_FAILED'), null)
      return
    }
    if (info.size > MAX_IMAGE_BYTES) {
      this.finishEntry(entry, new BridgeError(413, 'IMAGE_TOO_LARGE'), null)
      return
    }
    let bytes
    try {
      bytes = fs.readFileSync(candidate)
    } catch {
      this.finishEntry(entry, new BridgeError(502, 'QQ_DOWNLOAD_FAILED'), null)
      return
    }
    if (bytes.length !== info.size || digest(bytes) !== entry.expectedMd5) {
      this.finishEntry(entry, new BridgeError(502, 'IMAGE_INTEGRITY_FAILED'), null)
      return
    }
    this.finishEntry(entry, null, bytes)
  }

  completionPath(entry, reported) {
    // Only accept completion paths inside this account or the bridge's own
    // temporary directory; QQ's own cache is read, never deleted.
    if (typeof reported === 'string' && reported) {
      try {
        const resolved = fs.realpathSync(reported)
        const allowed = [...this.qqRoots(), realpath(this.downloadsDir)].some((root) => within(root, resolved))
        if (allowed) return resolved
      } catch {
        // Fall back to the requested path.
      }
    }
    return entry.filePath
  }

  finishEntry(entry, error, bytes) {
    if (!entry || entry.settled) return
    entry.settled = true
    entry.error = error
    entry.bytes = bytes
    if (this.activeDownloads > 0) this.activeDownloads -= 1
    this.removeEntryFiles(entry)
    entry.resolve()
  }

  removeEntryFiles(entry) {
    for (const candidate of [entry.filePath]) {
      if (!instanceSafeDownload(this.downloadsDir, candidate)) continue
      try {
        fs.rmSync(candidate, { force: true })
      } catch {
        // A later start cleans up any residue.
      }
    }
  }

  waitFor(entry) {
    if (entry.settled) {
      return entry.error ? Promise.reject(entry.error) : Promise.resolve(entry.bytes)
    }
    let timer
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new BridgeError(504, 'QQ_DOWNLOAD_TIMEOUT')), this.downloadTimeoutMs)
    })
    return Promise.race([entry.promise, timeout])
      .then(
        () => (entry.error ? Promise.reject(entry.error) : entry.bytes),
        (error) => Promise.reject(error)
      )
      .finally(() => clearTimeout(timer))
  }
}

function instanceSafeDownload(directory, candidate) {
  return within(directory, candidate)
}

function createBridge(options) {
  return new ImageBridge(options)
}

module.exports = {
  createBridge,
  ImageBridge,
  BridgeError,
  PROTOCOL_VERSION,
  MAX_IMAGE_BYTES,
  MAX_BODY_BYTES,
  DOWNLOAD_TIMEOUT_MS,
  validateFetchRequest,
  pictureMd5s,
  normalizeMd5,
  normalizeUin,
  defaultRoots,
  defaultHome,
}
