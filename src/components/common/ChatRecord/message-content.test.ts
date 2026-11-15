import assert from 'node:assert/strict'
import test from 'node:test'
import { localizeTelegramServiceMessage, renderMessageContent } from './message-content'

test('imported Telegram service events show readable localized notifications, including unknown actions', () => {
  const translate = (key: string) =>
    ({
      'records.telegramService.membersAdded': '成员加入了群聊',
      'records.telegramService.other': 'Telegram 系统通知',
    })[key] ?? key
  assert.equal(localizeTelegramServiceMessage('[MessageActionChatAddUser]', translate), '成员加入了群聊')
  assert.equal(localizeTelegramServiceMessage('[MessageActionSomethingNew]', translate), 'Telegram 系统通知')
  assert.equal(localizeTelegramServiceMessage('ordinary text', translate), 'ordinary text')
})

test('Telegram title links retain their destinations, Unicode positions and keyword highlights', () => {
  const original = '[video] 😀 看原文 @three001'
  const html = renderMessageContent(
    '😀 看原文 @three001',
    ['原文'],
    {
      content: original,
      links: [
        { offset: 11, length: 3, url: 'https://example.com/article?a=1&b=2' },
        { offset: 15, length: 9, url: 'https://t.me/three001' },
      ],
    },
    original
  )
  assert.match(html, /href="https:\/\/example.com\/article\?a=1&amp;b=2"/)
  assert.match(html, /看<mark[^>]+>原文<\/mark><\/a>/)
  assert.match(html, /href="https:\/\/t.me\/three001"[^>]*>@three001<\/a>/)
  assert.equal((html.match(/<a /g) ?? []).length, 2)
})

test('plain URLs are clickable while message HTML, link labels and search terms stay escaped', () => {
  const content = '<img src=x onerror=alert(1)> https://example.com?a=1&b=2'
  const html = renderMessageContent(content, ['<img', 'a=1'])
  assert.ok(!html.includes('<img'))
  assert.match(html, /<mark[^>]+>&lt;img<\/mark>/)
  assert.match(html, /href="https:\/\/example.com\/\?a=1&amp;b=2"/)
  assert.ok(!html.includes('href="https://example.com/?<mark'))
  const unsafe = renderMessageContent('click', [], {
    content: 'click',
    links: [{ offset: 0, length: 5, url: 'javascript:alert(1)' }],
  })
  assert.equal(unsafe, 'click')
})

test('changed source text does not attach stale links to unrelated archived text', () => {
  assert.equal(
    renderMessageContent('old title', [], {
      content: 'new title',
      links: [{ offset: 0, length: 3, url: 'https://example.com' }],
    }),
    'old title'
  )
})
