<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { fetchWithAuth, getBaseUrl } from '@/services/utils/http'
import { useVideoPlaybackStore } from '@/stores/videoPlayback'

const props = defineProps<{ sessionId: string; messageId: number }>()
const { t } = useI18n()
const playback = useVideoPlaybackStore()
const url = ref('')
const state = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const error = ref('')
const largeOpen = ref(false)
const inlinePlayer = ref<HTMLVideoElement | null>(null)
const largePlayer = ref<HTMLVideoElement | null>(null)
let resumeTime = 0
let controller = new AbortController()

async function load() {
  if (state.value === 'loading' || state.value === 'ready') return
  const signal = controller.signal
  state.value = 'loading'
  error.value = ''
  try {
    const response = await fetchWithAuth(
      `${getBaseUrl()}/sessions/${encodeURIComponent(props.sessionId)}/messages/${props.messageId}/images/0?size=original`,
      { signal }
    )
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error(body?.error?.message || t('records.video.loadFailed'))
    }
    const blob = await response.blob()
    if (signal.aborted) return
    if (!blob.type.startsWith('video/')) throw new Error(t('records.video.unsupported'))
    url.value = URL.createObjectURL(blob)
    state.value = 'ready'
  } catch (cause) {
    if (signal.aborted) return
    error.value = cause instanceof Error ? cause.message : t('records.video.loadFailed')
    state.value = 'error'
  }
}

function reset() {
  inlinePlayer.value?.pause()
  largePlayer.value?.pause()
  largeOpen.value = false
  resumeTime = 0
  controller.abort()
  controller = new AbortController()
  if (url.value) URL.revokeObjectURL(url.value)
  url.value = ''
  state.value = 'idle'
}

function openLarge() {
  resumeTime = inlinePlayer.value?.currentTime ?? 0
  inlinePlayer.value?.pause()
  largeOpen.value = true
}

function restoreLargeTime() {
  if (largePlayer.value) largePlayer.value.currentTime = resumeTime
}

watch(largeOpen, (open) => {
  if (open) return
  if (largePlayer.value) {
    if (inlinePlayer.value) inlinePlayer.value.currentTime = largePlayer.value.currentTime
    largePlayer.value.pause()
  }
})
// Video bytes are fetched only on explicit user action (see the load button in the template).
watch(
  () => [props.sessionId, props.messageId],
  () => {
    reset()
  }
)
watch(
  [inlinePlayer, largePlayer, () => props.sessionId],
  ([inline, large, sessionId], _previous, onCleanup) => {
    const release = [inline, large]
      .filter((player) => player !== null)
      .map((player) => playback.register(player, sessionId))
    onCleanup(() => release.forEach((stop) => stop()))
  },
  { flush: 'post' }
)
onBeforeUnmount(reset)
</script>

<template>
  <div class="mb-2 w-80 max-w-full">
    <video
      v-if="url"
      ref="inlinePlayer"
      :src="url"
      controls
      :muted="playback.isMuted(sessionId)"
      playsinline
      preload="metadata"
      :aria-label="t('records.video.player')"
      class="max-h-96 w-full rounded-lg bg-black"
      @error="error = t('records.video.unsupported')"
    />
    <UButton
      v-if="url"
      size="xs"
      color="neutral"
      variant="ghost"
      icon="i-heroicons-arrows-pointing-out"
      class="mt-1"
      @click="openLarge"
    >
      {{ t('records.video.openLarge') }}
    </UButton>
    <div
      v-else
      class="flex min-h-28 items-center justify-center rounded-lg bg-gray-100 p-3 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400"
      :aria-busy="state === 'loading'"
    >
      <span v-if="state === 'loading'" role="status">{{ t('records.video.loading') }}</span>
      <div v-else-if="state === 'error'" role="alert" class="space-y-2 text-center">
        <p>{{ error }}</p>
        <UButton size="xs" color="neutral" variant="soft" @click="load">{{ t('common.retry') }}</UButton>
      </div>
      <div v-else class="space-y-2 text-center">
        <UButton
          size="xs"
          color="neutral"
          variant="soft"
          icon="i-heroicons-arrow-down-tray"
          :aria-label="t('records.video.load')"
          @click="load"
        >
          {{ t('records.video.load') }}
        </UButton>
        <p>{{ t('records.video.loadDescription') }}</p>
      </div>
    </div>
    <p v-if="url && error" class="mt-1 text-xs text-gray-500">{{ error }}</p>
  </div>

  <UModal
    v-model:open="largeOpen"
    :title="t('records.video.player')"
    :ui="{ content: 'w-[calc(100vw-2rem)] sm:max-w-5xl z-[10001]', overlay: 'z-[10000]' }"
  >
    <template #content>
      <div class="overflow-hidden rounded-xl bg-white dark:bg-gray-900">
        <div class="flex items-center justify-between px-4 py-2">
          <h2 class="text-sm font-medium">{{ t('records.video.player') }}</h2>
          <UButton
            icon="i-heroicons-x-mark"
            size="sm"
            color="neutral"
            variant="ghost"
            :aria-label="t('common.close')"
            @click="largeOpen = false"
          />
        </div>
        <video
          v-if="largeOpen && url"
          ref="largePlayer"
          :src="url"
          controls
          autoplay
          :muted="playback.isMuted(sessionId)"
          playsinline
          :aria-label="t('records.video.player')"
          class="max-h-[80dvh] w-full bg-black object-contain"
          @loadedmetadata="restoreLargeTime"
        />
      </div>
    </template>
  </UModal>
</template>
