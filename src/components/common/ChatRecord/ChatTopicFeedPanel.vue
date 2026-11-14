<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ChatTopicAutomationSettings, ChatTopicFeed, ChatTopicFeedItem } from '@openchatlab/shared-types'
import { useChatTopicsService } from '@/services'
import { useToast } from '@/composables/useToast'
import { chatTopicColorStyle, CHAT_TOPIC_COLOR_STYLES, type ChatTopicHighlight } from './topic-highlight'

const props = defineProps<{ sessionId: string; mode: 'updates' | 'all' }>()
const emit = defineEmits<{
  (event: 'jump-to-message', id: number): void
  (event: 'highlight-topic', topic: ChatTopicHighlight | null): void
}>()
const { t, locale } = useI18n()
const toast = useToast()
const feed = ref<ChatTopicFeed | null>(null)
const loading = ref(true)
const busy = ref(false)
const loadError = ref('')
const showSettings = ref(false)
const settings = ref<ChatTopicAutomationSettings | null>(null)
const query = ref('')
const dateFilter = ref('')
const selectedId = ref<string | null>(null)
const limit = ref(50)
let generation = 0
let timer: ReturnType<typeof setTimeout> | null = null

const active = computed(() => feed.value?.run && ['pending', 'running'].includes(feed.value.run.status))
const filteredTopics = computed(() =>
  (feed.value?.topics ?? []).filter((topic) => {
    if (props.mode === 'updates' && topic.version <= topic.readVersion) return false
    if (query.value && !`${topic.title}\n${topic.summary}`.toLowerCase().includes(query.value.toLowerCase()))
      return false
    return (
      props.mode !== 'all' ||
      !dateFilter.value ||
      topic.timeRanges.some(
        (range) => dayKey(range.startTs) <= dateFilter.value && dayKey(range.endTs) >= dateFilter.value
      )
    )
  })
)
const visibleTopics = computed(() => filteredTopics.value.slice(0, limit.value))
const unreadCount = computed(
  () => (feed.value?.topics ?? []).filter((topic) => topic.version > topic.readVersion).length
)
const status = computed(() => {
  if (!feed.value?.modelConfigured) return 'noModel'
  if (active.value) return 'processing'
  if (!feed.value?.settings.enabled) return 'disabled'
  if (!feed.value.withinSchedule) return 'sleeping'
  return feed.value.pendingMessages ? 'waiting' : 'caughtUp'
})

async function refresh(initial = false) {
  const current = ++generation
  const sessionId = props.sessionId
  if (timer) clearTimeout(timer)
  if (initial) loading.value = true
  try {
    const next = await useChatTopicsService().getFeed(sessionId)
    if (current !== generation) return
    const previous = feed.value?.topics.find((topic) => topic.id === selectedId.value)
    const selected = next.topics.find((topic) => topic.id === selectedId.value)
    if (previous && JSON.stringify(previous.messageIds) !== JSON.stringify(selected?.messageIds)) {
      selectedId.value = null
      emit('highlight-topic', null)
    }
    feed.value = next
    loadError.value = ''
  } catch (error) {
    if (current !== generation) return
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (current === generation) {
      loading.value = false
      timer = setTimeout(() => void refresh(), active.value ? 1000 : 15_000)
    }
  }
}

async function perform(action: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true
  const sessionId = props.sessionId
  try {
    await action()
    if (sessionId === props.sessionId) await refresh()
  } catch (error) {
    toast.fail(t('records.topics.actionFailed'), {
      description: error instanceof Error ? error.message : String(error),
    })
  } finally {
    busy.value = false
  }
}

function openSettings() {
  settings.value = feed.value ? { ...feed.value.settings, locale: locale.value } : null
  showSettings.value = !showSettings.value
}

async function saveSettings() {
  if (!settings.value) return
  const sessionId = props.sessionId
  const next = { ...settings.value }
  await perform(async () => {
    await useChatTopicsService().setAutomation(sessionId, next)
    if (sessionId === props.sessionId) showSettings.value = false
  })
}

function markRead(topics: ChatTopicFeedItem[]) {
  const sessionId = props.sessionId
  // Submit displayed versions, so updates arriving during this request stay unread.
  const versions = topics.map((topic) => ({ id: topic.id, version: topic.version }))
  void perform(() => useChatTopicsService().markRead(sessionId, versions))
}

function colorIndex(topic: ChatTopicFeedItem) {
  let hash = 0
  for (const char of topic.id) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return Math.abs(hash) % CHAT_TOPIC_COLOR_STYLES.length
}

function selectTopic(topic: ChatTopicFeedItem, messageId?: number) {
  selectedId.value = topic.id
  emit('highlight-topic', {
    messageIds: topic.messageIds,
    timeRanges: topic.timeRanges,
    assignmentMode: topic.assignmentMode,
    colorIndex: colorIndex(topic),
  })
  const target =
    messageId ??
    topic.updates.at(-1)?.evidence.at(-1)?.messageId ??
    topic.evidence.at(-1)?.messageId ??
    topic.messageIds[0]
  if (target !== undefined) emit('jump-to-message', target)
}

function formatDate(timestamp: number | null) {
  if (timestamp === null) return '—'
  return new Intl.DateTimeFormat(locale.value, {
    timeZone: feed.value?.settings.timezone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(timestamp)
}

function dayKey(timestamp: number) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: feed.value?.settings.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(timestamp * 1000)
  return ['year', 'month', 'day'].map((key) => parts.find((part) => part.type === key)?.value).join('-')
}

watch(
  () => props.sessionId,
  () => {
    feed.value = null
    selectedId.value = null
    showSettings.value = false
    query.value = ''
    dateFilter.value = ''
    emit('highlight-topic', null)
    void refresh(true)
  },
  { immediate: true }
)
watch([query, dateFilter, () => props.mode], () => {
  limit.value = 50
})
onUnmounted(() => {
  generation += 1
  if (timer) clearTimeout(timer)
  emit('highlight-topic', null)
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div v-if="loading" class="space-y-3 p-3" :aria-label="t('common.loading')">
      <div
        v-for="index in 3"
        :key="index"
        class="h-20 animate-pulse rounded-lg bg-gray-100 motion-reduce:animate-none dark:bg-gray-800"
      />
    </div>
    <div v-else class="min-h-0 flex-1 overflow-y-auto p-3">
      <div v-if="loadError" role="alert" class="mb-3 text-xs text-red-500">
        {{ loadError }}
        <UButton size="xs" variant="ghost" @click="refresh()">{{ t('records.topics.feed.retry') }}</UButton>
      </div>
      <template v-if="feed">
        <section class="mb-3 border-b border-gray-100 pb-3 dark:border-gray-800">
          <div class="flex items-center justify-between gap-2">
            <p class="text-xs font-medium text-gray-700 dark:text-gray-200" role="status">
              {{ t(`records.topics.feed.${status}`) }}
            </p>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-heroicons-adjustments-horizontal"
              :aria-label="t('records.topics.feed.settings')"
              :aria-expanded="showSettings"
              @click="openSettings"
            />
          </div>
          <p class="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
            {{
              t('records.topics.feed.schedule', {
                start: feed.settings.startTime,
                end: feed.settings.endTime,
                timezone: feed.settings.timezone,
              })
            }}
          </p>
          <div class="mt-2 space-y-1 text-[11px] tabular-nums text-gray-500 dark:text-gray-400">
            <p>{{ t('records.topics.feed.syncedAt', { time: formatDate(feed.syncedAt) }) }}</p>
            <p>{{ t('records.topics.feed.processedAt', { time: formatDate(feed.processedAt) }) }}</p>
            <p v-if="feed.pendingMessages">{{ t('records.topics.feed.pending', { count: feed.pendingMessages }) }}</p>
          </div>
          <div
            v-if="showSettings && settings"
            class="mt-3 space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
          >
            <label class="flex items-center justify-between gap-2 text-xs">
              {{ t('records.topics.feed.enable') }}
              <USwitch v-model="settings.enabled" :aria-label="t('records.topics.feed.enable')" />
            </label>
            <div class="grid grid-cols-2 gap-2">
              <label class="text-xs">
                {{ t('records.topics.feed.startTime') }}
                <UInput v-model="settings.startTime" type="time" class="mt-1 w-full" />
              </label>
              <label class="text-xs">
                {{ t('records.topics.feed.endTime') }}
                <UInput v-model="settings.endTime" type="time" class="mt-1 w-full" />
              </label>
            </div>
            <label class="block text-xs">
              {{ t('records.topics.feed.timezone') }}
              <UInput v-model="settings.timezone" class="mt-1 w-full" />
            </label>
            <p class="text-[11px] leading-relaxed text-gray-500">{{ t('records.topics.feed.scheduleHint') }}</p>
            <UButton size="xs" :loading="busy" @click="saveSettings">{{ t('records.topics.feed.save') }}</UButton>
          </div>
          <div class="mt-3 flex flex-wrap gap-2">
            <UButton
              size="xs"
              variant="soft"
              :disabled="Boolean(active) || !feed.modelConfigured || !feed.pendingMessages"
              :loading="busy"
              @click="perform(() => useChatTopicsService().updateFeed(sessionId))"
            >
              {{ t('records.topics.feed.updateNow') }}
            </UButton>
            <UButton
              v-if="unreadCount"
              size="xs"
              color="neutral"
              variant="ghost"
              :disabled="busy"
              @click="markRead(visibleTopics)"
            >
              {{ t('records.topics.feed.markShownRead') }}
            </UButton>
          </div>
          <div v-if="feed.run && ['paused', 'failed'].includes(feed.run.status)" class="mt-2 text-xs text-gray-500">
            <p>{{ t(`records.topics.status.${feed.run.status}`) }}</p>
            <p v-if="feed.run.lastError" class="mt-1 text-red-500">{{ feed.run.lastError }}</p>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              :loading="busy"
              @click="perform(() => useChatTopicsService().resume(sessionId, feed!.run!.id))"
            >
              {{ t('records.topics.resume') }}
            </UButton>
          </div>
        </section>

        <div class="mb-3 flex flex-wrap gap-2">
          <UInput
            v-model="query"
            icon="i-heroicons-magnifying-glass"
            :placeholder="t('records.topics.feed.search')"
            :aria-label="t('records.topics.feed.search')"
            size="sm"
            class="min-w-0 flex-1"
          />
          <UInput
            v-if="mode === 'all'"
            v-model="dateFilter"
            type="date"
            :aria-label="t('records.topics.feed.filterDate')"
            size="sm"
          />
        </div>
        <p class="mb-2 text-[11px] text-gray-500">{{ t('records.topics.feed.unreadCount', { count: unreadCount }) }}</p>
        <div v-if="!visibleTopics.length" class="py-8 text-center">
          <p class="text-sm font-medium text-gray-700 dark:text-gray-200">
            {{ t(mode === 'updates' ? 'records.topics.feed.noUpdates' : 'records.topics.feed.noTopics') }}
          </p>
          <p class="mt-2 text-xs leading-relaxed text-gray-500">{{ t('records.topics.feed.emptyHint') }}</p>
        </div>
        <div class="space-y-3">
          <article
            v-for="topic in visibleTopics"
            :key="topic.id"
            class="rounded-lg border bg-white p-3 dark:bg-gray-900/50"
            :class="
              selectedId === topic.id
                ? chatTopicColorStyle(colorIndex(topic)).selectedCard
                : 'border-gray-200 dark:border-gray-700'
            "
          >
            <div class="flex items-start justify-between gap-2">
              <button
                class="text-left text-sm font-semibold leading-snug text-gray-800 outline-none hover:text-primary-500 focus-visible:ring-2 focus-visible:ring-primary-400 dark:text-gray-100"
                @click="selectTopic(topic)"
              >
                {{ topic.title }}
              </button>
              <span
                v-if="topic.version > topic.readVersion"
                class="shrink-0 rounded bg-primary-50 px-1.5 py-0.5 text-[10px] text-primary-600 dark:bg-primary-950/30 dark:text-primary-300"
              >
                {{ t(topic.readVersion === 0 ? 'records.topics.feed.newTopic' : 'records.topics.feed.newProgress') }}
              </span>
            </div>
            <p class="mt-1 text-[10px] tabular-nums text-gray-500">
              {{ formatDate(topic.updatedAt) }} ·
              {{ t('records.topics.feed.messageCount', { count: topic.messageIds.length }) }}
            </p>
            <div
              v-if="topic.version > topic.readVersion"
              class="mt-3 border-l-2 border-primary-200 pl-2 dark:border-primary-800"
            >
              <p class="mb-1 text-[11px] font-medium text-primary-600 dark:text-primary-300">
                {{ t('records.topics.feed.sinceRead') }}
              </p>
              <div
                v-for="update in topic.updates.filter((item) => item.version > topic.readVersion)"
                :key="update.version"
                class="mb-2 last:mb-0"
              >
                <p class="reading-text whitespace-pre-line text-gray-700 dark:text-gray-200">{{ update.text }}</p>
                <button
                  v-for="evidence in update.evidence.slice(-3)"
                  :key="evidence.messageId"
                  class="mr-2 mt-1 text-[10px] text-primary-500 hover:underline focus-visible:outline-primary-400"
                  @click="selectTopic(topic, evidence.messageId)"
                >
                  {{ formatDate(evidence.timestamp * 1000) }}
                </button>
              </div>
            </div>
            <details class="mt-3" :open="mode === 'all' || topic.version <= topic.readVersion">
              <summary class="cursor-pointer text-xs text-gray-500 hover:text-primary-500">
                {{ t('records.topics.feed.currentSummary') }}
              </summary>
              <p class="reading-text mt-2 text-gray-700 dark:text-gray-200">{{ topic.summary }}</p>
            </details>
            <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-2 dark:border-gray-800">
              <UButton size="xs" color="neutral" variant="ghost" @click="selectTopic(topic)">
                {{ t('records.topics.feed.viewOriginal') }}
              </UButton>
              <UButton
                v-if="topic.version > topic.readVersion"
                size="xs"
                color="neutral"
                variant="ghost"
                :disabled="busy"
                @click="markRead([topic])"
              >
                {{ t('records.topics.feed.markRead') }}
              </UButton>
              <span v-if="topic.state === 'closed'" class="text-[10px] text-gray-500">
                {{ t('records.topics.topicState.closed') }}
              </span>
            </div>
          </article>
        </div>
        <UButton
          v-if="filteredTopics.length > limit"
          class="mt-3"
          size="xs"
          color="neutral"
          variant="ghost"
          @click="limit += 50"
        >
          {{ t('records.topics.feed.showMore') }}
        </UButton>
      </template>
    </div>
  </div>
</template>
