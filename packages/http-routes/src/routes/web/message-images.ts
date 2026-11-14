import path from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getMessageImageReference } from '@openchatlab/core'
import {
  MESSAGE_IMAGE_ERROR_CODES,
  MessageImageCache,
  MessageImageError,
  MessageImagesService,
  type MessageImageErrorCode,
} from '@openchatlab/node-runtime/src/services/message-images'
import type { RuntimeRouteContext } from '../../context/runtime'
import type { AutomationRouteHostContext } from '../../context/automation'

type Context = {
  pathProvider: RuntimeRouteContext['pathProvider']
  sessionAdapter: Pick<RuntimeRouteContext['sessionAdapter'], 'ensureReadonly'>
} & AutomationRouteHostContext

const KNOWN_CODES = new Set<string>(MESSAGE_IMAGE_ERROR_CODES)
const JSON_TYPE = 'application/json; charset=utf-8'

/** The image endpoints share one page-safe error envelope with the rest of the API. */
function sendImageError(reply: FastifyReply, error: MessageImageError) {
  const code: MessageImageErrorCode =
    error.code && KNOWN_CODES.has(error.code) ? error.code : 'IMAGE_SOURCE_UNAVAILABLE'
  const status = error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 502
  if (status === 429 && error.retryAfterSeconds) reply.header('Retry-After', String(error.retryAfterSeconds))
  return reply
    .header('Cache-Control', 'no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .code(status)
    .type(JSON_TYPE)
    .send({
      success: false,
      error: {
        code,
        message: error.message,
        retryable: error.retryable,
        ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      },
    })
}

function imageSubscription(request: FastifyRequest, reply: FastifyReply) {
  const controller = new AbortController()
  const abort = () => {
    if (!reply.raw.writableEnded) controller.abort()
  }
  request.raw.once('aborted', abort)
  reply.raw.once('close', abort)
  return {
    signal: controller.signal,
    release: () => {
      request.raw.removeListener('aborted', abort)
      reply.raw.removeListener('close', abort)
    },
  }
}

function invalidRequest(message = 'Invalid image request') {
  return new MessageImageError(400, message, 'INVALID_IMAGE_REQUEST')
}

export function registerMessageImageRoutes(server: FastifyInstance, ctx: Context) {
  const service = new MessageImagesService({
    cache: new MessageImageCache(path.join(ctx.pathProvider.getCacheDir(), 'message-images')),
    loadSources: () => ctx.automation?.dsManager.loadAll() ?? [],
    resolveMessage: (sessionId, messageId) =>
      getMessageImageReference(ctx.sessionAdapter.ensureReadonly(sessionId), messageId),
  })
  type Params = { id: string; messageId: string; index?: string }
  const validId = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
  const validSession = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 512
  const validSize = (value: string): value is 'preview' | 'original' => value === 'preview' || value === 'original'

  server.get<{ Params: Params }>('/_web/sessions/:id/messages/:messageId/images', async (request, reply) => {
    const subscription = imageSubscription(request, reply)
    try {
      if (!validSession(request.params.id) || !validId(request.params.messageId))
        throw invalidRequest('Invalid image request')
      reply.header('Cache-Control', 'no-store')
      return await service.manifest(request.params.id, Number(request.params.messageId), subscription.signal)
    } catch (error) {
      if (error instanceof MessageImageError) return sendImageError(reply, error)
      throw error
    } finally {
      subscription.release()
    }
  })
  server.get<{ Params: Params; Querystring: { size?: string } }>(
    '/_web/sessions/:id/messages/:messageId/images/:index',
    async (request, reply) => {
      const subscription = imageSubscription(request, reply)
      try {
        const { id, messageId, index } = request.params
        const size = request.query.size ?? 'preview'
        if (
          !validSession(id) ||
          !validId(messageId) ||
          !index ||
          !validId(index) ||
          !Number.isSafeInteger(Number(index)) ||
          !validSize(size)
        ) {
          throw invalidRequest()
        }
        const image = await service.image(id, Number(messageId), Number(index), size, subscription.signal)
        return reply
          .header('Cache-Control', 'no-store')
          .header('X-Content-Type-Options', 'nosniff')
          .type(image.mime)
          .send(image.data)
      } catch (error) {
        if (error instanceof MessageImageError) return sendImageError(reply, error)
        throw error
      } finally {
        subscription.release()
      }
    }
  )
}
