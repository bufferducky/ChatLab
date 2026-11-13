import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { getMessageImageReference } from '@openchatlab/core'
import { MessageImageCache, MessageImagesService } from '@openchatlab/node-runtime/src/services/message-images'
import type { RuntimeRouteContext } from '../../context/runtime'
import type { AutomationRouteHostContext } from '../../context/automation'

type Context = {
  pathProvider: RuntimeRouteContext['pathProvider']
  sessionAdapter: Pick<RuntimeRouteContext['sessionAdapter'], 'ensureReadonly'>
} & AutomationRouteHostContext

export function registerMessageImageRoutes(server: FastifyInstance, ctx: Context) {
  const service = new MessageImagesService({
    cache: new MessageImageCache(path.join(ctx.pathProvider.getCacheDir(), 'message-images')),
    loadSources: () => ctx.automation?.dsManager.loadAll() ?? [],
    resolveMessage: (sessionId, messageId) =>
      getMessageImageReference(ctx.sessionAdapter.ensureReadonly(sessionId), messageId),
  })
  type Params = { id: string; messageId: string; index?: string }
  const validId = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value))

  server.get<{ Params: Params }>('/_web/sessions/:id/messages/:messageId/images', async (request, reply) => {
    if (!validId(request.params.messageId)) return reply.code(400).send({ error: 'Invalid message ID' })
    reply.header('Cache-Control', 'no-store')
    return service.manifest(request.params.id, Number(request.params.messageId))
  })
  server.get<{ Params: Params; Querystring: { size?: string } }>(
    '/_web/sessions/:id/messages/:messageId/images/:index',
    async (request, reply) => {
      const { id, messageId, index } = request.params
      const size = request.query.size ?? 'preview'
      if (!validId(messageId) || !index || !validId(index) || !['preview', 'original'].includes(size))
        return reply.code(400).send({ error: 'Invalid image request' })
      const image = await service.image(id, Number(messageId), Number(index), size as 'preview' | 'original')
      return reply
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .type(image.mime)
        .send(image.data)
    }
  )
}
