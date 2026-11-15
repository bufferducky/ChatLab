import assert from 'node:assert/strict'
import test from 'node:test'
import { FetchChatTopicsAdapter } from './fetch'

test('manual topic updates show the server reason instead of object Object', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'CLIENT_ERROR', message: 'A chat topic run is already running' },
        }),
        { status: 409 }
      )
  )
  await assert.rejects(new FetchChatTopicsAdapter().updateFeed('group'), {
    message: 'A chat topic run is already running',
  })
})
