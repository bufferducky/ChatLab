<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AnalysisSession } from '@/types/base'
import { useApiServerStore } from '@/stores/apiServer'
import { IS_WEB_WASM } from '@/utils/platform'
import { formatDateTime } from '@/utils/dateFormat'
import PlatformBadge from '@/components/common/PlatformBadge.vue'
import { getSessionSources } from './session-source'

const props = defineProps<{ session: AnalysisSession }>()
const { t } = useI18n()
const apiStore = useApiServerStore()
const open = ref(false)
const loading = ref(false)
const failed = ref(false)
const sources = computed(() => getSessionSources(props.session.id, apiStore.dataSources))
const sourceNames = computed(() => [...new Set(sources.value.map((source) => source.name).filter(Boolean))].join(' · '))

async function loadSources() {
  if (IS_WEB_WASM) return
  loading.value = true
  failed.value = !(await apiStore.fetchDataSources())
  loading.value = false
}

onMounted(loadSources)
</script>

<template>
  <div
    class="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 text-[11px] text-gray-500 dark:text-gray-400"
  >
    <div class="flex min-w-0 flex-wrap items-center gap-2">
      <PlatformBadge :platform="session.platform" />
      <span v-if="sourceNames" class="max-w-64 truncate" :title="sourceNames">{{ sourceNames }}</span>
      <span>{{ t(`layout.filter.${session.type}`) }}</span>
      <span>{{ t('layout.sessionInfo', { count: session.messageCount.toLocaleString() }) }}</span>
    </div>
    <UPopover
      v-model:open="open"
      :ui="{ content: 'z-50 w-80 max-w-[calc(100vw-2rem)] p-4' }"
      @update:open="
        (value: boolean) => {
          if (value) loadSources()
        }
      "
    >
      <UButton icon="i-lucide-info" color="neutral" variant="ghost" size="xs" :aria-label="t('layout.sources.details')">
        {{ t('layout.sources.details') }}
      </UButton>
      <template #content>
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-sm font-semibold text-gray-900 dark:text-white">{{ t('layout.sources.details') }}</h2>
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="t('common.close')"
            @click="open = false"
          />
        </div>
        <dl class="mt-3 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 text-xs">
          <dt class="text-gray-500 dark:text-gray-400">{{ t('layout.sources.platform') }}</dt>
          <dd><PlatformBadge :platform="session.platform" /></dd>
          <template v-if="session.ownerStatus === 'resolved' && session.ownerName">
            <dt class="text-gray-500 dark:text-gray-400">{{ t('layout.sources.owner') }}</dt>
            <dd class="break-words">{{ session.ownerName }}</dd>
          </template>
          <dt class="text-gray-500 dark:text-gray-400">{{ t('layout.sources.importedAt') }}</dt>
          <dd>{{ session.importedAt > 0 ? formatDateTime(session.importedAt) : t('layout.sources.unavailable') }}</dd>
        </dl>
        <div v-if="loading" class="mt-4 space-y-2" role="status" :aria-label="t('common.loading')">
          <USkeleton class="h-4 w-3/4" />
          <USkeleton class="h-4 w-1/2" />
        </div>
        <div v-else-if="failed" class="mt-4 text-xs text-gray-600 dark:text-gray-300" role="status">
          {{ t('layout.sources.loadFailed') }}
          <UButton size="xs" variant="soft" class="mt-2" @click="loadSources">{{ t('common.retry') }}</UButton>
        </div>
        <div v-else-if="sources.length" class="mt-4 max-h-72 space-y-4 overflow-y-auto">
          <section
            v-for="source in sources"
            :key="source.id"
            class="border-t border-gray-200 pt-3 dark:border-gray-700"
          >
            <div class="flex items-start justify-between gap-3 text-xs">
              <h3 class="min-w-0 break-words font-medium text-gray-900 dark:text-white">
                {{ source.name || t('layout.sources.unnamed') }}
              </h3>
              <span class="shrink-0 text-gray-500 dark:text-gray-400">
                {{ t(source.enabled ? 'layout.sources.automatic' : 'layout.sources.paused') }}
              </span>
            </div>
            <dl class="mt-3 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2.5 text-xs">
              <dt class="text-gray-500 dark:text-gray-400">{{ t('layout.sources.interval') }}</dt>
              <dd>{{ t('layout.sources.minutes', { count: source.intervalMinutes }) }}</dd>
              <dt class="text-gray-500 dark:text-gray-400">{{ t('layout.sources.result') }}</dt>
              <dd :class="source.status === 'error' ? 'text-red-600 dark:text-red-400' : ''">
                {{ t(`layout.sources.status.${source.status}`) }}
              </dd>
              <template v-if="source.progressAt > 0">
                <dt class="text-gray-500 dark:text-gray-400">{{ t('layout.sources.progress') }}</dt>
                <dd>{{ formatDateTime(source.progressAt) }}</dd>
              </template>
            </dl>
          </section>
          <p class="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
            {{ t('layout.sources.progressHint') }}
          </p>
        </div>
        <p v-else class="mt-4 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
          {{ t('layout.sources.unlinked') }}
        </p>
      </template>
    </UPopover>
  </div>
</template>
