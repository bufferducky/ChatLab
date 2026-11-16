import { createHash } from 'node:crypto'
import { normalizePriceText } from './parser'

/**
 * Product fingerprint: which past prices belong to the same item.
 *
 * This is deliberately a text-shape fingerprint, not semantic clustering. Two
 * adverts for the same product written differently get different fingerprints,
 * so the historical baseline only compares prices of the *same phrasing* — which
 * is what forwarded deals look like. A rule that only has an absolute price cap
 * keeps working while its baseline is still thin.
 */

const URL_RE = /https?:\/\/\S+|www\.\S+|t\.me\/\S+/g
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu
/** Marketing noise that says nothing about the product itself. */
const NOISE_WORDS = [
  '好价',
  '神价',
  '史低',
  'bug价',
  '捡漏',
  '手慢无',
  '速度',
  '快冲',
  '冲',
  '秒杀',
  '秒刹',
  '券后',
  '到手',
  '实付',
  '凑单',
  '凑后',
  '下单',
  '拍下',
  '加购',
  '加件',
  '领券',
  '领礼金',
  '礼金',
  '金币',
  '补贴',
  '优惠',
  '折扣',
  '包邮',
  '库存',
  '限量',
  '新品',
  '首发',
  '直播间',
  '下拉',
  '详情页',
  '标题',
  '会场',
  '收藏',
  '复制',
  '淘金币',
  '猫超',
  'plus',
  'vip',
]
const PRICE_FRAGMENT_RE = /\d+(?:\.\d+)?\s*(?:元|块)?|\d+(?:\.\d+)?/g
const MARKED_PRICE_RE =
  /(?:券后|到手|实付|凑后|原价|现价|拍下|[￥¥💰💵])\s*(?:💰|💵)?\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:元|块|💰|💵)/gu

function stripNoise(text: string): string {
  let result = text
  for (const word of NOISE_WORDS) {
    result = result.split(word).join(' ')
  }
  return result
}

export function buildFingerprint(raw: string): string {
  const normalized = normalizePriceText(raw).replace(URL_RE, ' ')
  // Prices change independently of model numbers and must not split the baseline.
  const cleaned = stripNoise(normalized.replace(MARKED_PRICE_RE, ' ')).replace(EMOJI_RE, ' ')

  // Model numbers carry the most identity: RTX4070, S23U, A4
  const modelTokens = (cleaned.match(/[a-z]*\d+[a-z0-9]*/gi) ?? []).map((token) => token.toLowerCase())
  // Chinese product names survive as 2-4 character runs after noise removal
  const chineseRuns = (cleaned.match(/[\u4e00-\u9fa5]{2,}/g) ?? []).map((run) => run.slice(0, 6))

  // A model number is the product's identity and survives re-phrasing, so it wins
  // outright. Two different categories sharing a model number (4070 GPU vs monitor)
  // collapse into one baseline; that only matters for cooldown suppression, and the
  // per-rule price cap still governs each push.
  if (modelTokens.length > 0) {
    return createHash('sha1')
      .update([...new Set(modelTokens)].sort().join('|'))
      .digest('hex')
      .slice(0, 16)
  }

  // No model number: fall back to the longest Chinese runs, which are the words
  // least likely to be marketing filler.
  const strongestRuns = [...new Set(chineseRuns)]
    .sort((a, b) => b.length - a.length)
    .slice(0, 3)
    .sort()
  if (strongestRuns.length === 0) {
    const shape = cleaned.replace(PRICE_FRAGMENT_RE, ' ').replace(/\s+/g, ' ').trim()
    return createHash('sha1').update(shape).digest('hex').slice(0, 16)
  }
  return createHash('sha1').update(strongestRuns.join('|')).digest('hex').slice(0, 16)
}
