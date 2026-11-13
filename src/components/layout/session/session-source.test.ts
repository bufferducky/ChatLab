import assert from 'node:assert/strict'
import test from 'node:test'
import type { DataSource } from '@/stores/apiServer'
import { getSessionSources } from './session-source'

function source(id: string, targetSessionId: string, enabled = true): DataSource {
  return {
    id,
    name: '同名数据源',
    baseUrl: 'http://127.0.0.1/api/v1',
    token: 'private-test-token',
    enabled,
    intervalMinutes: 180,
    pullLimit: 100,
    createdAt: 1,
    sessions: [
      {
        id: 'subscription',
        name: '技术交流群',
        remoteSessionId: 'same-remote-id',
        targetSessionId,
        lastPullAt: 123,
        lastStatus: 'success',
        lastError: '',
        lastNewMessages: 0,
      },
    ],
  }
}

test('source details match local session IDs across same-name sources and keep paused bindings', () => {
  const result = getSessionSources('local-qq', [
    source('qq-a', 'local-qq'),
    source('qq-b', 'other'),
    source('paused', 'local-qq', false),
  ])
  assert.deepEqual(
    result.map((s) => s.id),
    ['qq-a:subscription', 'paused:subscription']
  )
  assert.equal(result[1]!.enabled, false)
  assert.equal(result[1]!.status, 'success')
  assert.equal(result[0]!.progressAt, 123)
  assert.equal(Object.hasOwn(result[0]!, 'token'), false)
  assert.equal(Object.hasOwn(result[0]!, 'baseUrl'), false)
})

test('unlinked or missing local IDs do not inherit a source by name or platform', () => {
  assert.deepEqual(getSessionSources('unlinked', [source('qq', 'local-qq')]), [])
  assert.deepEqual(getSessionSources('', [source('qq', '')]), [])
})
