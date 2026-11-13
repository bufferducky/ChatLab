<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import { useIntersectionObserver } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { fetchWithAuth, getBaseUrl } from '@/services/utils/http'

const props = withDefaults(defineProps<{ sessionId: string; messageId: number; showUnavailable?: boolean }>(), {
  showUnavailable: true,
})
const emit = defineEmits<{ caption: [value: string | null] }>()
const { t, te } = useI18n()
const target = ref<HTMLElement | null>(null)
const images = ref<Array<{ index: number; url: string; failure: ImageFailure | null }>>([])
const state = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const failure = ref<ImageFailure | null>(null)
const modalOpen = ref(false)
const originalUrl = ref('')
const originalState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const originalFailure = ref<ImageFailure | null>(null)
const selected = ref(0)
let controller = new AbortController()
let originalController: AbortController | null = null
let visible = false
const urls = new Set<string>()

/** Business codes the image endpoints may return; unknown codes use the generic fallback. */
const KNOWN_CODES = new Set([
  'INVALID_IMAGE_REQUEST',
  'UNAUTHORIZED',
  'MESSAGE_NOT_FOUND',
  'IMAGE_NOT_FOUND',
  'QQ_IMAGE_UNAVAILABLE',
  'QQ_ACCOUNT_MISMATCH',
  'QQ_DATA_SOURCE_MISMATCH',
  'IMAGE_REFERENCE_MISMATCH',
  'IMAGE_TOO_LARGE',
  'UNSUPPORTED_IMAGE',
  'QQ_IMAGE_BUSY',
  'QQ_DOWNLOAD_FAILED',
  'IMAGE_INTEGRITY_FAILED',
  'QQ_BRIDGE_UNAVAILABLE',
  'QQ_OFFLINE',
  'QQ_BRIDGE_INCOMPATIBLE',
  'QQ_DOWNLOAD_TIMEOUT',
  'IMAGE_SOURCE_UNAVAILABLE',
])

interface ImageFailure {
  code: string
  message: string
  retryable: boolean
}

function fallbackFailure(): ImageFailure {
  return { code: 'IMAGE_SOURCE_UNAVAILABLE', message: '', retryable: true }
}

/** Read the controlled business error without exposing transport details. */
async function readFailure(response: Response): Promise<ImageFailure> {
  try {
    const payload = await response.json()
    const error = payload?.error
    if (error && typeof error.code === 'string') {
      return {
        code: KNOWN_CODES.has(error.code) ? error.code : 'IMAGE_SOURCE_UNAVAILABLE',
        message: typeof error.message === 'string' ? error.message : '',
        retryable: error.retryable !== false,
      }
    }
  } catch {
    // Non-JSON errors fall back to the generic, retryable state.
  }
  return fallbackFailure()
}

function failureText(value: ImageFailure | null) {
  const code = value?.code ?? 'IMAGE_SOURCE_UNAVAILABLE'
  const key = `records.images.errors.${code}`
  return te(key) ? t(key) : t('records.images.errors.IMAGE_SOURCE_UNAVAILABLE')
}

function endpoint() {
  return `${getBaseUrl()}/sessions/${encodeURIComponent(props.sessionId)}/messages/${props.messageId}/images`
}

async function imageUrl(index: number, size: 'preview' | 'original', signal: AbortSignal) {
  const response = await fetchWithAuth(`${endpoint()}/${index}?size=${size}`, { signal })
  if (!response.ok) throw await readFailure(response)
  const blob = await response.blob()
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const url = URL.createObjectURL(blob)
  urls.add(url)
  return url
}

function asFailure(error: unknown): ImageFailure {
  return error && typeof error === 'object' && 'code' in error && 'retryable' in error
    ? (error as ImageFailure)
    : fallbackFailure()
}

async function load() {
  if (state.value === 'loading' || state.value === 'ready') return
  const signal = controller.signal
  state.value = 'loading'
  failure.value = null
  try {
    const response = await fetchWithAuth(endpoint(), { signal })
    if (!response.ok) throw await readFailure(response)
    const manifest: { images: Array<{ index: number }>; caption: string } = await response.json()
    if (signal.aborted) return
    images.value = manifest.images.map(({ index }) => ({ index, url: '', failure: null }))
    emit('caption', images.value.length ? manifest.caption : null)
    state.value = 'ready'
    await Promise.all(
      images.value.map(async (image) => {
        try {
          image.url = await imageUrl(image.index, 'preview', signal)
        } catch (error) {
          if (!signal.aborted) image.failure = asFailure(error)
        }
      })
    )
  } catch (error) {
    if (!signal.aborted) {
      failure.value = asFailure(error)
      state.value = 'error'
    }
  }
}

async function openOriginal(index: number) {
  originalController?.abort()
  originalController = new AbortController()
  const signal = originalController.signal
  selected.value = index
  originalUrl.value = ''
  originalFailure.value = null
  originalState.value = 'loading'
  modalOpen.value = true
  try {
    const url = await imageUrl(index, 'original', signal)
    if (!signal.aborted) {
      originalUrl.value = url
      originalState.value = 'ready'
    }
  } catch (error) {
    if (!signal.aborted) {
      originalFailure.value = asFailure(error)
      originalState.value = 'error'
    }
  }
}

function releaseImages() {
  for (const image of images.value) {
    if (image.url) {
      URL.revokeObjectURL(image.url)
      urls.delete(image.url)
    }
  }
}

function retry() {
  releaseImages()
  state.value = 'idle'
  failure.value = null
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
  failure.value = null
  originalFailure.value = null
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
    originalFailure.value = null
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
      <span>{{ failure ? failureText(failure) : t('records.images.unavailable') }}</span>
      <button
        v-if="!failure || failure.retryable"
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
          v-else-if="image.failure"
          class="flex h-24 w-48 max-w-full flex-col items-center justify-center gap-2 rounded-lg bg-gray-200/40 text-xs text-gray-500 dark:bg-gray-700/40 dark:text-gray-400"
        >
          <span>{{ failureText(image.failure) }}</span>
          <button
            v-if="image.failure.retryable"
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
          <span>
            {{
              originalFailure && originalFailure.code !== 'IMAGE_SOURCE_UNAVAILABLE'
                ? failureText(originalFailure)
                : t('records.images.originalUnavailable')
            }}
          </span>
          <button
            v-if="!originalFailure || originalFailure.retryable"
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
