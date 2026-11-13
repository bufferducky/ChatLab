<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  Hotspot,
  HotspotCategory,
  HotspotConfig,
  HotspotFeed,
  HotspotSource,
  HotspotWindow,
} from '@openchatlab/shared-types'
import { useSessionStore } from '@/stores/session'
import { useLayoutStore } from '@/stores/layout'
import { hotspotService } from '@/services/hotspots'
import { IS_WEB_WASM } from '@/utils/platform'

// Reuse the host's typography, neutral surfaces and primary accent in both themes.
const { t, locale } = useI18n()
const sessions = useSessionStore()
const layout = useLayoutStore()
const data = ref<HotspotFeed | null>(null)
const window = ref<HotspotWindow>('day')
const category = ref<HotspotCategory | 'all'>('all')
const savedOnly = ref(false)
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const settings = ref(false)
const groupSearch = ref('')
const expanded = ref<string | null>(null)
const draft = ref<HotspotConfig>({ sessionIds: [], enabled: false, locale: locale.value, interests: '' })
const windows: HotspotWindow[] = ['day', 'week', 'month']
const categories = ['all', 'ai', 'tech', 'news', 'gossip', 'other'] as const
const groups = computed(() =>
  sessions.sessions.filter(
    (session) =>
      session.type === 'group' &&
      `${session.name} ${session.platform}`.toLowerCase().includes(groupSearch.value.trim().toLowerCase())
  )
)
const visible = computed(
  () => data.value?.items.filter((item) => category.value === 'all' || item.category === category.value) ?? []
)
let version = 0
let timer: ReturnType<typeof setInterval> | undefined
let disposed = false
let nextPoll = 0
function date(ts: number | null | undefined) {
  return ts
    ? new Date(ts * 1000).toLocaleString(locale.value, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : t('hotspots.notYet')
}
async function load(quiet = false) {
  const current = ++version
  if (!quiet) loading.value = true
  try {
    const result = await hotspotService.feed(window.value, savedOnly.value)
    if (current === version && !disposed) {
      data.value = result
      error.value = ''
      nextPoll = Date.now() + (result.status.running ? 5000 : 60000)
    }
  } catch (cause) {
    if (current === version && !disposed) error.value = String(cause instanceof Error ? cause.message : cause)
  } finally {
    if (current === version && !disposed) loading.value = false
  }
}
function openSettings() {
  draft.value = structuredClone(data.value ? JSON.parse(JSON.stringify(data.value.config)) : draft.value)
  groupSearch.value = ''
  settings.value = true
}
async function perform(action: () => Promise<unknown>) {
  busy.value = true
  error.value = ''
  try {
    await action()
    await load(true)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}
async function saveSettings() {
  await perform(async () => {
    await hotspotService.configure({ ...draft.value, locale: locale.value })
    settings.value = false
  })
}
async function mark(item: Hotspot, value: { read?: boolean; saved?: boolean; dismissed?: boolean }) {
  await perform(() => hotspotService.mark(item.id, value))
}
function source(source: HotspotSource) {
  layout.openChatRecords({ sessionId: source.sessionId, scrollToMessageId: source.messageId })
}
watch([window, savedOnly], () => {
  void load()
})
onMounted(async () => {
  if (IS_WEB_WASM) {
    loading.value = false
    return
  }
  await load()
  if (disposed) return
  timer = setInterval(() => {
    if (!disposed && !settings.value && Date.now() >= nextPoll) void load(true)
  }, 5000)
})
onUnmounted(() => {
  disposed = true
  version++
  clearInterval(timer)
})
</script>

<template>
  <main class="h-full overflow-y-auto bg-page-bg text-gray-900 dark:bg-page-dark dark:text-gray-100">
    <div class="mx-auto max-w-5xl px-5 pb-16 pt-10 sm:px-10">
      <header
        class="flex flex-wrap items-start justify-between gap-4 border-b border-gray-200 pb-6 dark:border-gray-800"
      >
        <div>
          <div class="mb-2 flex items-center gap-2 text-sm text-primary-600 dark:text-primary-400">
            <UIcon name="i-lucide-radio" />
            {{ t('hotspots.eyebrow') }}
          </div>
          <h1 class="text-3xl font-semibold tracking-tight">{{ t('hotspots.title') }}</h1>
          <p class="mt-3 max-w-xl text-sm leading-6 text-gray-500 dark:text-gray-400">{{ t('hotspots.subtitle') }}</p>
        </div>
        <div v-if="!IS_WEB_WASM" class="flex gap-2">
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-sliders-horizontal"
            :disabled="loading || busy || data?.status.running"
            @click="openSettings"
          >
            {{ t('hotspots.settings') }}
          </UButton>
          <UButton
            icon="i-lucide-refresh-cw"
            :disabled="busy || loading || data?.status.running || !data?.config.sessionIds.length"
            @click="perform(() => hotspotService.update())"
          >
            {{ t(data?.status.running ? 'hotspots.updating' : 'hotspots.update') }}
          </UButton>
        </div>
      </header>
      <p v-if="IS_WEB_WASM" class="py-12 text-gray-500">{{ t('hotspots.nodeOnly') }}</p>
      <template v-else>
        <div
          v-if="data"
          class="flex flex-wrap gap-x-5 gap-y-2 py-4 text-xs leading-5 text-gray-500 dark:text-gray-400"
          aria-live="polite"
        >
          <span>{{ t('hotspots.sourceLatest') }} · {{ date(data.status.sourceLatest) }}</span>
          <span>{{ t('hotspots.analysisLatest') }} · {{ date(data.status.analyzedThrough) }}</span>
          <span>{{ t(data.config.enabled ? 'hotspots.autoOn' : 'hotspots.autoOff') }}</span>
          <span v-if="data.status.running">{{ t('hotspots.updating') }}</span>
          <span v-if="data.status.backlog">{{ t('hotspots.backlog', { count: data.status.backlog }) }}</span>
        </div>
        <div
          v-if="error || data?.status.error"
          role="alert"
          class="my-4 rounded-lg border border-red-300 p-4 text-sm text-red-700 dark:border-red-900 dark:text-red-300"
        >
          {{ error || data?.status.error }}
          <UButton v-if="error" color="neutral" variant="link" size="xs" @click="load()">
            {{ t('common.retry') }}
          </UButton>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-4 py-4">
          <div
            role="group"
            :aria-label="t('hotspots.windowLabel')"
            class="flex gap-1 rounded-lg bg-gray-100 p-1 dark:bg-white/5"
          >
            <UButton
              v-for="item in windows"
              :key="item"
              color="neutral"
              :variant="window === item ? 'solid' : 'ghost'"
              :aria-pressed="window === item"
              size="sm"
              @click="window = item"
            >
              {{ t(`hotspots.windows.${item}`) }}
            </UButton>
          </div>
          <UButton
            icon="i-lucide-bookmark"
            color="neutral"
            :variant="savedOnly ? 'soft' : 'ghost'"
            :aria-pressed="savedOnly"
            @click="savedOnly = !savedOnly"
          >
            {{ t('hotspots.saved') }}
          </UButton>
        </div>
        <div role="group" :aria-label="t('hotspots.categoryLabel')" class="mb-5 flex flex-wrap gap-2">
          <UButton
            v-for="item in categories"
            :key="item"
            :color="category === item ? 'primary' : 'neutral'"
            :variant="category === item ? 'soft' : 'ghost'"
            :aria-pressed="category === item"
            size="sm"
            @click="category = item"
          >
            {{ t(`hotspots.categories.${item}`) }}
          </UButton>
        </div>
        <div v-if="loading" role="status" :aria-label="t('common.loading')" class="space-y-6 py-4">
          <div v-for="n in 3" :key="n" class="space-y-3 border-b border-gray-200 pb-6 dark:border-gray-800">
            <USkeleton class="h-5 w-2/3" />
            <USkeleton class="h-4 w-full" />
            <USkeleton class="h-4 w-4/5" />
          </div>
        </div>
        <div
          v-else-if="!data?.config.sessionIds.length"
          class="border-y border-dashed border-gray-300 py-14 dark:border-gray-700"
        >
          <h2 class="text-lg font-medium">{{ t('hotspots.startTitle') }}</h2>
          <p class="mt-2 max-w-lg text-sm leading-6 text-gray-500 dark:text-gray-400">{{ t('hotspots.startHint') }}</p>
          <UButton class="mt-5" @click="openSettings">{{ t('hotspots.settings') }}</UButton>
        </div>
        <p v-else-if="!visible.length" class="py-14 text-sm text-gray-500 dark:text-gray-400">
          {{ t(data.status.running ? 'hotspots.firstRun' : 'hotspots.empty') }}
        </p>
        <ol v-else class="divide-y divide-gray-200 dark:divide-gray-800">
          <li v-for="(item, index) in visible" :key="item.id" class="py-6 sm:py-8">
            <article
              class="flex gap-4 sm:gap-6"
              :class="{ 'opacity-70': item.readAt && item.readAt >= item.updatedAt }"
            >
              <span class="pt-1 font-mono text-sm tabular-nums text-gray-400" aria-hidden="true">
                {{ String(index + 1).padStart(2, '0') }}
              </span>
              <div class="min-w-0 flex-1">
                <div class="mb-2 flex flex-wrap gap-3 text-xs text-gray-500 dark:text-gray-400">
                  <span :class="{ 'text-primary-600 dark:text-primary-400': item.category === 'ai' }">
                    {{ t(`hotspots.categories.${item.category}`) }}
                  </span>
                  <time>{{ date(item.updatedAt) }}</time>
                  <span v-if="item.confidence === 'rumor'">{{ t('hotspots.rumor') }}</span>
                  <span v-if="item.readAt">{{ t('hotspots.read') }}</span>
                </div>
                <h2 class="text-lg font-semibold leading-7">{{ item.title }}</h2>
                <p class="mt-3 whitespace-pre-line text-sm leading-7 text-gray-700 dark:text-gray-300">
                  {{ item.summary }}
                </p>
                <p v-if="item.why" class="mt-2 text-sm leading-6 text-gray-500 dark:text-gray-400">{{ item.why }}</p>
                <div class="mt-4 flex flex-wrap gap-1">
                  <UButton
                    size="xs"
                    variant="ghost"
                    color="neutral"
                    icon="i-lucide-messages-square"
                    :aria-expanded="expanded === item.id"
                    @click="expanded = expanded === item.id ? null : item.id"
                  >
                    {{ t('hotspots.sources', { count: item.sources.length }) }}
                  </UButton>
                  <UButton
                    size="xs"
                    variant="ghost"
                    color="neutral"
                    :disabled="busy"
                    :aria-pressed="!!item.readAt"
                    @click="mark(item, { read: !item.readAt })"
                  >
                    {{ t(item.readAt ? 'hotspots.unread' : 'hotspots.markRead') }}
                  </UButton>
                  <UButton
                    size="xs"
                    :variant="item.saved ? 'soft' : 'ghost'"
                    color="neutral"
                    icon="i-lucide-bookmark"
                    :disabled="busy"
                    :aria-pressed="item.saved"
                    @click="mark(item, { saved: !item.saved })"
                  >
                    {{ t(item.saved ? 'hotspots.unsave' : 'hotspots.save') }}
                  </UButton>
                  <UButton
                    size="xs"
                    variant="ghost"
                    color="neutral"
                    :disabled="busy"
                    @click="mark(item, { dismissed: !item.dismissed })"
                  >
                    {{ t(item.dismissed ? 'hotspots.restore' : 'hotspots.dismiss') }}
                  </UButton>
                </div>
                <div
                  v-if="expanded === item.id"
                  class="mt-4 space-y-4 border-l-2 border-gray-200 pl-4 dark:border-gray-700"
                >
                  <p class="text-xs text-gray-500 dark:text-gray-400">{{ t('hotspots.evidenceHint') }}</p>
                  <div v-for="evidence in item.sources" :key="`${evidence.sessionId}:${evidence.messageId}`">
                    <button
                      type="button"
                      class="rounded text-left text-xs text-primary-600 hover:underline focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-primary-400"
                      @click="source(evidence)"
                    >
                      {{ evidence.sessionName }} · {{ date(evidence.timestamp) }} ↗
                    </button>
                    <p class="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-gray-500 dark:text-gray-400">
                      {{ evidence.snippet }}
                    </p>
                  </div>
                  <div v-if="item.links.length" class="flex flex-col gap-2">
                    <a
                      v-for="link in item.links"
                      :key="link"
                      :href="link"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="break-all text-xs text-primary-600 hover:underline focus-visible:outline-2 dark:text-primary-400"
                    >
                      {{ link }}
                    </a>
                  </div>
                  <div v-for="(update, n) in item.updates" :key="n" class="text-sm leading-6">
                    <span class="text-xs text-gray-400">{{ date(update.timestamp) }}</span>
                    <p>{{ update.text }}</p>
                  </div>
                </div>
              </div>
            </article>
          </li>
        </ol>
      </template>
    </div>
    <UModal v-model:open="settings" :title="t('hotspots.settings')" :description="t('hotspots.settingsHint')">
      <template #body>
        <div class="space-y-5">
          <UInput
            v-model="groupSearch"
            :placeholder="t('hotspots.searchGroups')"
            :aria-label="t('hotspots.searchGroups')"
            icon="i-lucide-search"
            class="w-full"
          />
          <p class="text-xs text-gray-500 dark:text-gray-400">
            {{ t('hotspots.selectedGroups', { count: draft.sessionIds.length }) }}
          </p>
          <div class="max-h-64 space-y-3 overflow-y-auto">
            <label v-for="group in groups" :key="group.id" class="flex cursor-pointer items-start gap-3 text-sm">
              <input v-model="draft.sessionIds" type="checkbox" :value="group.id" class="mt-1 accent-primary-500" />
              <span>
                {{ group.name }}
                <span class="text-xs text-gray-400">{{ group.platform }}</span>
              </span>
            </label>
            <p v-if="!groups.length" class="text-sm text-gray-500">
              {{ t(groupSearch ? 'layout.noSearchResult' : 'hotspots.noGroups') }}
            </p>
          </div>
          <label class="block text-sm">
            <span class="mb-2 block">{{ t('hotspots.interests') }}</span>
            <textarea
              v-model="draft.interests"
              maxlength="1000"
              rows="3"
              class="w-full rounded-lg border border-gray-300 bg-transparent p-3 focus-visible:outline-2 focus-visible:outline-primary-500 dark:border-gray-700"
              :placeholder="t('hotspots.interestsHint')"
            />
          </label>
          <label class="flex items-center gap-3 text-sm">
            <input v-model="draft.enabled" type="checkbox" class="accent-primary-500" />
            {{ t('hotspots.enableAuto') }}
          </label>
          <p v-if="error" role="alert" class="text-sm text-red-600 dark:text-red-400">{{ error }}</p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="settings = false">{{ t('common.cancel') }}</UButton>
          <UButton :disabled="busy" @click="saveSettings">{{ t('common.save') }}</UButton>
        </div>
      </template>
    </UModal>
  </main>
</template>
