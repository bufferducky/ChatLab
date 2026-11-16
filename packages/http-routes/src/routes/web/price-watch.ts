/**
 * Price watch routes (/_web/price-watch/*).
 *
 * Rules, notification channels, hit history, and a manual scan used to try a
 * rule against already-imported messages.
 */

import type { FastifyInstance } from 'fastify'
import { getSessionMeta } from '@openchatlab/core'
import {
  createPriceWatchService,
  openPriceWatchStore,
  type PriceChannel,
  type PriceChannelType,
  type PriceRule,
  type PriceWatchMessage,
  type PriceWatchService,
  type PriceWatchStore,
} from '@openchatlab/node-runtime'
import type { AutomationRouteHostContext } from '../../context/automation'
import type { RuntimeRouteContext } from '../../context/runtime'

type Context = Pick<RuntimeRouteContext, 'sessionAdapter' | 'pathProvider' | 'nativeBinding'> &
  AutomationRouteHostContext

const CHANNEL_TYPES: PriceChannelType[] = ['webhook', 'telegram']
const MAX_HITS_PAGE = 200

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 })
}

function readRuleInput(body: Record<string, unknown>, existing?: PriceRule): PriceRule {
  const name = typeof body.name === 'string' ? body.name.trim() : (existing?.name ?? '')
  if (!name) throw badRequest('Rule name is required')

  const sessionIds = Array.isArray(body.sessionIds)
    ? body.sessionIds.filter((id): id is string => typeof id === 'string')
    : (existing?.sessionIds ?? [])
  const keywords = Array.isArray(body.keywords)
    ? body.keywords.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : (existing?.keywords ?? [])
  if (keywords.length === 0) throw badRequest('At least one keyword is required')

  const excludeKeywords = Array.isArray(body.excludeKeywords)
    ? body.excludeKeywords.filter((item): item is string => typeof item === 'string')
    : (existing?.excludeKeywords ?? [])
  const channelIds = Array.isArray(body.channelIds)
    ? body.channelIds.filter((id): id is string => typeof id === 'string')
    : (existing?.channelIds ?? [])

  const readNumber = (value: unknown, fallback: number | null): number | null => {
    if (value === null) return null
    if (typeof value === 'number' && Number.isFinite(value)) return value
    return fallback
  }

  const now = Date.now()
  return {
    id: existing?.id ?? `rule_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    sessionIds,
    keywords,
    excludeKeywords,
    maxPrice: readNumber(body.maxPrice, existing?.maxPrice ?? null),
    historyPercentile: readNumber(body.historyPercentile, existing?.historyPercentile ?? null),
    minHistorySamples:
      typeof body.minHistorySamples === 'number' ? body.minHistorySamples : (existing?.minHistorySamples ?? 5),
    cooldownMinutes:
      typeof body.cooldownMinutes === 'number' ? body.cooldownMinutes : (existing?.cooldownMinutes ?? 720),
    channelIds,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : (existing?.enabled ?? true),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}

function readChannelInput(body: Record<string, unknown>, existing?: PriceChannel): PriceChannel {
  const type = body.type as PriceChannelType | undefined
  if (type && !CHANNEL_TYPES.includes(type)) throw badRequest('Unsupported channel type')
  const resolvedType = type ?? existing?.type
  if (!resolvedType) throw badRequest('Channel type is required')

  const url = typeof body.url === 'string' ? body.url.trim() : (existing?.url ?? '')
  if (!url) throw badRequest(resolvedType === 'telegram' ? 'Bot token is required' : 'Webhook URL is required')
  if (resolvedType === 'webhook' && !/^https?:\/\//.test(url)) throw badRequest('Webhook URL must start with http')

  const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : (existing?.chatId ?? '')
  if (resolvedType === 'telegram' && !chatId) throw badRequest('Telegram chat id is required')

  return {
    id: existing?.id ?? `ch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : (existing?.name ?? resolvedType),
    type: resolvedType,
    url,
    chatId,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : (existing?.enabled ?? true),
    createdAt: existing?.createdAt ?? Date.now(),
  }
}

export function registerPriceWatchRoutes(server: FastifyInstance, ctx: Context): void {
  let store: PriceWatchStore | undefined
  let service: PriceWatchService | undefined
  const inFlight = new Set<string>()

  const loadMessages = async (
    sessionId: string,
    afterId: number,
    limit: number,
    options?: { sinceTs?: number }
  ): Promise<PriceWatchMessage[]> => {
    const db = ctx.sessionAdapter.openReadonly(sessionId)
    if (!db) return []
    const rows = (
      options?.sinceTs === undefined
        ? db.prepare('SELECT id, ts, content FROM message WHERE id > ? ORDER BY id LIMIT ?').all(afterId, limit)
        : db
            .prepare('SELECT id, ts, content FROM message WHERE ts >= ? ORDER BY id LIMIT ?')
            .all(options.sinceTs, limit)
    ) as Array<{ id: number; ts: number; content: string | null }>
    return rows.map((row) => ({ id: row.id, ts: row.ts, content: row.content }))
  }

  /** Highest message id in a session: new rules watch forward from here. */
  const latestMessageId = (sessionId: string): number => {
    const db = ctx.sessionAdapter.openReadonly(sessionId)
    if (!db) return 0
    const row = db.prepare('SELECT MAX(id) AS latest FROM message').get() as { latest: number | null } | undefined
    return row?.latest ?? 0
  }

  /** A rule without a cursor would replay the whole history and push old deals. */
  const ensureCursors = (rule: PriceRule) => {
    for (const sessionId of rule.sessionIds) {
      const known = getStore()
        .getCursors(rule.id)
        .some((cursor) => cursor.sessionId === sessionId)
      if (!known) getStore().setCursor(rule.id, sessionId, latestMessageId(sessionId))
    }
  }

  const resolveSessionName = (sessionId: string): string => {
    const db = ctx.sessionAdapter.openReadonly(sessionId)
    if (!db) return sessionId
    return getSessionMeta(db)?.name ?? sessionId
  }

  const getStore = () => (store ??= openPriceWatchStore(ctx.pathProvider.getUserDataDir(), ctx.nativeBinding))

  const getService = () =>
    (service ??= createPriceWatchService({
      store: getStore(),
      loadMessages,
      resolveSessionName,
      logger: {
        info: (message) => server.log.info(message),
        warn: (message) => server.log.warn(message),
        error: (message, error) => server.log.error({ err: error }, message),
      },
    }))

  let unsubscribe: (() => void) | undefined

  server.addHook('onReady', async () => {
    const scan = (sessionId: string) => {
      if (inFlight.has(sessionId)) return
      inFlight.add(sessionId)
      getService()
        .scanSession(sessionId)
        .catch((error) => server.log.error({ err: error }, '[PriceWatch] Import-triggered scan failed'))
        .finally(() => inFlight.delete(sessionId))
    }

    // Catch up on anything imported while the app was closed, then follow imports.
    for (const rule of getStore().listRules()) {
      if (!rule.enabled) continue
      ensureCursors(rule)
      for (const sessionId of rule.sessionIds) scan(sessionId)
    }
    unsubscribe = ctx.automation?.pullEngine?.subscribeSessionImported?.((sessionId) => scan(sessionId))
  })

  server.addHook('onClose', async () => {
    unsubscribe?.()
    store?.close()
  })

  server.get('/_web/price-watch/rules', async () => ({ rules: getStore().listRules() }))

  server.post<{ Body: Record<string, unknown>; Querystring: { id?: string } }>(
    '/_web/price-watch/rules',
    async (request) => {
      const existing = request.query.id
        ? getStore()
            .listRules()
            .find((rule) => rule.id === request.query.id)
        : undefined
      if (request.query.id && !existing) throw Object.assign(new Error('Rule not found'), { statusCode: 404 })
      const rule = readRuleInput(request.body ?? {}, existing)
      getStore().saveRule(rule)
      ensureCursors(rule)
      return { rule }
    }
  )

  server.delete<{ Params: { id: string } }>('/_web/price-watch/rules/:id', async (request) => {
    getStore().deleteRule(request.params.id)
    return { success: true }
  })

  server.get('/_web/price-watch/channels', async () => ({ channels: getStore().listChannels() }))

  server.post<{ Body: Record<string, unknown>; Querystring: { id?: string } }>(
    '/_web/price-watch/channels',
    async (request) => {
      const existing = request.query.id
        ? getStore()
            .listChannels()
            .find((channel) => channel.id === request.query.id)
        : undefined
      if (request.query.id && !existing) throw Object.assign(new Error('Channel not found'), { statusCode: 404 })
      const channel = readChannelInput(request.body ?? {}, existing)
      getStore().saveChannel(channel)
      return { channel }
    }
  )

  server.delete<{ Params: { id: string } }>('/_web/price-watch/channels/:id', async (request) => {
    getStore().deleteChannel(request.params.id)
    return { success: true }
  })

  server.get<{ Querystring: { limit?: string } }>('/_web/price-watch/hits', async (request) => {
    const limit = Math.min(MAX_HITS_PAGE, Math.max(1, Number(request.query.limit) || 50))
    return { hits: getStore().listHits(limit) }
  })

  server.get('/_web/price-watch/sessions', async () => {
    const sessions = ctx.sessionAdapter.listSessionIds().map((sessionId) => ({
      id: sessionId,
      name: resolveSessionName(sessionId),
    }))
    return { sessions }
  })

  server.post<{ Params: { sessionId: string } }>('/_web/price-watch/scan/:sessionId', async (request) => {
    const { sessionId } = request.params
    if (inFlight.has(sessionId)) return { skipped: true }
    inFlight.add(sessionId)
    try {
      return await getService().scanSession(sessionId)
    } finally {
      inFlight.delete(sessionId)
    }
  })

  server.post<{ Params: { sessionId: string }; Body: { days?: number } }>(
    '/_web/price-watch/backfill/:sessionId',
    async (request) => {
      const days = Math.min(365, Math.max(1, Number(request.body?.days) || 30))
      return getService().backfillSession(request.params.sessionId, Math.floor(Date.now() / 1000) - days * 86400)
    }
  )

  server.post<{ Params: { id: string } }>('/_web/price-watch/hits/:id/resend', async (request) => {
    const hit = getStore()
      .listHits(MAX_HITS_PAGE)
      .find((item) => item.id === request.params.id)
    if (!hit) throw Object.assign(new Error('Hit not found'), { statusCode: 404 })
    const rule = getStore()
      .listRules()
      .find((item) => item.id === hit.ruleId)
    if (!rule) throw Object.assign(new Error('Rule not found'), { statusCode: 404 })
    const { deliverToChannel: deliver } = await import('@openchatlab/node-runtime')
    const message = JSON.parse(hit.payload)
    let delivered = 0
    for (const channel of getStore().listChannels()) {
      if (!rule.channelIds.includes(channel.id) || !channel.enabled) continue
      await deliver(channel, message)
      delivered += 1
    }
    getStore().updateHitStatus(hit.id, delivered > 0 ? 'sent' : 'failed')
    return { delivered }
  })
}
