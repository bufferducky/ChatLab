import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withImageRetry, type ImageFailure } from './retry'

test('rate-limited readers wait for the server deadline, and leaving prevents a retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const controller = new AbortController()
  let calls = 0
  let waiting: ImageFailure | null = null
  const result = withImageRetry(
    async () => {
      calls++
      if (calls === 1) throw { code: 'IMAGE_RATE_LIMITED', message: '', retryable: true, retryAfterSeconds: 37 }
      return 'image'
    },
    controller.signal,
    (value) => {
      waiting = value
    }
  )
  await Promise.resolve()
  assert.equal((waiting as ImageFailure | null)?.retryAt, 38_000)
  t.mock.timers.tick(36_999)
  await Promise.resolve()
  assert.equal(calls, 1)
  t.mock.timers.tick(1)
  assert.equal(await result, 'image')
  assert.equal(calls, 2)

  calls = 0
  const abandoned = withImageRetry(
    async () => {
      calls++
      throw { code: 'IMAGE_RATE_LIMITED', retryable: true, retryAfterSeconds: 60 }
    },
    controller.signal,
    () => {}
  )
  await Promise.resolve()
  const rejected = assert.rejects(abandoned, { name: 'AbortError' })
  controller.abort()
  t.mock.timers.tick(60_000)
  await rejected
  assert.equal(calls, 1)
})

test('temporary failures retry once while permanent failures never retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const retryable of [false, true]) {
    let calls = 0
    const result = withImageRetry(
      async () => {
        calls++
        throw { code: 'IMAGE_SOURCE_UNAVAILABLE', message: '', retryable }
      },
      new AbortController().signal,
      () => {}
    )
    const rejected = assert.rejects(result, { retryable })
    await Promise.resolve()
    t.mock.timers.tick(500)
    await rejected
    assert.equal(calls, retryable ? 2 : 1)
  }
})
