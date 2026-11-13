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
  server.post<{ Body: { lookbackDays?: 1 | 7 | 30 } }>('/_web/hotspots/update', async (request, reply) =>
    reply.code(202).send(getService().start(request.body?.lookbackDays))
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
