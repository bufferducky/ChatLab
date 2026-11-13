<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import { useIntersectionObserver } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { fetchWithAuth, getBaseUrl } from '@/services/utils/http'

const props = withDefaults(defineProps<{ sessionId: string; messageId: number; showUnavailable?: boolean }>(), {
  showUnavailable: true,
})
const emit = defineEmits<{ caption: [value: string | null] }>()
const { t } = useI18n()
const target = ref<HTMLElement | null>(null)
const images = ref<Array<{ index: number; url: string; failed: boolean }>>([])
const state = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const modalOpen = ref(false)
const originalUrl = ref('')
const originalState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const selected = ref(0)
let controller = new AbortController()
let originalController: AbortController | null = null
let visible = false
const urls = new Set<string>()

function endpoint() {
  return `${getBaseUrl()}/sessions/${encodeURIComponent(props.sessionId)}/messages/${props.messageId}/images`
}

async function imageUrl(index: number, size: 'preview' | 'original', signal: AbortSignal) {
  const response = await fetchWithAuth(`${endpoint()}/${index}?size=${size}`, { signal })
  if (!response.ok) throw new Error('Image unavailable')
  const blob = await response.blob()
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const url = URL.createObjectURL(blob)
  urls.add(url)
  return url
}

async function load() {
  if (state.value === 'loading' || state.value === 'ready') return
  const signal = controller.signal
  state.value = 'loading'
  try {
    const response = await fetchWithAuth(endpoint(), { signal })
    if (!response.ok) throw new Error('Images unavailable')
    const manifest: { images: Array<{ index: number }>; caption: string } = await response.json()
    if (signal.aborted) return
    images.value = manifest.images.map(({ index }) => ({ index, url: '', failed: false }))
    emit('caption', images.value.length ? manifest.caption : null)
    state.value = 'ready'
    await Promise.all(
      images.value.map(async (image) => {
        try {
          image.url = await imageUrl(image.index, 'preview', signal)
        } catch {
          if (!signal.aborted) image.failed = true
        }
      })
    )
  } catch {
    if (!signal.aborted) state.value = 'error'
  }
}

async function openOriginal(index: number) {
  originalController?.abort()
  originalController = new AbortController()
  const signal = originalController.signal
  selected.value = index
  originalUrl.value = ''
  originalState.value = 'loading'
  modalOpen.value = true
  try {
    const url = await imageUrl(index, 'original', signal)
    if (!signal.aborted) {
      originalUrl.value = url
      originalState.value = 'ready'
    }
  } catch {
    if (!signal.aborted) originalState.value = 'error'
  }
}

function retry() {
  for (const image of images.value) {
    if (image.url) {
      URL.revokeObjectURL(image.url)
      urls.delete(image.url)
    }
  }
  state.value = 'idle'
  void load()
}

function clear() {
  controller.abort()
  originalController?.abort()
  controller = new AbortController()
  for (const url of urls) URL.revokeObjectURL(url)
  urls.clear()
  images.value = []
  modalOpen.value = false
  originalUrl.value = ''
  state.value = 'idle'
}

useIntersectionObserver(
  target,
  ([entry]) => {
    visible = entry.isIntersecting
    if (visible && state.value === 'idle') void load()
  },
  { rootMargin: '100px' }
)

watch(
  () => [props.sessionId, props.messageId],
  () => {
    clear()
    if (visible) void load()
  }
)
watch(modalOpen, (open) => {
  if (!open) {
    originalController?.abort()
    if (originalUrl.value) {
      URL.revokeObjectURL(originalUrl.value)
      urls.delete(originalUrl.value)
    }
    originalUrl.value = ''
  }
})
onBeforeUnmount(clear)
</script>

<template>
  <div ref="target" class="min-w-0">
    <div
      v-if="state === 'idle' || state === 'loading'"
      class="flex h-32 w-48 max-w-full items-center justify-center rounded-lg bg-gray-200/50 text-xs text-gray-500 dark:bg-gray-700/40 dark:text-gray-400"
      role="status"
    >
      {{ t('records.images.loading') }}
    </div>
    <div
      v-else-if="showUnavailable && (state === 'error' || (state === 'ready' && !images.length))"
      class="flex items-center gap-3 py-2 text-xs text-gray-500 dark:text-gray-400"
    >
      <span>{{ t('records.images.unavailable') }}</span>
      <button
        type="button"
        class="rounded text-primary-600 hover:underline focus-visible:outline-2 dark:text-primary-400"
        @click="retry"
      >
        {{ t('common.retry') }}
      </button>
    </div>
    <div v-else-if="images.length" class="flex max-w-full flex-wrap gap-2">
      <div v-for="image in images" :key="image.index" class="max-w-full">
        <button
          v-if="image.url"
          type="button"
          class="block max-w-full cursor-zoom-in overflow-hidden rounded-lg focus-visible:outline-2 focus-visible:outline-primary-500 hover:opacity-90 active:opacity-80"
          :aria-label="t('records.images.viewOriginal')"
          @click="openOriginal(image.index)"
        >
          <img :src="image.url" :alt="t('records.images.image')" class="max-h-64 max-w-full object-contain" />
        </button>
        <div
          v-else-if="image.failed"
          class="flex h-24 w-48 max-w-full flex-col items-center justify-center gap-2 rounded-lg bg-gray-200/40 text-xs text-gray-500 dark:bg-gray-700/40 dark:text-gray-400"
        >
          <span>{{ t('records.images.unavailable') }}</span>
          <button
            type="button"
            class="rounded text-primary-600 hover:underline focus-visible:outline-2 dark:text-primary-400"
            @click="retry"
          >
            {{ t('common.retry') }}
          </button>
        </div>
        <div
          v-else
          class="flex h-32 w-48 max-w-full items-center justify-center rounded-lg bg-gray-200/50 text-xs text-gray-500 dark:bg-gray-700/40 dark:text-gray-400"
          role="status"
        >
          {{ t('records.images.loading') }}
        </div>
      </div>
    </div>
    <UModal v-model:open="modalOpen" :title="t('records.images.image')" :ui="{ content: 'sm:max-w-4xl' }">
      <template #body>
        <img
          v-if="originalUrl || images[selected]?.url"
          :src="originalUrl || images[selected]?.url"
          :alt="t('records.images.image')"
          class="mx-auto max-h-[70vh] max-w-full object-contain"
        />
        <p v-if="originalState === 'loading'" class="mt-3 text-center text-xs text-gray-500" role="status">
          {{ t('records.images.loadingOriginal') }}
        </p>
        <div v-if="originalState === 'error'" class="mt-3 flex justify-center gap-3 text-xs text-gray-500">
          <span>{{ t('records.images.originalUnavailable') }}</span>
          <button
            type="button"
            class="rounded text-primary-600 hover:underline focus-visible:outline-2 dark:text-primary-400"
            @click="openOriginal(selected)"
          >
            {{ t('common.retry') }}
          </button>
        </div>
      </template>
    </UModal>
  </div>
</template>
