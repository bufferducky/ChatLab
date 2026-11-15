<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useIntersectionObserver } from '@vueuse/core'
import type { MessageLinks } from '@openchatlab/shared-types'
import { fetchWithAuth, getBaseUrl } from '@/services/utils/http'
import { withImageRetry } from '@/services/message-images/retry'
import { renderMessageContent } from './message-content'

const props = defineProps<{
  content: string
  originalContent: string
  keywords?: string[]
  sessionId: string | null
  messageId: number
  loadLinks: boolean
}>()
const target = ref<HTMLElement | null>(null)
const metadata = ref<MessageLinks | null>(null)
const html = computed(() => renderMessageContent(props.content, props.keywords, metadata.value, props.originalContent))
let controller = new AbortController()
let loading = false
let visible = false

async function load() {
  if (!props.loadLinks || !props.sessionId || loading || metadata.value) return
  const signal = controller.signal
  loading = true
  try {
    const result = await withImageRetry(
      async () => {
        const response = await fetchWithAuth(
          `${getBaseUrl()}/sessions/${encodeURIComponent(props.sessionId!)}/messages/${props.messageId}/links`,
          { signal }
        )
        if (!response.ok) {
          const body = await response.json().catch(() => null)
          throw {
            code: body?.error?.code,
            retryable: response.status >= 500 || response.status === 429,
            retryAfterSeconds: body?.error?.retryAfterSeconds,
          }
        }
        return (await response.json()) as MessageLinks
      },
      signal,
      () => {}
    )
    if (!signal.aborted) metadata.value = result
  } catch {
    // Keep readable text and ordinary URL links when the collector cannot resolve entities.
  } finally {
    if (signal === controller.signal) loading = false
  }
}
useIntersectionObserver(target, ([entry]) => {
  visible = !!entry?.isIntersecting
  if (visible) void load()
})
watch(
  () => [props.sessionId, props.messageId, props.loadLinks],
  () => {
    controller.abort()
    controller = new AbortController()
    metadata.value = null
    loading = false
    if (visible) void load()
  }
)
onBeforeUnmount(() => controller.abort())
</script>

<template>
  <p ref="target" v-html="html" />
</template>
