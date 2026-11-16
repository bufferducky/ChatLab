<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMediaPolicyService } from '@/services'

const { t } = useI18n()
const videoPrefetch = ref<boolean | null>(null)
// Stays null until the server answers: only an explicit false hides the section.
const supported = ref<boolean | null>(null)
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const failedValue = ref<boolean | null>(null)

async function load() {
  loading.value = true
  error.value = ''
  failedValue.value = null
  try {
    const policy = await useMediaPolicyService().getMediaPolicy()
    supported.value = policy.supported
    videoPrefetch.value = policy.videoPrefetch
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function save(value: boolean) {
  if (saving.value) return
  saving.value = true
  error.value = ''
  try {
    videoPrefetch.value = (await useMediaPolicyService().setVideoPrefetch(value)).videoPrefetch
    failedValue.value = null
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    failedValue.value = value
  } finally {
    saving.value = false
  }
}

function retry() {
  if (failedValue.value !== null) void save(failedValue.value)
  else void load()
}

onMounted(load)
</script>

<template>
  <section v-if="supported !== false" aria-labelledby="media-prefetch-title">
    <h3
      id="media-prefetch-title"
      class="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white"
    >
      <UIcon name="i-heroicons-video-camera" class="h-4 w-4 text-primary" />
      {{ t('settings.api.mediaPrefetch.title') }}
    </h3>
    <div class="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
      <div class="flex items-center justify-between gap-4">
        <div class="min-w-0">
          <p id="media-prefetch-label" class="text-sm font-medium text-gray-900 dark:text-white">
            {{ t('settings.api.mediaPrefetch.enable') }}
          </p>
          <p id="media-prefetch-description" class="mt-1 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
            {{ t('settings.api.mediaPrefetch.description') }}
          </p>
        </div>
        <div
          v-if="loading"
          class="h-5 w-9 shrink-0 animate-pulse rounded-full bg-gray-200 motion-reduce:animate-none dark:bg-gray-700"
          :aria-label="t('common.loading')"
          role="status"
        />
        <USwitch
          v-else
          :model-value="videoPrefetch === true"
          :loading="saving"
          :disabled="videoPrefetch === null || saving"
          aria-labelledby="media-prefetch-label"
          aria-describedby="media-prefetch-description"
          class="shrink-0"
          @update:model-value="save"
        />
      </div>
      <p v-if="videoPrefetch !== null" role="status" class="mt-3 text-xs text-gray-600 dark:text-gray-300">
        {{ t(`settings.api.mediaPrefetch.${videoPrefetch ? 'enabled' : 'disabled'}`) }}
      </p>
      <div v-if="error" role="alert" class="mt-3 text-xs text-red-600 dark:text-red-400">
        {{ t('settings.api.mediaPrefetch.failed') }}: {{ error }}
        <UButton size="xs" variant="ghost" @click="retry">
          {{ t('common.retry') }}
        </UButton>
      </div>
    </div>
  </section>
</template>
