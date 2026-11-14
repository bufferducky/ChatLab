<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatTopicsService } from '@/services'

const { t } = useI18n()
const enabled = ref<boolean | null>(null)
const loading = ref(true)
const saving = ref(false)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    enabled.value = (await useChatTopicsService().getGlobalAutomation()).enabled
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
    enabled.value = (await useChatTopicsService().setGlobalAutomation({ enabled: value })).enabled
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <section aria-labelledby="topic-automation-title">
    <h3
      id="topic-automation-title"
      class="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white"
    >
      <UIcon name="i-heroicons-chat-bubble-left-right" class="h-4 w-4 text-primary" />
      {{ t('settings.api.topicAutomation.title') }}
    </h3>
    <div class="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
      <div class="flex items-center justify-between gap-4">
        <div class="min-w-0">
          <p id="topic-automation-label" class="text-sm font-medium text-gray-900 dark:text-white">
            {{ t('settings.api.topicAutomation.enable') }}
          </p>
          <p id="topic-automation-description" class="mt-1 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
            {{ t('settings.api.topicAutomation.description') }}
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
          :model-value="enabled === true"
          :loading="saving"
          :disabled="enabled === null || saving"
          aria-labelledby="topic-automation-label"
          aria-describedby="topic-automation-description"
          class="shrink-0"
          @update:model-value="save"
        />
      </div>
      <p v-if="enabled !== null" role="status" class="mt-3 text-xs text-gray-600 dark:text-gray-300">
        {{ t(`settings.api.topicAutomation.${enabled ? 'enabled' : 'disabled'}`) }}
      </p>
      <div v-if="error" role="alert" class="mt-3 text-xs text-red-600 dark:text-red-400">
        {{ t('settings.api.topicAutomation.failed') }}: {{ error }}
        <UButton v-if="enabled === null" size="xs" variant="ghost" @click="load">
          {{ t('common.retry') }}
        </UButton>
      </div>
    </div>
  </section>
</template>
