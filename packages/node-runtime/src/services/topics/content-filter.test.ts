import assert from 'node:assert/strict'
import test from 'node:test'
import {
  filterTopicBlock,
  hasTopicContentRisk,
  isContentInspectionError,
  getContentReviewDiagnostic,
} from './content-filter'

test('input filtering removes political, illicit and adult messages while preserving ordinary technical discussions', () => {
  for (const text of [
    '习近平相关消息',
    '習近平相關消息',
    '政府公告',
    '习近平\u200b相关消息',
    '习 近 平相关消息',
    '跑分洗钱招人',
    '出售银行卡',
    '远控业务',
    '提供色情服务',
    '成人视频',
    'Porn content',
    'Political discussion',
  ])
    assert.equal(hasTopicContentRisk(text), true, text)
  for (const text of [
    '支付接口超时',
    '银行卡绑定失败',
    '登录回调失败，请检查配置',
    'AI 模型返回 400',
    'ChatLab release notes',
  ]) {
    assert.equal(hasTopicContentRisk(text), false, text)
  }
  assert.equal(hasTopicContentRisk('垃圾东西，滚蛋'), false)
  assert.equal(hasTopicContentRisk('垃圾东西，滚蛋', true), true)
  const messages = [{ id: 1, senderName: '色情广告', timestamp: 1, type: 0, content: 'Login fixed' }]
  const filtered = filterTopicBlock({ index: 0, estimatedChars: 10, messages })
  assert.equal(filtered.messages[0]!.senderName, 'Member')
  assert.equal(messages[0]!.senderName, '色情广告')
})

test('content review detection accepts gateway and provider errors without treating timeouts as moderation', () => {
  for (const error of [
    new Error('data_inspection_failed: Input text data may contain inappropriate content.'),
    new Error('<400> InternalError.Algo.DataInspectionFailed: Input text data may contain inappropriate content.'),
    { code: 'DataInspectionFailed' },
  ])
    assert.equal(isContentInspectionError(error), true)
  assert.equal(isContentInspectionError(new Error('Request timed out')), false)
  assert.equal(isContentInspectionError(new Error('model_not_found')), false)
})

test('review diagnostics retain provider identifiers without persisting echoed content', () => {
  const error = new Error(
    JSON.stringify({
      error: {
        code: 'InternalError.Algo.DataInspectionFailed',
        message: 'Input text data may contain inappropriate content: private chat text',
        request_id: 'request-456',
      },
    })
  )
  assert.deepEqual(getContentReviewDiagnostic(error), {
    reason: 'input_review',
    providerCode: 'InternalError.Algo.DataInspectionFailed',
    requestId: 'request-456',
  })
  assert.equal(getContentReviewDiagnostic(new Error('upstream stream failed after response started')), null)
  assert.equal(getContentReviewDiagnostic({ code: 'DataInspectionFailed' })?.reason, 'content_review')
})
