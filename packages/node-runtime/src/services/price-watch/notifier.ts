import type { PriceChannel } from './store'

/** Notification delivery: one HTTP POST, two channel shapes. */

export interface PriceHitMessage {
  hitId: string
  ruleName: string
  sessionName: string
  finalPrice: number
  originalPrice: number | null
  tier: 1 | 2 | 0
  sourceText: string
  messageTs: number
  history: {
    lowest: number | null
    percentile: number | null
    samples: number
    /** 'insufficient' means the rule only had its absolute cap to judge by */
    status: 'ok' | 'insufficient'
  }
}

const DELIVERY_TIMEOUT_MS = 10_000
export const DEFAULT_ATTEMPT_DELAYS_MS = [0, 1_000, 3_000]

function formatPrice(value: number): string {
  return String(Number(value.toFixed(2)))
}

export function renderTelegramText(message: PriceHitMessage): string {
  const lines = [`【${message.ruleName}】¥${formatPrice(message.finalPrice)}`]
  if (message.originalPrice !== null && message.originalPrice > message.finalPrice) {
    lines.push(`原价 ¥${formatPrice(message.originalPrice)}`)
  }
  if (message.history.status === 'ok' && message.history.lowest !== null) {
    const low = formatPrice(message.history.lowest)
    const position = message.finalPrice <= message.history.lowest ? '历史新低' : `历史最低 ¥${low}`
    lines.push(`${position}（${message.history.samples} 条历史记录）`)
  } else {
    lines.push('历史样本不足，按设定的价格上限触发')
  }
  lines.push('', `来自群：${message.sessionName}`)
  lines.push(`${new Date(message.messageTs * 1000).toLocaleString('zh-CN')}`)
  lines.push('', message.sourceText.slice(0, 300))
  return lines.join('\n')
}

function buildBody(channel: PriceChannel, message: PriceHitMessage): { body: string; url: string } {
  if (channel.type === 'telegram') {
    return {
      url: `https://api.telegram.org/bot${channel.url}/sendMessage`,
      body: JSON.stringify({
        chat_id: channel.chatId,
        text: renderTelegramText(message),
        disable_web_page_preview: true,
      }),
    }
  }
  return {
    url: channel.url,
    body: JSON.stringify({
      event: 'price_hit',
      rule: { name: message.ruleName },
      session: { name: message.sessionName },
      price: {
        final: message.finalPrice,
        original: message.originalPrice,
        tier: message.tier,
      },
      history: message.history,
      message: { text: message.sourceText, ts: message.messageTs },
      hitId: message.hitId,
    }),
  }
}

async function postOnce(channel: PriceChannel, message: PriceHitMessage): Promise<void> {
  const { url, body } = buildBody(channel, message)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`notification endpoint returned ${response.status}`)
  }
}

export async function deliverToChannel(
  channel: PriceChannel,
  message: PriceHitMessage,
  attemptDelaysMs: number[] = DEFAULT_ATTEMPT_DELAYS_MS
): Promise<void> {
  let lastError: unknown
  for (const delay of attemptDelaysMs) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    try {
      await postOnce(channel, message)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('notification delivery failed')
}
