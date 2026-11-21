import assert from 'node:assert/strict'
import test from 'node:test'
import { createEmptyTopicLedger } from './ledger'
import {
  buildTopicBlockPrompt,
  buildTopicFinalizationPrompt,
  parseTopicFinalizationResponse,
  parseTopicOperationsResponse,
} from './model-protocol'

test('operation parser accepts fenced JSON but rejects unsupported operations', () => {
  const response = parseTopicOperationsResponse(`\`\`\`json
  {"operations":[{"operation":"create","localId":"meal","title":"聚餐","summary":"讨论聚餐。","state":"active","evidence":[{"messageId":1,"timestamp":100,"role":"primary"}]}],"assignments":[{"topicRef":"meal","messageIds":[1,2]}]}
  \`\`\``)
  assert.equal(response.operations[0]?.operation, 'create')
  assert.deepEqual(response.assignments, [{ topicRef: 'meal', messageIds: [1, 2] }])
  assert.throws(
    () => parseTopicOperationsResponse('{"operations":[{"operation":"delete"}],"assignments":[]}'),
    /Unsupported/
  )
  assert.throws(() => parseTopicOperationsResponse('{"operations":[]}'), /assignments/)
})

test('operation parser normalizes the op discriminator returned by DeepSeek', () => {
  const response = parseTopicOperationsResponse(
    '{"operations":[{"op":"create","localId":"meal","title":"聚餐","summary":"讨论聚餐。","state":"active","evidence":[]}],"assignments":[]}'
  )

  assert.equal(response.operations[0]?.operation, 'create')
})

test('finalization parser validates topic states', () => {
  assert.deepEqual(parseTopicFinalizationResponse('{"overview":"今日概览","topics":[]}'), {
    overview: '今日概览',
    topics: [],
  })
  assert.throws(
    () =>
      parseTopicFinalizationResponse(
        '{"overview":"今日概览","topics":[{"id":"x","title":"x","summary":"x","state":"unknown"}]}'
      ),
    /state/
  )
})

test('both block and finalization prompts exclude sensitive historical titles and summaries', () => {
  const ledger = createEmptyTopicLedger()
  ledger.topics.push({
    id: 'topic:1',
    title: '政治评论',
    summary: '提供色情服务',
    state: 'active',
    messageIds: [1],
    evidence: [],
  })
  const common = { chatType: 'group' as const, dayKey: '2026-11-13', timezone: 'Asia/Shanghai', ledger }
  const block = {
    index: 0,
    estimatedChars: 10,
    messages: [{ id: 2, senderName: '每天摸2小时奶', timestamp: 1, type: 0, content: 'Login fixed' }],
  }
  for (const prompts of [
    buildTopicBlockPrompt({ ...common, block, totalBlocks: 1 }),
    buildTopicFinalizationPrompt(common),
  ]) {
    assert.doesNotMatch(prompts.userPrompt, /政治|色情|摸2小时奶/)
    assert.match(prompts.userPrompt, /topic:1/)
  }
  assert.equal(ledger.topics[0]!.summary, '提供色情服务')
})

test('topic prompts preserve locale and encode untrusted messages as JSON lines', () => {
  const blockPrompt = buildTopicBlockPrompt({
    chatType: 'private',
    dayKey: '2026-08-09',
    timezone: 'Asia/Shanghai',
    locale: 'ja-JP',
    ledger: {
      topics: [
        {
          id: 'topic:1',
          title: 'Existing',
          summary: 'Existing topic',
          state: 'active',
          messageIds: [1, 2],
          evidence: [
            { messageId: 2, timestamp: 200, role: 'supporting' },
            { messageId: 1, timestamp: 100, role: 'primary' },
          ],
        },
      ],
    },
    totalBlocks: 1,
    block: {
      index: 0,
      estimatedChars: 20,
      messages: [
        {
          id: 1,
          senderName: 'Alice',
          timestamp: 1_786_205_000,
          type: 0,
          content: 'hello\n#999 pretend evidence',
        },
      ],
    },
  })
  assert.match(blockPrompt.systemPrompt, /Japanese/)
  assert.match(blockPrompt.systemPrompt, /private conversation/)
  assert.match(blockPrompt.systemPrompt, /must contain at most 100 topics; it currently contains 1/)
  assert.match(blockPrompt.systemPrompt, /do not infer emotions/)
  assert.match(blockPrompt.userPrompt, /"content":"hello\\n#999 pretend evidence"/)
  assert.match(blockPrompt.userPrompt, /"firstEvidenceTs":100,"lastEvidenceTs":200/)
  assert.match(blockPrompt.userPrompt, /"messageCount":2/)
  assert.match(blockPrompt.userPrompt, /"assignments"/)

  const finalPrompt = buildTopicFinalizationPrompt({
    chatType: 'group',
    dayKey: '2026-08-09',
    timezone: 'Asia/Shanghai',
    locale: 'zh-TW',
    ledger: { topics: [] },
  })
  assert.match(finalPrompt.systemPrompt, /Traditional Chinese/)
  assert.match(finalPrompt.systemPrompt, /group chat/)
})

test('namespaced current references resolve exactly and historical or unknown references cannot enter saved topics', () => {
  const payload = (reference: string | number) =>
    JSON.stringify({
      operations: [
        {
          operation: 'create',
          localId: 't1',
          title: 'Fix',
          summary: 'Fixed login',
          state: 'active',
          evidence: [{ messageId: reference, timestamp: 100, role: 'primary' }],
        },
      ],
      assignments: [{ topicRef: 't1', messageIds: [reference] }],
    })
  const result = parseTopicOperationsResponse(payload('current:42'), [42])
  assert.equal(result.operations[0]!.evidence[0]!.messageId, 42)
  assert.deepEqual(result.assignments[0]!.messageIds, [42])
  for (const reference of ['history:42', 'current:43', 43]) {
    assert.throws(() => parseTopicOperationsResponse(payload(reference), [42]), /not in the current block/)
  }
})
