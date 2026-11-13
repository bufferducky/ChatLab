import { resolve } from 'node:path'
import test from 'node:test'
import verifyPackagedLocalRuntime from '../../../apps/desktop/scripts/verify-packaged-local-runtime.mjs'

// Explicit smoke test: build the macOS app first. Exercise the shipped SQLite
// and embedding dependencies with the shipped Electron, without user data.
test('packaged macOS runtime opens SQLite and loads local embedding dependencies', () => {
  verifyPackagedLocalRuntime({
    electronPlatformName: 'darwin',
    appOutDir: resolve('apps/desktop/dist/mac-arm64'),
    packager: { appInfo: { productFilename: 'ChatLab Personal' } },
  })
})
