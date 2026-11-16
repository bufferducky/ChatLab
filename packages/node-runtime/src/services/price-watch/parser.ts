/**
 * Price extraction for deal-hunting group chats.
 *
 * Real group messages are messy in ways verified against a live Telegram group:
 * 1. Homophone substitutes: 亓/圿/奍/劵 stand for 元/价/券.
 * 2. Unicode variant digits: 𝟐.𝟒, 𝟏𝟔.𝟗 — handled by NFKC normalization.
 * 3. Emoji as currency markers: 💰19, 16.9💰 are the most common form.
 * 4. Unit-price suffixes: 折1.9元/盒 must be dropped or every message looks cheap.
 * 5. Coupons and rebates: 17-送3虹包=14 — thresholds and refunds are not prices.
 * 6. Price tiers: 拍下154元 到手104元 — the final paid tier wins.
 */

export type PriceSource = 'action' | 'currency' | 'yuan' | 'emoji' | 'bracket'
export type PriceConfidence = 'mid' | 'low'
/** 1 = final paid price, 2 = listed/checkout price, 0 = unlabeled price */
export type PriceTier = 0 | 1 | 2

export interface PriceParseResult {
  finalPrice: number
  tier: PriceTier
  originalPrice: number | null
  source: PriceSource
  confidence: PriceConfidence
  /** Remaining candidates, so a notification can show the whole price chain */
  others: number[]
}

const URL_RE = /https?:\/\/\S+|www\.\S+|t\.me\/\S+/g

/** Ranges whose digits are never a product price: coupons, thresholds, refunds, gift counts. */
const MASK_PATTERNS: RegExp[] = [
  /\d+(?:\.\d+)?\s*[-－—~]\s*\d+(?:\.\d+)?\s*[券卷劵]/g,
  /[\d.]+\s*元?\s*[-－]\s*(?:送|饭|返|反)\s*\d+(?:\.\d+)?\s*元?\s*(?:🧧|虹包|红包|卡)?/g,
  /(?:领|取|叠|凑)\s*\d+(?:\.\d+)?\s*[-－]\s*\d+(?:\.\d+)?/g,
  /\d+(?:\.\d+)?\s*(?:首单|礼金|金币|猫卡|超市卡)/g,
  /(?:赠|送)\s*\d+(?:\.\d+)?\s*(?:个|件|包|瓶|罐|盒|卡|片|袋)?/g,
  /(?:反|返|饭)\s*\d+(?:\.\d+)?\s*元?/g,
]

const ACTION_RE = /(?:拍下|券后|到手|凑后|仅需|只需|低至|现价|实付|特价|史低)\s*[：:]?\s*(\d+(?:\.\d+)?)/g
const CURRENCY_RE = /[￥¥]\s*(\d+(?:\.\d+)?)/g
const YUAN_RE = /(\d+(?:\.\d+)?)\s*(?:元|块)/g
const EMOJI_RE = /(\d+(?:\.\d+)?)\s*[💰💵]|[💰💵]\s*(\d+(?:\.\d+)?)/gu
const BRACKET_RE = /[【[]\s*(\d+(?:\.\d+)?)\s*[】\]]/gu

const UNIT_PRICE_TAIL_RE = /^\s*元?\s*(?:\/|每)\s*\S{1,3}/
const SPEC_TAIL_RE =
  /^\s*(?:g|kg|mg|ml|L|l|寸|色|件|盒|袋|片|抽|包|瓶|支|粒|条|双|只|个|张|cm|mm|W|V|Hz|T|G|GB|MB|mAh|%|年|天|期|码|号)/

/** Words that cancel a price wherever they appear right before it (coupon and rebate semantics). */
const PRE_DROP = ['领', '满', '减', '送', '返', '饭', '省', '限', '叠', '赠', '反']
/**
 * Unit-price markers only count when glued to the number: "折1.9元/盒" is a split
 * price, while "组合 32.7💰" is just a word that happens to end with 合.
 */
const PRE_DROP_IMMEDIATE = ['折', '每', '即']
const ORIGINAL_KEYWORDS = ['原价', '标价', '京东价', '日常价', '吊牌', '商超']
const TIER1_KEYWORDS = ['到手', '实付', '券后', '凑后', '净价']
/**
 * Words that mark the price they sit next to. "好价" and "神价" are deliberately
 * absent: they describe the whole message ("伊利纯牛奶好价合集") and would promote
 * an unrelated earlier number to the checkout tier.
 */
const TIER2_KEYWORDS = ['拍下', '现价', '特价', '低至', '史低', 'bug']
const BRACKET_CONTEXT_KEYWORDS = ['凑', '到手', '拍', '券后', '需', '价']

const HOMOPHONE_MAP: Record<string, string> = { 亓: '元', 圿: '价', 奍: '券', 劵: '券' }

interface Candidate {
  value: number
  tier: PriceTier
  source: PriceSource
  confidence: PriceConfidence
  isOriginal: boolean
  /** Offset in the normalized text, used to judge bracket context */
  start: number
}

export function normalizePriceText(raw: string): string {
  return raw.normalize('NFKC').replace(/[亓圿奍劵]/g, (ch) => HOMOPHONE_MAP[ch] ?? ch)
}

function collectMaskedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const pattern of MASK_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0
      ranges.push([start, start + match[0].length])
    }
  }
  return ranges
}

function isMasked(position: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => start <= position && position < end)
}

function hasAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle))
}

/**
 * The nearest preceding keyword wins: "原价299元 券后199元" holds two numbers and
 * a window check would tag both of them as the original price.
 */
function classify(text: string, start: number): Pick<Candidate, 'tier' | 'isOriginal'> {
  const near = text.slice(Math.max(0, start - 10), start)
  let tier: PriceTier = 0
  let isOriginal = false
  let closest = Number.POSITIVE_INFINITY

  const consider = (keywords: string[], nextTier: PriceTier, nextOriginal: boolean) => {
    for (const keyword of keywords) {
      const index = near.lastIndexOf(keyword)
      if (index < 0) continue
      const distance = near.length - (index + keyword.length)
      if (distance >= closest) continue
      closest = distance
      tier = nextTier
      isOriginal = nextOriginal
    }
  }

  consider(ORIGINAL_KEYWORDS, 0, true)
  consider(TIER1_KEYWORDS, 1, false)
  consider(TIER2_KEYWORDS, 2, false)
  return { tier, isOriginal }
}

/** Normalize and blank out links. Replacement keeps length so offsets stay usable. */
function prepare(raw: string): string {
  const normalized = normalizePriceText(raw)
  return normalized.replace(URL_RE, (match) => ' '.repeat(match.length))
}

export function parsePrice(raw: string | null | undefined): PriceParseResult | null {
  if (!raw) return null
  const text = prepare(raw)
  const maskedRanges = collectMaskedRanges(text)
  const candidates: Candidate[] = []

  const push = (valueText: string, source: PriceSource, start: number, confidence: PriceConfidence) => {
    if (isMasked(start, maskedRanges)) return
    const value = Number.parseFloat(valueText)
    if (!Number.isFinite(value)) return
    const before = text.slice(Math.max(0, start - 3), start)
    const after = text.slice(start + valueText.length, start + valueText.length + 12)
    if (UNIT_PRICE_TAIL_RE.test(after) || SPEC_TAIL_RE.test(after)) return
    if (hasAny(before, PRE_DROP)) return
    if (PRE_DROP_IMMEDIATE.some((keyword) => before.endsWith(keyword))) return
    const { tier, isOriginal } = classify(text, start)
    candidates.push({ value, tier, source, confidence, isOriginal, start })
  }

  const scan = (pattern: RegExp, source: PriceSource, confidence: PriceConfidence) => {
    for (const match of text.matchAll(pattern)) {
      const valueText = match[1] ?? match[2]
      if (!valueText) continue
      const start = (match.index ?? 0) + match[0].indexOf(valueText)
      push(valueText, source, start, confidence)
    }
  }

  scan(ACTION_RE, 'action', 'mid')
  scan(CURRENCY_RE, 'currency', 'mid')
  scan(YUAN_RE, 'yuan', 'mid')
  scan(EMOJI_RE, 'emoji', 'low')
  scan(BRACKET_RE, 'bracket', 'mid')

  // Bracketed digits are option labels unless the surrounding text sells a deal
  for (const candidate of candidates.filter((c) => c.source === 'bracket')) {
    const context = text.slice(Math.max(0, candidate.start - 6), candidate.start)
    if (!hasAny(context, BRACKET_CONTEXT_KEYWORDS)) candidates.splice(candidates.indexOf(candidate), 1)
  }

  if (candidates.length === 0) return null

  // The final-paid tier is the real cost and wins alone. Otherwise every non-original
  // candidate competes, so a marketing word cannot sideline a higher, correct price.
  const finalTier = candidates.filter((c) => c.tier === 1 && !c.isOriginal)
  const priced = finalTier.length > 0 ? finalTier : candidates.filter((c) => !c.isOriginal)
  if (priced.length === 0) return null

  // Within one tier keep the highest: split prices like 1.9元/盒 must not win
  const chosen = priced.reduce((best, current) => (current.value > best.value ? current : best))
  const originals = candidates.filter((c) => c.isOriginal).map((c) => c.value)
  const others = candidates
    .filter((c) => c !== chosen)
    .map((c) => Math.round(c.value * 100) / 100)
    .filter((value, index, list) => list.indexOf(value) === index)
    .sort((a, b) => b - a)
    .slice(0, 5)

  return {
    finalPrice: chosen.value,
    tier: chosen.tier,
    originalPrice: originals.length > 0 ? Math.max(...originals) : null,
    source: chosen.source,
    confidence: chosen.confidence,
    others,
  }
}
