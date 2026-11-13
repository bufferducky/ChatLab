#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function getPackagedPaths(context) {
  const productFilename = context.packager.appInfo.productFilename
  if (context.electronPlatformName === 'darwin') {
    const appDir = join(context.appOutDir, `${productFilename}.app`, 'Contents')
    return {
      executable: join(appDir, 'MacOS', productFilename),
      resources: join(appDir, 'Resources'),
    }
  }

  const executableName = context.electronPlatformName === 'win32' ? `${productFilename}.exe` : productFilename
  return {
    executable: join(context.appOutDir, executableName),
    resources: join(context.appOutDir, 'resources'),
  }
}

export default function verifyPackagedLocalRuntime(context) {
  const { executable, resources } = getPackagedPaths(context)
  const asarPath = join(resources, 'app.asar')
  if (!existsSync(executable) || !existsSync(asarPath)) {
    throw new Error(`Packaged Electron runtime is incomplete: ${context.appOutDir}`)
  }

  const smokeScript = `
    const { createRequire } = require('node:module');
    const path = require('node:path');
    const requireFromApp = createRequire(path.join(process.env.CHATLAB_PACKAGED_RESOURCES, 'app.asar', 'package.json'));
    const nativeBinding = path.join(process.env.CHATLAB_PACKAGED_RESOURCES, 'native', 'better_sqlite3.node');
    const Database = requireFromApp('better-sqlite3');
    const db = new Database(':memory:', {
      nativeBinding: require('node:fs').existsSync(nativeBinding) ? nativeBinding : undefined,
    });
    try {
      if (db.prepare('SELECT 1 AS value').get().value !== 1) {
        throw new Error('Packaged SQLite query failed');
      }
    } finally {
      db.close();
    }
    const transformers = requireFromApp('@huggingface/transformers');
    if (typeof transformers.pipeline !== 'function') {
      throw new Error('Packaged @huggingface/transformers does not expose pipeline()');
    }
    requireFromApp('onnxruntime-common');
    requireFromApp('onnxruntime-node');
    requireFromApp('sharp');
  `
  const result = spawnSync(executable, ['-e', smokeScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CHATLAB_PACKAGED_RESOURCES: resources,
      ELECTRON_RUN_AS_NODE: '1',
    },
  })

  if (result.status !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join('\n').trim()
    throw new Error(`Packaged SQLite or local embedding runtime failed to load${details ? `:\n${details}` : ''}`)
  }

  console.log('[desktop build] Packaged SQLite query and local embedding runtime checks passed')
}
