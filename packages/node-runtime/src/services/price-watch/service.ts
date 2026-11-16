import { randomUUID } from 'node:crypto'
import { buildFingerprint } from './fingerprint'
import { normalizePriceText, parsePrice } from './parser'
import { deliverToChannel, type PriceHitMessage } from './notifier'
import type { PriceChannel, PriceHit, PriceRule, PriceWatchStore } from './store'

/**
 * Match engine. Runs right after a session import finishes, so nothing here is
 * scheduled: one call covers one group's new messages.
 */

export interface PriceWatchMessage {
  id: number
  ts: number
  content: string | null
}

export interface PriceWatchDeps {
  store: PriceWatchStore
  /** Reads messages newer than afterId for one session, oldest first. */
  loadMessages: (
    sessionId: string,
    afterId: number,
    limit: number,
    options?: { sinceTs?: number }
  ) => Promise<PriceWatchMessage[]>
  resolveSessionName: (sessionId: string) => string
  /** Retry backoff for delivery; tests shrink it to keep runs fast. */
  attemptDelaysMs?: number[]
  logger?: {
    info: (message: string) => void
    warn: (message: string) => void
    error: (message: string, error?: unknown) => void
  }
}

export interface ScanResult {
  sessionId: string
  rulesConsidered: number
  messagesRead: number
  observations: number
  hits: number
  suppressed: number
  delivered: number
  failed: number
}

const MESSAGES_PER_BATCH = 500
/** Per-session ceiling for one scan; backlog beyond this waits for the next import. */
const MAX_MESSAGES_PER_SCAN = 5000
const MAX_OBSERVATION_HISTORY = 500
const MAX_HITS_PER_SCAN = 5
const DEFAULT_MIN_HISTORY_SAMPLES = 5

interface PendingHit {
  rule: PriceRule
  message: PriceWatchMessage
  fingerprint: string
  fragment: ReturnType<typeof parsePrice> & object
}

function percentile(sorted: number[], ratio: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))
  return sorted[index]
}

function matchesKeywords(rule: PriceRule, text: string): boolean {
  // Groups dodge filters with homophones (好圿 for 好价), so keywords match the
  // normalized text; a rule written the plain way still fires.
  const lowered = normalizePriceText(text).toLowerCase()
  const required = rule.keywords.filter((keyword) => keyword.trim().length > 0)
  if (required.length === 0) return false
  const hit = required.some((keyword) => lowered.includes(keyword.trim().toLowerCase()))
  if (!hit) return false
  const excluded = rule.excludeKeywords.filter((keyword) => keyword.trim().length > 0)
  return !excluded.some((keyword) => lowered.includes(keyword.trim().toLowerCase()))
}

export function createPriceWatchService(deps: PriceWatchDeps) {
  const { store } = deps

  function isHit(
    rule: PriceRule,
    price: number,
    history: number[]
  ): { hit: boolean; lowest: number | null; percentileValue: number | null; status: 'ok' | 'insufficient' } {
    if (rule.maxPrice !== null && price > rule.maxPrice) {
      return { hit: false, lowest: null, percentileValue: null, status: 'insufficient' }
    }
    if (rule.maxPrice === null && rule.historyPercentile === null) {
      return { hit: false, lowest: null, percentileValue: null, status: 'insufficient' }
    }

    const sorted = [...history].sort((a, b) => a - b)
    const lowest = sorted.length > 0 ? sorted[0] : null
    const threshold = rule.historyPercentile === null ? null : percentile(sorted, (rule.historyPercentile ?? 0) / 100)
    const minSamples = rule.minHistorySamples > 0 ? rule.minHistorySamples : DEFAULT_MIN_HISTORY_SAMPLES
    const sufficient = sorted.length >= minSamples

    // The percentile condition can only make a hit stricter, never more lenient:
    // with too few samples the absolute cap alone decides, and the push says so.
    if (threshold !== null && sufficient && price > threshold) {
      return { hit: false, lowest, percentileValue: threshold, status: 'ok' }
    }
    return {
      hit: true,
      lowest,
      percentileValue: sufficient ? threshold : null,
      status: sufficient ? 'ok' : 'insufficient',
    }
  }

  async function deliver(hit: PriceHit, rule: PriceRule, message: PriceHitMessage, channels: PriceChannel[]) {
    const targets = channels.filter((channel) => rule.channelIds.includes(channel.id) && channel.enabled)
    if (targets.length === 0) {
      store.updateHitStatus(hit.id, 'failed')
      deps.logger?.warn('[PriceWatch] Rule has no enabled channel: ' + rule.name)
      return { delivered: 0, failed: 1 }
    }
    let delivered = 0
    let failed = 0
    for (const channel of targets) {
      try {
        await deliverToChannel(channel, message, deps.attemptDelaysMs)
        delivered += 1
      } catch (error) {
        failed += 1
        deps.logger?.error('[PriceWatch] Delivery failed for channel ' + channel.name, error)
      }
    }
    store.updateHitStatus(hit.id, delivered > 0 ? 'sent' : 'failed')
    return { delivered, failed }
  }

  async function scanSession(sessionId: string): Promise<ScanResult> {
    const result: ScanResult = {
      sessionId,
      rulesConsidered: 0,
      messagesRead: 0,
      observations: 0,
      hits: 0,
      suppressed: 0,
      delivered: 0,
      failed: 0,
    }
    const rules = store.listRules().filter((rule) => rule.enabled && rule.sessionIds.includes(sessionId))
    result.rulesConsidered = rules.length
    if (rules.length === 0) return result

    const sessionName = deps.resolveSessionName(sessionId)
    const channels = store.listChannels()
    const pending: PendingHit[] = []

    for (const rule of rules) {
      const cursor = store.getCursors(rule.id).find((item) => item.sessionId === sessionId)
      const afterId = cursor?.lastMessageId ?? 0
      // Read every pending batch: the cursor advances past what was handled, so
      // stopping at one batch after a long absence would silently skip the rest.
      const messages: PriceWatchMessage[] = []
      let nextAfterId = afterId
      while (messages.length < MAX_MESSAGES_PER_SCAN) {
        const batch = await deps.loadMessages(sessionId, nextAfterId, MESSAGES_PER_BATCH)
        if (batch.length === 0) break
        messages.push(...batch)
        nextAfterId = batch[batch.length - 1].id
        if (batch.length < MESSAGES_PER_BATCH) break
      }
      if (messages.length === 0) continue
      result.messagesRead += messages.length

      const observations: Array<{
        ruleId: string
        fingerprint: string
        sessionId: string
        messageId: number
        price: number
        ts: number
      }> = []

      for (const message of messages) {
        const text = message.content ?? ''
        if (!matchesKeywords(rule, text)) continue
        const parsed = parsePrice(text)
        if (!parsed) continue
        const fingerprint = buildFingerprint(text)
        observations.push({
          ruleId: rule.id,
          fingerprint,
          sessionId,
          messageId: message.id,
          price: parsed.finalPrice,
          ts: message.ts,
        })

        const history = store.listObservationPrices(fingerprint, MAX_OBSERVATION_HISTORY).map((item) => item.price)
        const verdict = isHit(rule, parsed.finalPrice, history)
        if (!verdict.hit) continue

        pending.push({ rule, message, fingerprint, fragment: parsed })
      }

      if (observations.length > 0) {
        store.addObservations(observations)
        result.observations += observations.length
      }
      const highestId = messages.reduce((max, message) => Math.max(max, message.id), afterId)
      store.setCursor(rule.id, sessionId, highestId)
    }

    // One import can carry dozens of deals; push the strongest few and keep the rest visible in the UI
    pending.sort((a, b) => {
      const tierDelta = (b.fragment.tier === 1 ? 1 : 0) - (a.fragment.tier === 1 ? 1 : 0)
      return tierDelta !== 0 ? tierDelta : a.message.ts - b.message.ts
    })

    for (const item of pending) {
      const cooldownStart = Date.now() - item.rule.cooldownMinutes * 60_000
      if (store.hasRecentHit(item.rule.id, item.fingerprint, item.fragment.finalPrice, cooldownStart)) {
        result.suppressed += 1
        continue
      }
      const history = store.listObservationPrices(item.fingerprint, MAX_OBSERVATION_HISTORY).map((entry) => entry.price)
      const sorted = [...history].sort((a, b) => a - b)
      const verdict = isHit(item.rule, item.fragment.finalPrice, history)
      const hitId = randomUUID()
      const message: PriceHitMessage = {
        hitId,
        ruleName: item.rule.name,
        sessionName,
        finalPrice: item.fragment.finalPrice,
        originalPrice: item.fragment.originalPrice,
        tier: item.fragment.tier,
        sourceText: item.message.content ?? '',
        messageTs: item.message.ts,
        history: {
          lowest: sorted.length > 0 ? sorted[0] : null,
          percentile: verdict.percentileValue,
          samples: sorted.length,
          status: verdict.status,
        },
      }
      const suppressed = result.hits >= MAX_HITS_PER_SCAN
      const hit: PriceHit = {
        id: hitId,
        ruleId: item.rule.id,
        sessionId,
        messageId: item.message.id,
        fingerprint: item.fingerprint,
        finalPrice: item.fragment.finalPrice,
        originalPrice: item.fragment.originalPrice,
        payload: JSON.stringify({ ...message, suppressed }),
        status: suppressed ? 'suppressed' : 'pending',
        createdAt: Date.now(),
      }
      store.addHit(hit)
      result.hits += 1

      if (suppressed) {
        result.suppressed += 1
        continue
      }
      const outcome = await deliver(hit, item.rule, message, channels)
      result.delivered += outcome.delivered
      result.failed += outcome.failed
    }

    deps.logger?.info(
      `[PriceWatch] Scan ${sessionId}: ${result.rulesConsidered} rules, ${result.messagesRead} messages, ` +
        `${result.hits} hits (${result.delivered} delivered, ${result.failed} failed)`
    )
    return result
  }

  /**
   * Rebuilds historical baselines without notifying anyone.
   *
   * A new rule starts watching from the current message, so its percentile
   * condition has no samples. Backfill fills that gap from already-imported
   * messages; it never creates hits, so old deals are not pushed as if new.
   */
  async function backfillSession(
    sessionId: string,
    sinceTs: number
  ): Promise<{ messages: number; observations: number }> {
    const rules = store.listRules().filter((rule) => rule.enabled && rule.sessionIds.includes(sessionId))
    if (rules.length === 0) return { messages: 0, observations: 0 }

    const messages = await deps.loadMessages(sessionId, 0, 20000, { sinceTs })
    const observations: Array<{
      ruleId: string
      fingerprint: string
      sessionId: string
      messageId: number
      price: number
      ts: number
    }> = []

    for (const message of messages) {
      const text = message.content ?? ''
      for (const rule of rules) {
        if (!matchesKeywords(rule, text)) continue
        const parsed = parsePrice(text)
        if (!parsed) continue
        observations.push({
          ruleId: rule.id,
          fingerprint: buildFingerprint(text),
          sessionId,
          messageId: message.id,
          price: parsed.finalPrice,
          ts: message.ts,
        })
      }
    }

    if (observations.length > 0) store.addObservations(observations)
    deps.logger?.info(`[PriceWatch] Backfill ${sessionId}: ${observations.length} observations`)
    return { messages: messages.length, observations: observations.length }
  }

  return { scanSession, backfillSession }
}

export type PriceWatchService = ReturnType<typeof createPriceWatchService>
