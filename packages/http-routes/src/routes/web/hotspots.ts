import type { FastifyInstance } from 'fastify'
import { createHotspotService, createChatTopicModelClient, type HotspotService } from '@openchatlab/node-runtime'
import type { HotspotConfig, HotspotWindow } from '@openchatlab/shared-types'
import type { RuntimeRouteContext } from '../../context/runtime'
import type { AiRouteContext } from '../../context/ai'

type Context = Pick<RuntimeRouteContext, 'sessionAdapter' | 'pathProvider' | 'nativeBinding'> &
  Pick<AiRouteContext, 'llmConfigStore'>

export function registerHotspotRoutes(server: FastifyInstance, ctx: Context): void {
  let service: HotspotService | undefined
  const getService = () =>
    (service ??= createHotspotService({
      runtime: ctx.sessionAdapter,
      dataDir: ctx.pathProvider.getUserDataDir(),
      nativeBinding: ctx.nativeBinding,
      getModelClient: () => {
        const config = ctx.llmConfigStore?.getFastModelConfig()
        return config ? createChatTopicModelClient(config) : null
      },
    }))
  let timer: ReturnType<typeof setInterval> | undefined
  server.addHook('onReady', async () => {
    getService().tick()
    timer = setInterval(() => getService().tick(), 60000)
    timer.unref()
  })
  server.addHook('onClose', async () => {
    clearInterval(timer)
    await service?.close()
  })
  server.get<{ Querystring: { window?: HotspotWindow; saved?: string } }>('/_web/hotspots', async (request) =>
    getService().feed(request.query.window, request.query.saved === 'true')
  )
  server.put<{ Body: HotspotConfig }>('/_web/hotspots/config', async (request) => getService().configure(request.body))
  server.post<{ Body: { window: HotspotWindow } }>('/_web/hotspots/digest', async (request) => {
    if (!request.body || !['day', 'week', 'month'].includes(request.body.window))
      throw Object.assign(new Error('Invalid hotspot window'), { statusCode: 400 })
    return getService().summarize(request.body.window)
  })
  server.post<{ Body: { query: string } }>('/_web/hotspots/search', async (request) =>
    getService().search(request.body?.query)
  )
  server.get('/_web/hotspots/recommendations', async () => getService().recommendations())
  server.post<{ Body: { amount: number } }>('/_web/hotspots/usage/reconcile', async (request) => {
    getService().reconcileUsage(request.body?.amount)
    return { success: true }
  })
  server.get<{ Params: { id: string } }>('/_web/hotspots/:id/knowledge', async (request) =>
    getService().knowledgeDraft(request.params.id)
  )
  server.post<{ Params: { id: string }; Body: { content: string } }>('/_web/hotspots/:id/knowledge', async (request) =>
    getService().exportKnowledge(request.params.id, request.body?.content)
  )
  server.post<{ Body: { lookbackDays?: 1 | 7 | 30; rebuild?: boolean } }>(
    '/_web/hotspots/update',
    async (request, reply) => {
      if (request.body?.rebuild !== undefined && typeof request.body.rebuild !== 'boolean')
        throw Object.assign(new Error('Invalid hotspot rebuild action'), { statusCode: 400 })
      return reply.code(202).send(getService().start(request.body?.lookbackDays, request.body?.rebuild))
    }
  )
  server.post<{ Params: { id: string }; Body: { topic?: boolean; sessionId?: string; reduced: boolean } }>(
    '/_web/hotspots/:id/feedback',
    async (request) => {
      const value = request.body
      if (
        !value ||
        typeof value.reduced !== 'boolean' ||
        !(
          (value.topic === true && value.sessionId === undefined) ||
          (value.topic === undefined && typeof value.sessionId === 'string' && value.sessionId.length > 0)
        ) ||
        Object.keys(value).some((key) => !['topic', 'sessionId', 'reduced'].includes(key))
      ) {
        throw Object.assign(new Error('Invalid hotspot feedback'), { statusCode: 400 })
      }
      return getService().feedback(request.params.id, value)
    }
  )
  server.patch<{ Params: { id: string }; Body: { read?: boolean; saved?: boolean; dismissed?: boolean } }>(
    '/_web/hotspots/:id',
    async (request) => {
      const value = request.body
      if (
        !value ||
        !Object.keys(value).length ||
        Object.entries(value).some(
          ([key, item]) => !['read', 'saved', 'dismissed'].includes(key) || typeof item !== 'boolean'
        )
      ) {
        throw Object.assign(new Error('Invalid hotspot action'), { statusCode: 400 })
      }
      return getService().mark(request.params.id, value)
    }
  )
}
