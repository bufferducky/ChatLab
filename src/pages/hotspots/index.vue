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
  HotspotSearch,
  HotspotRecommendation,
  HotspotKnowledgeDraft,
} from '@openchatlab/shared-types'
import { useSessionStore } from '@/stores/session'
import { useLayoutStore } from '@/stores/layout'
import { hotspotService } from '@/services/hotspots'
import { IS_WEB_WASM } from '@/utils/platform'
import SidePanelLayout from '@/components/layout/SidePanelLayout.vue'

// Reuse the host's typography, neutral surfaces and primary accent in both themes.
const { t, locale } = useI18n()
const sessions = useSessionStore()
const layout = useLayoutStore()
const data = ref<HotspotFeed | null>(null)
const window = ref<HotspotWindow>('week')
const category = ref<HotspotCategory | 'all'>('all')
const savedOnly = ref(false)
const query = ref('')
const searchResult = ref<HotspotSearch | null>(null)
const knowledgeOnly = ref(false)
const knowledgeDraft = ref<HotspotKnowledgeDraft | null>(null)
const exportResult = ref<{ path: string; uri: string } | null>(null)
const recommendations = ref<HotspotRecommendation[]>([])
const showUsage = ref(false)
const reconciledAmount = ref<number | null>(null)
const knowledgeOpen = computed({
  get: () => knowledgeDraft.value !== null,
  set: (value) => {
    if (!value) knowledgeDraft.value = null
  },
})
const usage = computed(() => data.value?.usage)
const candidateIds = computed(() => new Set(data.value?.knowledge.map((candidate) => candidate.id) ?? []))
function money(value: number) {
  return new Intl.NumberFormat(locale.value, {
    style: 'currency',
    currency: usage.value?.currency ?? 'CNY',
    maximumFractionDigits: 4,
  }).format(value)
}
function clearSearch() {
  searchResult.value = null
  query.value = ''
}
function toggleKnowledge() {
  knowledgeOnly.value = !knowledgeOnly.value
  if (knowledgeOnly.value) savedOnly.value = false
  searchResult.value = null
}
function toggleSaved() {
  savedOnly.value = !savedOnly.value
  knowledgeOnly.value = false
  category.value = 'all'
  searchResult.value = null
}
async function searchTopics() {
  if (!query.value.trim()) {
    searchResult.value = null
    return
  }
  await perform(async () => {
    searchResult.value = await hotspotService.search(query.value)
    knowledgeOnly.value = false
  })
}
async function prepareKnowledge(item: Hotspot) {
  await perform(async () => {
    knowledgeDraft.value = await hotspotService.knowledgeDraft(item.id)
    exportResult.value = null
  })
}
async function approveKnowledge() {
  const value = knowledgeDraft.value
  if (!value) return
  await perform(async () => {
    exportResult.value = await hotspotService.exportKnowledge(value.id, value.content)
  })
}
function focusTopic(id: string) {
  const item = data.value?.items.find((item) => item.id === id)
  if (!item) return
  searchResult.value = { query: item.title, matches: [{ item, reason: '' }], scanned: 1 }
  knowledgeOnly.value = false
  expanded.value = id
}

const showAll = ref(true)
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const settings = ref(false)
const groupSearch = ref('')
const expanded = ref<string | null>(null)
const draft = ref<HotspotConfig>({
  sessionIds: [],
  enabled: false,
  locale: locale.value,
  interests: '',
  categoryPriorities: {},
  reducedTopics: [],
  reducedSessionIds: [],
})
const windows: HotspotWindow[] = ['day', 'week', 'month']
const categories = ['all', 'ai', 'tech', 'news', 'gossip', 'other'] as const
const groups = computed(() =>
  sessions.sessions.filter(
    (session) =>
      session.type === 'group' &&
      `${session.name} ${session.platform}`.toLowerCase().includes(groupSearch.value.trim().toLowerCase())
  )
)
const filtered = computed(() =>
  searchResult.value
    ? searchResult.value.matches.map((match) => match.item)
    : knowledgeOnly.value
      ? (data.value?.knowledge.map((candidate) => candidate.item) ?? [])
      : (data.value?.items.filter((item) => category.value === 'all' || item.category === category.value) ?? [])
)
const visible = computed(() =>
  searchResult.value || knowledgeOnly.value || savedOnly.value || showAll.value
    ? filtered.value
    : filtered.value.filter((item) => data.value?.highlights.includes(item.id))
)
function categoryCount(value: HotspotCategory | 'all') {
  return (
    data.value?.items.filter(
      (item) =>
        (value === 'all' || item.category === value) &&
        (savedOnly.value || showAll.value || data.value?.highlights.includes(item.id))
    ).length ?? 0
  )
}
function groupName(id: string) {
  return sessions.sessions.find((session) => session.id === id)?.name ?? id
}
function sourceGroups(item: Hotspot) {
  return [
    ...new Map(
      item.sources
        .filter((source) => data.value?.config.sessionIds.includes(source.sessionId))
        .map((source) => [source.sessionId, source])
    ).values(),
  ]
}
function reduceTopic(item: Hotspot) {
  return perform(() =>
    hotspotService.feedback(item.id, { topic: true, reduced: !data.value?.config.reducedTopics?.includes(item.topic) })
  )
}
function reduceGroup(item: Hotspot, sessionId: string) {
  return perform(() =>
    hotspotService.feedback(item.id, { sessionId, reduced: !data.value?.config.reducedSessionIds?.includes(sessionId) })
  )
}

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
  // Build the complete plain draft before assigning it to a ref (which makes nested values reactive).
  const next = JSON.parse(JSON.stringify(data.value?.config ?? draft.value)) as HotspotConfig
  next.categoryPriorities = Object.fromEntries(
    categories.filter((value) => value !== 'all').map((value) => [value, next.categoryPriorities?.[value] ?? 1])
  )
  next.budget = {
    ...(next.budget ?? {
      monthlyLimit: null,
      currency: 'CNY',
      modelId: '',
      inputPerMillion: null,
      outputPerMillion: null,
    }),
  }
  const modelId = data.value?.usage.modelId ?? ''
  if (next.budget.modelId !== modelId) {
    next.budget.inputPerMillion = null
    next.budget.outputPerMillion = null
  }
  next.budget.modelId = modelId
  draft.value = next
  void hotspotService
    .recommendations()
    .then((value) => {
      recommendations.value = value
    })
    .catch((cause) => {
      error.value = String(cause)
    })
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
    const cfg = structuredClone(JSON.parse(JSON.stringify(draft.value))) as HotspotConfig
    if (cfg.budget)
      for (const key of ['monthlyLimit', 'inputPerMillion', 'outputPerMillion'] as const) {
        const value = cfg.budget[key] as unknown
        cfg.budget[key] = value === '' || value === null ? null : Number(value)
      }
    await hotspotService.configure({ ...cfg, locale: locale.value })
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
  searchResult.value = null
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
  <SidePanelLayout class="h-full" style="padding-top: var(--titlebar-area-height)">
    <main class="h-full overflow-y-auto bg-page-bg text-gray-900 dark:bg-page-dark dark:text-gray-100">
      <div class="mx-auto max-w-3xl px-5 pb-12 pt-8 sm:px-6">
        <header
          class="flex flex-wrap items-start justify-between gap-4 border-b border-gray-200 pb-6 dark:border-gray-800"
        >
          <div>
            <div class="mb-2 flex items-center gap-2 text-sm text-primary-600 dark:text-primary-400">
              <UIcon name="i-lucide-radio" />
              {{ t('hotspots.eyebrow') }}
            </div>
            <h1 class="text-3xl font-semibold tracking-tight">{{ t('hotspots.title') }}</h1>
            <p class="mt-3 max-w-xl text-sm leading-6 text-gray-600 dark:text-gray-300">{{ t('hotspots.subtitle') }}</p>
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
            <UButton
              color="neutral"
              variant="ghost"
              :disabled="busy || loading || data?.status.running || !data?.config.sessionIds.length"
              :title="t('hotspots.rebuildHint')"
              @click="perform(() => hotspotService.update(true))"
            >
              {{ t('hotspots.rebuild') }}
            </UButton>
          </div>
        </header>
        <p v-if="IS_WEB_WASM" class="py-12 text-gray-500">{{ t('hotspots.nodeOnly') }}</p>
        <template v-else>
          <div
            v-if="data"
            class="flex flex-wrap gap-x-5 gap-y-2 py-4 text-sm leading-6 text-gray-600 dark:text-gray-300"
            aria-live="polite"
          >
            <button
              class="rounded text-primary-700 hover:underline focus-visible:outline-2 dark:text-primary-300"
              @click="openSettings"
            >
              {{ t('hotspots.selectedGroups', { count: data.config.sessionIds.length }) }}
            </button>
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
            <UButton v-if="error" color="neutral" variant="link" size="sm" @click="load()">
              {{ t('common.retry') }}
            </UButton>
          </div>
          <section
            v-if="usage"
            class="mb-4 border-y border-gray-200 py-3 text-sm text-gray-600 dark:border-gray-800 dark:text-gray-400"
          >
            <div class="flex flex-wrap items-center justify-between gap-3">
              <p>
                {{ t('hotspots.usageTitle', { month: usage.month }) }} · {{ money(usage.estimatedCost) }}
                <span v-if="usage.unpricedCalls || usage.uncertainCalls">
                  · {{ t('hotspots.partialCost', { count: usage.unpricedCalls, uncertain: usage.uncertainCalls }) }}
                </span>
                <span v-if="usage.monthlyLimit !== null">/ {{ money(usage.monthlyLimit) }}</span>
                · {{ t('hotspots.usageCalls', { count: usage.calls, tokens: usage.inputTokens + usage.outputTokens }) }}
              </p>
              <UButton
                size="sm"
                color="neutral"
                variant="ghost"
                :aria-expanded="showUsage"
                @click="showUsage = !showUsage"
              >
                {{ t('hotspots.usageDetails') }}
              </UButton>
            </div>
            <p class="mt-2">{{ t('hotspots.costEstimateHint') }}</p>
            <p v-if="usage.paused" role="alert" class="mt-2 text-red-600 dark:text-red-400">
              {{ t(`hotspots.budgetPaused.${usage.reason}`) }}
            </p>
            <p v-else-if="usage.nearLimit" class="mt-2 text-primary-600 dark:text-primary-400">
              {{ t('hotspots.nearBudget') }}
            </p>
            <div v-if="showUsage" class="mt-3 space-y-3">
              <p>{{ t('hotspots.unpricedUsage', { count: usage.unpricedCalls, uncertain: usage.uncertainCalls }) }}</p>
              <div v-for="group in usage.byGroup" :key="group.sessionId" class="flex justify-between gap-4">
                <span>{{ groupName(group.sessionId) }}</span>
                <span>{{ group.tokens }} token · {{ money(group.estimatedCost) }}</span>
              </div>
              <div v-if="usage.unpricedCalls || usage.uncertainCalls || usage.reason === 'uncertain'" class="space-y-2">
                <label class="block">
                  {{ t('hotspots.reconcileHint') }}
                  <input
                    v-model.number="reconciledAmount"
                    type="number"
                    min="0"
                    step="0.01"
                    class="ml-2 w-28 rounded border border-gray-300 bg-transparent p-2 dark:border-gray-700"
                  />
                </label>
                <UButton
                  size="sm"
                  color="neutral"
                  variant="outline"
                  :disabled="
                    busy || data?.status.running || typeof reconciledAmount !== 'number' || reconciledAmount < 0
                  "
                  @click="perform(() => hotspotService.reconcileUsage(Number(reconciledAmount)))"
                >
                  {{ t('hotspots.reconcile') }}
                </UButton>
              </div>
            </div>
          </section>
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
              @click="toggleSaved"
            >
              {{ t('hotspots.saved') }}
            </UButton>
          </div>
          <form class="mb-5 flex flex-wrap gap-2" @submit.prevent="searchTopics">
            <UInput
              v-model="query"
              :aria-label="t('hotspots.searchTopics')"
              :placeholder="t('hotspots.searchTopicsHint')"
              icon="i-lucide-search"
              class="min-w-48 flex-1"
              maxlength="500"
            />
            <UButton type="submit" :disabled="busy || data?.status.running || !query.trim()">
              {{ t('hotspots.searchTopics') }}
            </UButton>
            <UButton v-if="searchResult" color="neutral" variant="ghost" @click="clearSearch">
              {{ t('common.back') }}
            </UButton>
            <UButton
              color="neutral"
              :variant="knowledgeOnly ? 'soft' : 'ghost'"
              :aria-pressed="knowledgeOnly"
              @click="toggleKnowledge"
            >
              {{ t('hotspots.knowledgeCandidates', { count: data?.knowledge.length ?? 0 }) }}
            </UButton>
          </form>
          <p v-if="searchResult" class="mb-4 text-xs text-gray-600 dark:text-gray-300">
            {{ t('hotspots.searchCoverage', { count: searchResult.scanned }) }}
          </p>
          <section
            v-if="!searchResult && !knowledgeOnly && !savedOnly && data?.items.length"
            class="mb-6 border-l-2 border-primary-400 bg-primary-50/40 px-4 py-4 dark:bg-primary-400/5"
          >
            <div class="mb-3 flex items-center justify-between gap-3">
              <h2 class="text-base font-medium">{{ t(`hotspots.digestTitles.${window}`) }}</h2>
              <UButton
                size="sm"
                color="neutral"
                variant="ghost"
                :disabled="busy || data.status.running"
                @click="perform(() => hotspotService.summarize(window))"
              >
                {{ t(data.digest ? 'hotspots.refreshDigest' : 'hotspots.generateDigest') }}
              </UButton>
            </div>
            <p v-if="data.digest?.stale" class="mb-2 text-sm text-primary-600 dark:text-primary-400">
              {{ t('hotspots.digestStale') }}
            </p>
            <template v-if="data.digest">
              <p class="text-base leading-8">{{ data.digest.overview }}</p>
              <details v-for="(section, n) in data.digest.sections" :key="n" class="mt-3 text-sm">
                <summary class="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-primary-500">
                  {{ section.title }}
                </summary>
                <p class="mt-2 whitespace-pre-line leading-7 text-gray-600 dark:text-gray-300">{{ section.text }}</p>
                <div class="mt-1 flex flex-wrap gap-2">
                  <UButton
                    v-for="id in section.hotspotIds"
                    :key="id"
                    size="sm"
                    color="neutral"
                    variant="link"
                    @click="focusTopic(id)"
                  >
                    {{ data.items.find((item) => item.id === id)?.title }}
                  </UButton>
                </div>
              </details>
              <p class="mt-3 text-xs text-gray-600 dark:text-gray-300">
                {{ t('hotspots.digestCoverage') }} · {{ date(data.digest.generatedAt) }}
              </p>
            </template>
            <p v-else class="text-sm text-gray-600 dark:text-gray-300">{{ t('hotspots.digestHint') }}</p>
          </section>
          <div
            v-if="!searchResult && !knowledgeOnly"
            role="group"
            :aria-label="t('hotspots.categoryLabel')"
            class="mb-5 flex flex-wrap gap-2"
          >
            <UButton
              v-for="item in categories"
              :key="item"
              :color="category === item ? 'primary' : 'neutral'"
              :variant="category === item ? 'soft' : 'ghost'"
              :aria-pressed="category === item"
              size="sm"
              @click="category = item"
            >
              {{ t(`hotspots.categories.${item}`) }} · {{ categoryCount(item) }}
            </UButton>
          </div>
          <div
            v-if="data && !savedOnly && !searchResult && !knowledgeOnly"
            class="mb-2 flex items-center justify-between gap-3 text-xs text-gray-600 dark:text-gray-300"
          >
            <p>
              {{
                t(showAll ? 'hotspots.allHint' : 'hotspots.curatedHint', {
                  count: showAll ? filtered.length : data.highlights.length,
                })
              }}
            </p>
            <UButton size="sm" color="neutral" variant="ghost" :aria-pressed="showAll" @click="showAll = !showAll">
              {{ t(showAll ? 'hotspots.showCurated' : 'hotspots.showAll') }}
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
            <p class="mt-2 max-w-lg text-sm leading-6 text-gray-600 dark:text-gray-300">
              {{ t('hotspots.startHint') }}
            </p>
            <UButton class="mt-5" @click="openSettings">{{ t('hotspots.settings') }}</UButton>
          </div>
          <p v-else-if="!visible.length" class="py-14 text-sm text-gray-600 dark:text-gray-300">
            {{ t(data.status.running ? 'hotspots.firstRun' : 'hotspots.empty') }}
          </p>
          <ol v-else class="divide-y divide-gray-200 dark:divide-gray-800">
            <li v-for="(item, index) in visible" :key="item.id" class="py-5 sm:py-6">
              <article class="flex gap-3 sm:gap-4">
                <span class="pt-1 font-mono text-sm tabular-nums text-gray-400" aria-hidden="true">
                  {{ String(index + 1).padStart(2, '0') }}
                </span>
                <div class="min-w-0 flex-1">
                  <div class="mb-2 flex flex-wrap gap-3 text-xs text-gray-600 dark:text-gray-300">
                    <span :class="{ 'text-primary-600 dark:text-primary-400': item.category === 'ai' }">
                      {{ t(`hotspots.categories.${item.category}`) }}
                    </span>
                    <time>{{ date(item.updatedAt) }}</time>
                    <span v-if="item.activity !== 'new'" class="text-primary-600 dark:text-primary-400">
                      {{ t(`hotspots.activity.${item.activity}`) }}
                    </span>
                    <span v-if="item.kind === 'question'">{{ t('hotspots.unanswered') }}</span>
                    <span v-if="item.confidence === 'disputed'">{{ t('hotspots.disputed') }}</span>
                    <span v-if="item.confidence === 'rumor'">{{ t('hotspots.rumor') }}</span>
                    <span v-if="item.readAt">{{ t('hotspots.read') }}</span>
                  </div>
                  <p
                    v-if="searchResult?.matches.find((match) => match.item.id === item.id)?.reason"
                    class="mb-2 text-sm text-primary-600 dark:text-primary-400"
                  >
                    {{ searchResult.matches.find((match) => match.item.id === item.id)?.reason }}
                  </p>
                  <h2 class="text-lg font-semibold leading-7">{{ item.title }}</h2>
                  <p class="mt-2 whitespace-pre-line text-base leading-7 text-gray-800 dark:text-gray-200">
                    {{ item.summary }}
                  </p>
                  <p v-if="item.conclusion" class="mt-2 border-l-2 border-primary-400 pl-3 text-base leading-7">
                    <span class="font-medium">{{ t(`hotspots.outcomes.${item.outcome ?? 'open'}`) }} ·</span>
                    {{ item.conclusion }}
                  </p>
                  <p
                    v-if="knowledgeOnly && data?.knowledge.find((candidate) => candidate.id === item.id)?.exportedPath"
                    class="mt-2 break-all text-xs text-gray-600 dark:text-gray-300"
                  >
                    {{ t('hotspots.exported') }} ·
                    {{ data.knowledge.find((candidate) => candidate.id === item.id)?.exportedPath }}
                    <span v-if="data.knowledge.find((candidate) => candidate.id === item.id)?.changed">
                      {{ t('hotspots.knowledgeChanged') }}
                    </span>
                  </p>
                  <p v-if="item.why" class="mt-2 text-sm leading-6 text-gray-700 dark:text-gray-200">
                    {{ item.why }}
                  </p>
                  <p v-if="item.activity === 'renewed'" class="mt-2 text-xs leading-6 text-gray-600 dark:text-gray-300">
                    {{ t('hotspots.renewedHint') }}
                  </p>
                  <div class="mt-3 flex flex-wrap gap-1">
                    <UButton
                      v-if="candidateIds.has(item.id)"
                      size="sm"
                      variant="ghost"
                      color="neutral"
                      icon="i-lucide-notebook-pen"
                      :disabled="busy"
                      @click="prepareKnowledge(item)"
                    >
                      {{ t('hotspots.reviewKnowledge') }}
                    </UButton>
                    <UButton
                      size="sm"
                      variant="ghost"
                      color="neutral"
                      icon="i-lucide-messages-square"
                      :aria-expanded="expanded === item.id"
                      @click="expanded = expanded === item.id ? null : item.id"
                    >
                      {{ t('hotspots.sources', { count: item.sources.length }) }}
                    </UButton>
                    <UButton
                      size="sm"
                      variant="ghost"
                      color="neutral"
                      :disabled="busy"
                      :aria-pressed="!!item.readAt"
                      @click="mark(item, { read: !item.readAt })"
                    >
                      {{ t(item.readAt ? 'hotspots.unread' : 'hotspots.markRead') }}
                    </UButton>
                    <UButton
                      size="sm"
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
                      size="sm"
                      variant="ghost"
                      color="neutral"
                      :disabled="busy"
                      @click="mark(item, { dismissed: !item.dismissed })"
                    >
                      {{ t(item.dismissed ? 'hotspots.restore' : 'hotspots.dismiss') }}
                    </UButton>
                    <UButton size="sm" variant="ghost" color="neutral" :disabled="busy" @click="reduceTopic(item)">
                      {{
                        t(
                          data?.config.reducedTopics?.includes(item.topic)
                            ? 'hotspots.restoreTopic'
                            : 'hotspots.reduceTopic',
                          { topic: item.topic }
                        )
                      }}
                    </UButton>
                  </div>
                  <div
                    v-if="expanded === item.id"
                    class="mt-3 space-y-2 border-l-2 border-gray-200 pl-3 dark:border-gray-700"
                  >
                    <p class="text-xs text-gray-600 dark:text-gray-300">{{ t('hotspots.evidenceHint') }}</p>
                    <div class="flex flex-wrap gap-2">
                      <UButton
                        v-for="group in sourceGroups(item)"
                        :key="group.sessionId"
                        size="sm"
                        color="neutral"
                        variant="outline"
                        :disabled="busy"
                        @click="reduceGroup(item, group.sessionId)"
                      >
                        {{
                          t(
                            data?.config.reducedSessionIds?.includes(group.sessionId)
                              ? 'hotspots.restoreGroup'
                              : 'hotspots.reduceGroup',
                            { group: group.sessionName }
                          )
                        }}
                      </UButton>
                    </div>
                    <div
                      class="max-h-96 divide-y divide-gray-900/10 overflow-y-auto overscroll-contain dark:divide-white/10"
                    >
                      <button
                        v-for="evidence in item.sources"
                        :key="`${evidence.sessionId}:${evidence.messageId}`"
                        type="button"
                        class="group block w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-black/[0.035] active:bg-black/5 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-gray-500 dark:hover:bg-white/5 dark:active:bg-white/10 dark:focus-visible:outline-gray-400"
                        :aria-label="`${t('hotspots.viewMessage')} · ${evidence.sessionName} · ${date(evidence.timestamp)}`"
                        :title="t('hotspots.viewMessage')"
                        @click="source(evidence)"
                      >
                        <span class="flex items-start gap-2 text-[13px] leading-5 text-gray-600 dark:text-gray-300">
                          <span class="min-w-0 flex-1">
                            {{ evidence.sessionName }} · {{ date(evidence.timestamp) }}
                          </span>
                          <UIcon
                            name="i-lucide-arrow-up-right"
                            class="mt-0.5 size-4 shrink-0 text-gray-500 transition-colors group-hover:text-gray-800 dark:text-gray-400 dark:group-hover:text-gray-100"
                            aria-hidden="true"
                          />
                        </span>
                        <span
                          class="mt-0.5 block whitespace-pre-wrap break-words text-[15px] leading-6 text-gray-800 dark:text-gray-200"
                        >
                          {{ evidence.snippet }}
                        </span>
                      </button>
                    </div>
                    <div v-if="item.links.length" class="flex flex-col gap-2">
                      <a
                        v-for="link in item.links"
                        :key="link"
                        :href="link"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="break-all text-sm text-primary-600 hover:underline focus-visible:outline-2 dark:text-primary-400"
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
            <p class="text-xs text-gray-600 dark:text-gray-300">
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
            <fieldset class="space-y-3">
              <legend class="mb-3 text-sm font-medium">{{ t('hotspots.priorities') }}</legend>
              <label
                v-for="item in categories.filter((value) => value !== 'all')"
                :key="item"
                class="flex items-center justify-between gap-4 text-sm"
              >
                <span>{{ t(`hotspots.categories.${item}`) }}</span>
                <select
                  v-if="draft.categoryPriorities"
                  v-model.number="draft.categoryPriorities[item]"
                  class="rounded border border-gray-300 bg-page-bg px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-primary-500 dark:border-gray-700 dark:bg-page-dark"
                >
                  <option :value="0">{{ t('hotspots.priorityLow') }}</option>
                  <option :value="1">{{ t('hotspots.priorityNormal') }}</option>
                  <option :value="2">{{ t('hotspots.priorityHigh') }}</option>
                </select>
              </label>
            </fieldset>
            <div v-if="draft.reducedTopics?.length || draft.reducedSessionIds?.length" class="space-y-2">
              <p class="text-sm font-medium">{{ t('hotspots.feedbackSettings') }}</p>
              <p class="text-xs text-gray-600 dark:text-gray-300">{{ t('hotspots.feedbackHint') }}</p>
              <div class="flex flex-wrap gap-2">
                <UButton
                  v-for="topic in draft.reducedTopics"
                  :key="topic"
                  size="sm"
                  color="neutral"
                  variant="outline"
                  @click="draft.reducedTopics = draft.reducedTopics?.filter((value) => value !== topic)"
                >
                  {{ t('hotspots.restoreTopic', { topic }) }}
                </UButton>
                <UButton
                  v-for="id in draft.reducedSessionIds"
                  :key="id"
                  size="sm"
                  color="neutral"
                  variant="outline"
                  @click="draft.reducedSessionIds = draft.reducedSessionIds?.filter((value) => value !== id)"
                >
                  {{ t('hotspots.restoreGroup', { group: groupName(id) }) }}
                </UButton>
              </div>
            </div>
            <section v-if="recommendations.length" class="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-800">
              <h3 class="text-sm font-medium">{{ t('hotspots.groupRecommendations') }}</h3>
              <p class="text-xs text-gray-600 dark:text-gray-300">{{ t('hotspots.recommendationsHint') }}</p>
              <div v-for="group in recommendations" :key="group.sessionId" class="space-y-1 text-xs">
                <p class="font-medium">
                  {{ groupName(group.sessionId) }} · {{ t(`hotspots.recommendations.${group.recommendation}`) }}
                </p>
                <p class="text-gray-600 dark:text-gray-300">
                  {{
                    t('hotspots.recommendationEvidence', {
                      analyzed: group.analyzedMessages,
                      useful: group.usefulTopics,
                      topics: group.topics,
                      noise: group.noiseMessages,
                      repeats: group.repeatedSources,
                    })
                  }}
                </p>
                <UButton
                  v-if="group.recommendation !== 'insufficient'"
                  size="sm"
                  color="neutral"
                  variant="link"
                  @click="
                    draft.reducedSessionIds = draft.reducedSessionIds?.includes(group.sessionId)
                      ? draft.reducedSessionIds.filter((id) => id !== group.sessionId)
                      : [...(draft.reducedSessionIds ?? []), group.sessionId]
                  "
                >
                  {{
                    t(
                      draft.reducedSessionIds?.includes(group.sessionId)
                        ? 'hotspots.restoreGroup'
                        : 'hotspots.reduceGroup',
                      { group: groupName(group.sessionId) }
                    )
                  }}
                </UButton>
              </div>
            </section>
            <fieldset v-if="draft.budget" class="space-y-3 border-t border-gray-200 pt-4 text-sm dark:border-gray-800">
              <legend class="pt-4 font-medium">{{ t('hotspots.budgetTitle') }}</legend>
              <p class="text-xs text-gray-600 dark:text-gray-300">{{ t('hotspots.budgetHint') }}</p>
              <label class="flex items-center justify-between gap-4">
                {{ t('hotspots.monthlyLimit') }}
                <input
                  v-model.number="draft.budget.monthlyLimit"
                  type="number"
                  min="0"
                  step="0.01"
                  :placeholder="t('hotspots.unlimited')"
                  class="w-32 rounded border border-gray-300 bg-transparent p-2 dark:border-gray-700"
                />
              </label>
              <label class="flex items-center justify-between gap-4">
                {{ t('hotspots.currency') }}
                <select
                  v-model="draft.budget.currency"
                  class="rounded border border-gray-300 bg-page-bg p-2 dark:border-gray-700 dark:bg-page-dark"
                >
                  <option value="CNY">CNY</option>
                  <option value="USD">USD</option>
                </select>
              </label>
              <p class="break-all text-xs text-gray-600 dark:text-gray-300">
                {{ t('hotspots.pricedModel') }} · {{ draft.budget.modelId || t('hotspots.noModel') }}
              </p>
              <label class="flex items-center justify-between gap-4">
                {{ t('hotspots.inputPrice') }}
                <input
                  v-model.number="draft.budget.inputPerMillion"
                  type="number"
                  min="0"
                  step="0.01"
                  class="w-32 rounded border border-gray-300 bg-transparent p-2 dark:border-gray-700"
                />
              </label>
              <label class="flex items-center justify-between gap-4">
                {{ t('hotspots.outputPrice') }}
                <input
                  v-model.number="draft.budget.outputPerMillion"
                  type="number"
                  min="0"
                  step="0.01"
                  class="w-32 rounded border border-gray-300 bg-transparent p-2 dark:border-gray-700"
                />
              </label>
            </fieldset>
            <label class="block text-sm">
              <span class="mb-2 block">{{ t('hotspots.obsidianVault') }}</span>
              <input
                v-model="draft.obsidianVault"
                type="text"
                :placeholder="t('hotspots.obsidianVaultHint')"
                class="w-full rounded border border-gray-300 bg-transparent p-2 dark:border-gray-700"
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
      <UModal
        v-model:open="knowledgeOpen"
        :title="t('hotspots.reviewKnowledge')"
        :description="t('hotspots.knowledgeReviewHint')"
        :ui="{ content: 'sm:max-w-3xl' }"
      >
        <template #body>
          <div v-if="knowledgeDraft" class="space-y-3">
            <label class="block text-sm">
              <span class="mb-2 block">{{ t('hotspots.knowledgeDraft') }}</span>
              <textarea
                v-model="knowledgeDraft.content"
                rows="18"
                class="w-full rounded border border-gray-300 bg-transparent p-3 font-mono text-xs leading-6 focus-visible:outline-2 focus-visible:outline-primary-500 dark:border-gray-700"
              />
            </label>
            <p v-if="!data?.config.obsidianVault" class="text-sm text-gray-600 dark:text-gray-300">
              {{ t('hotspots.configureVaultFirst') }}
            </p>
            <a
              v-if="exportResult"
              :href="exportResult.uri"
              target="_blank"
              rel="noopener noreferrer"
              class="block break-all text-sm text-primary-600 hover:underline dark:text-primary-400"
            >
              {{ t('hotspots.openNote') }} · {{ exportResult.path }}
            </a>
            <p v-if="error" role="alert" class="text-sm text-red-600 dark:text-red-400">{{ error }}</p>
          </div>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="knowledgeDraft = null">{{ t('common.cancel') }}</UButton>
            <UButton
              :disabled="busy || !data?.config.obsidianVault || !knowledgeDraft?.content.trim()"
              @click="approveKnowledge"
            >
              {{ t('hotspots.approveKnowledge') }}
            </UButton>
          </div>
        </template>
      </UModal>
    </main>
  </SidePanelLayout>
</template>
