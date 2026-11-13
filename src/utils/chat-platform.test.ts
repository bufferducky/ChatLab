import assert from 'node:assert/strict'
import test from 'node:test'
import { filterSessionsByPlatform, getChatPlatform, getPlatformFilters } from './chat-platform'

test('QQ, WeCom and personal WeChat retain distinct platform identities', () => {
  assert.equal(getChatPlatform('qq').key, 'qq')
  assert.equal(getChatPlatform('wecom').key, 'wecom')
  assert.equal(getChatPlatform('weixin').key, 'weixin')
  assert.equal(getChatPlatform('wechat').key, 'weixin')
  assert.equal(getChatPlatform('custom-export').key, 'unknown')
})

test('platform filtering separates same-name conversations and preserves sorted order and IDs', () => {
  const sessions = [
    { id: 'work-2', name: '技术交流群', platform: 'wecom' },
    { id: 'qq-1', name: '技术交流群', platform: 'qq' },
    { id: 'work-1', name: '技术交流群', platform: 'wecom' },
  ]
  assert.deepEqual(
    filterSessionsByPlatform(sessions, 'wecom').map((s) => s.id),
    ['work-2', 'work-1']
  )
  assert.deepEqual(
    filterSessionsByPlatform(sessions, 'qq').map((s) => s.id),
    ['qq-1']
  )
  assert.deepEqual(filterSessionsByPlatform(sessions, 'all'), sessions)
})

test('source counts honor existing search/type results and keep zero-count platforms selectable', () => {
  const sessions = [{ platform: 'wecom' }, { platform: 'qq' }, { platform: 'qq' }, { platform: 'telegram' }]
  assert.deepEqual(
    getPlatformFilters(sessions, [sessions[0]!]).map(({ key, count }) => ({ key, count })),
    [
      { key: 'qq', count: 0 },
      { key: 'wecom', count: 1 },
      { key: 'telegram', count: 0 },
    ]
  )
  assert.deepEqual(filterSessionsByPlatform(sessions, 'unknown'), [])
})
