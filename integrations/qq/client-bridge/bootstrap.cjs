'use strict'

/**
 * Entry point for a QQ client that runs the ChatLab image bridge in-process.
 *
 * Deployment copies this file next to `application.asar` and points the QQ
 * `package.json` "main" at it. This file then:
 *   1. installs a narrow interception of `wrapper.node` to capture the session
 *      QQ itself creates (it does not create or log in a second client),
 *   2. starts the loopback image bridge with an ephemeral token,
 *   3. requires the original QQ launcher unchanged.
 *
 * Every step is guarded: a bridge failure must never prevent QQ from starting.
 * Set CHATLAB_QQ_BRIDGE=0 to load QQ without the bridge.
 */

const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const appDir = __dirname
const state = { wrapper: null, session: null, started: false, bridge: null, error: null }

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function log(level, code, detail) {
  try {
    const home = process.env.CHATLAB_QQ_HOME || path.join(require('node:os').homedir(), '.local', 'share', 'chatlab-qq')
    const dir = path.join(home, 'runtime')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const line = JSON.stringify({
      at: new Date().toISOString(),
      level,
      code,
      detail: typeof detail === 'string' ? detail.slice(0, 160) : undefined,
    })
    fs.appendFileSync(path.join(dir, 'image-bridge-launcher.log'), line + '\n', { mode: 0o600 })
  } catch {
    // Never let diagnostics affect QQ startup.
  }
}

function startBridge(wrapper) {
  if (state.started || process.env.CHATLAB_QQ_BRIDGE === '0') return
  if (!state.session || !wrapper) return
  state.started = true
  try {
    const { createBridge } = require('./image-bridge.cjs')
    const bridge = createBridge({
      wrapper,
      session: state.session,
      electronVersion: process.versions.electron || null,
    })
    state.bridge = bridge
    bridge.start().then(
      () => {
        log('info', 'BRIDGE_STARTED')
        process.on('exit', () => {
          try {
            bridge.shutdownSync()
          } catch {
            // Exit must stay clean.
          }
        })
        for (const signal of ['SIGTERM', 'SIGINT']) {
          process.once(signal, () => {
            try {
              bridge.shutdownSync()
            } catch {
              // Exit must stay clean.
            }
          })
        }
      },
      (error) => {
        state.error = error && error.code
        log('error', 'BRIDGE_START_FAILED', state.error)
      }
    )
  } catch (error) {
    state.error = (error && error.code) || 'BRIDGE_IMPORT_FAILED'
    log('error', 'BRIDGE_IMPORT_FAILED', state.error)
  }
}

// ---- wrapper.node session capture -----------------------------------------

const wrapped = new WeakMap()

function facade(target, get, construct) {
  const empty = typeof target === 'function' ? function () {} : {}
  let proxy
  proxy = new Proxy(empty, {
    get: (_target, key) => get(key),
    has: (_target, key) => Reflect.has(target, key),
    ownKeys: () => Reflect.ownKeys(target),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
      return descriptor ? { ...descriptor, configurable: true } : undefined
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(target),
    set: (_target, key, value) => Reflect.set(target, key, value, target),
    apply: (_target, owner, args) => Reflect.apply(target, owner, args),
    construct: (_target, args, newTarget) => {
      const value = Reflect.construct(target, args, newTarget === proxy ? target : newTarget)
      return construct ? construct(value) : value
    },
  })
  return proxy
}

function capture(session) {
  if (session && typeof session.getMsgService === 'function') {
    state.session = session
    startBridge(state.wrapper)
  }
  return session
}

function wrap(exports) {
  if (!exports || !exports.NodeIQQNTWrapperSession) return exports
  if (wrapped.has(exports)) return wrapped.get(exports)
  state.wrapper = exports
  const factory = exports.NodeIQQNTWrapperSession
  const methods = new Map()
  const service = facade(
    factory,
    (key) => {
      const value = Reflect.get(factory, key, factory)
      if (typeof value !== 'function' || key === 'constructor') return value
      if (!methods.has(key)) {
        methods.set(key, (...args) => {
          const result = Reflect.apply(value, factory, args)
          if (key === 'create' || key === 'getNTWrapperSession' || key === 'getWrapperSession' || key === 'get') {
            return capture(result)
          }
          return result
        })
      }
      return methods.get(key)
    },
    capture
  )
  const result = facade(exports, (key) =>
    key === 'NodeIQQNTWrapperSession' ? service : Reflect.get(exports, key, exports)
  )
  wrapped.set(exports, result)
  return result
}

function installInterceptor() {
  const originalLoad = Module._load
  Module._load = function (...args) {
    const result = Reflect.apply(originalLoad, this, args)
    try {
      if (typeof args[0] === 'string' && /wrapper\.node$/.test(args[0])) return wrap(result)
    } catch (error) {
      log('error', 'WRAPPER_HOOK_FAILED', error && error.code)
    }
    return result
  }
  const originalDlopen = process.dlopen
  process.dlopen = function (module, filename, ...args) {
    const result = Reflect.apply(originalDlopen, this, [module, filename, ...args])
    try {
      if (path.basename(filename) === 'wrapper.node') module.exports = wrap(module.exports)
    } catch (error) {
      log('error', 'DLOPEN_HOOK_FAILED', error && error.code)
    }
    return result
  }
}

// ---- load the real client -------------------------------------------------

function launcherPath() {
  const configured = readJson(path.join(appDir, 'chatlab-image-bridge.json'))
  if (configured && typeof configured.main === 'string') return path.resolve(appDir, configured.main)
  if (process.env.CHATLAB_QQ_LAUNCHER) return path.resolve(appDir, process.env.CHATLAB_QQ_LAUNCHER)
  return path.join(appDir, 'application.asar', 'app_launcher', 'index.js')
}

try {
  installInterceptor()
} catch (error) {
  log('error', 'INTERCEPTOR_FAILED', error && error.code)
}

try {
  require(launcherPath())
} catch (error) {
  // Never hide the original launcher failure: report it and rethrow.
  log('error', 'LAUNCHER_FAILED', error && error.code)
  throw error
}
