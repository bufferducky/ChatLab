<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  priceWatchService,
  type PriceChannel,
  type PriceChannelType,
  type PriceHit,
  type PriceRule,
  type ScanResult,
} from '@/services/price-watch'

const { t, locale } = useI18n()
const tab = ref<'rules' | 'hits' | 'channels'>('rules')
const rules = ref<PriceRule[]>([])
const channels = ref<PriceChannel[]>([])
const hits = ref<PriceHit[]>([])
const sessions = ref<Array<{ id: string; name: string }>>([])
const error = ref('')
const notice = ref('')
const busy = ref(false)

const draft = ref({
  id: '',
  name: '',
  keywords: '',
  excludeKeywords: '',
  sessionIds: [] as string[],
  maxPrice: '',
  cooldownMinutes: 720,
  channelIds: [] as string[],
  enabled: true,
})
const editing = ref(false)
const channelDraft = ref({
  id: '',
  name: '',
  type: 'webhook' as PriceChannelType,
  url: '',
  chatId: '',
})
const editingChannel = ref(false)

const canSaveRule = computed(() => draft.value.name.trim().length > 0 && draft.value.keywords.trim().length > 0)

function formatPrice(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString(locale.value === 'zh-CN' ? 'zh-CN' : undefined)
}

function hitSummary(hit: PriceHit): { rule: string; text: string; samples: number } {
  try {
    const payload = JSON.parse(hit.payload)
    return { rule: payload.ruleName ?? '', text: payload.sourceText ?? '', samples: payload.history?.samples ?? 0 }
  } catch {
    return { rule: '', text: '', samples: 0 }
  }
}

async function load(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const [ruleResult, channelResult, hitResult, sessionResult] = await Promise.all([
      priceWatchService.listRules(),
      priceWatchService.listChannels(),
      priceWatchService.listHits(100),
      priceWatchService.listSessions(),
    ])
    rules.value = ruleResult.rules
    channels.value = channelResult.channels
    hits.value = hitResult.hits
    sessions.value = sessionResult.sessions
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

function startCreate(): void {
  draft.value = {
    id: '',
    name: '',
    keywords: '',
    excludeKeywords: '',
    sessionIds: [],
    maxPrice: '',
    cooldownMinutes: 720,
    channelIds: channels.value[0] ? [channels.value[0].id] : [],
    enabled: true,
  }
  editing.value = true
}

function startEdit(rule: PriceRule): void {
  draft.value = {
    id: rule.id,
    name: rule.name,
    keywords: rule.keywords.join(' '),
    excludeKeywords: rule.excludeKeywords.join(' '),
    sessionIds: [...rule.sessionIds],
    maxPrice: rule.maxPrice === null ? '' : String(rule.maxPrice),
    cooldownMinutes: rule.cooldownMinutes,
    channelIds: [...rule.channelIds],
    enabled: rule.enabled,
  }
  editing.value = true
}

async function saveRule(): Promise<void> {
  if (!canSaveRule.value) return
  busy.value = true
  error.value = ''
  try {
    const split = (value: string) =>
      value
        .split(/[\s,，]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    await priceWatchService.saveRule(
      {
        name: draft.value.name.trim(),
        keywords: split(draft.value.keywords),
        excludeKeywords: split(draft.value.excludeKeywords),
        sessionIds: draft.value.sessionIds,
        maxPrice: draft.value.maxPrice.trim() === '' ? null : Number(draft.value.maxPrice),
        cooldownMinutes: draft.value.cooldownMinutes,
        channelIds: draft.value.channelIds,
        enabled: draft.value.enabled,
      },
      draft.value.id || undefined
    )
    editing.value = false
    notice.value = t('priceWatch.saved')
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

async function removeRule(rule: PriceRule): Promise<void> {
  if (!window.confirm(t('priceWatch.confirmDeleteRule', { name: rule.name }))) return
  await priceWatchService.deleteRule(rule.id)
  await load()
}

async function saveChannel(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await priceWatchService.saveChannel(
      {
        name: channelDraft.value.name || channelDraft.value.type,
        type: channelDraft.value.type,
        url: channelDraft.value.url.trim(),
        chatId: channelDraft.value.chatId.trim(),
        enabled: true,
      },
      channelDraft.value.id || undefined
    )
    editingChannel.value = false
    channelDraft.value = { id: '', name: '', type: 'webhook', url: '', chatId: '' }
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

async function removeChannel(channel: PriceChannel): Promise<void> {
  if (!window.confirm(t('priceWatch.confirmDeleteChannel', { name: channel.name }))) return
  await priceWatchService.deleteChannel(channel.id)
  await load()
}

async function runScan(rule: PriceRule): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const results: ScanResult[] = []
    for (const sessionId of rule.sessionIds) {
      results.push(await priceWatchService.scan(sessionId))
    }
    const hitCount = results.reduce((sum, item) => sum + item.hits, 0)
    notice.value = t('priceWatch.scanDone', { hits: hitCount })
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

async function runBackfill(rule: PriceRule): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    let total = 0
    for (const sessionId of rule.sessionIds) {
      const result = await priceWatchService.backfill(sessionId, 30)
      total += result.observations
    }
    notice.value = t('priceWatch.backfillDone', { count: total })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

async function resend(hit: PriceHit): Promise<void> {
  busy.value = true
  try {
    await priceWatchService.resend(hit.id)
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="mx-auto max-w-4xl px-6 py-8">
    <header class="mb-6">
      <h1 class="text-xl font-semibold">{{ t('priceWatch.title') }}</h1>
      <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">{{ t('priceWatch.subtitle') }}</p>
    </header>

    <div class="mb-4 flex gap-2">
      <button
        v-for="item in ['rules', 'hits', 'channels']"
        :key="item"
        class="rounded-md px-3 py-1.5 text-sm"
        :class="
          tab === item
            ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
            : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'
        "
        @click="tab = item as typeof tab"
      >
        {{ t(`priceWatch.tabs.${item}`) }}
      </button>
      <div class="flex-1" />
      <button v-if="tab === 'rules'" class="rounded-md border px-3 py-1.5 text-sm" @click="startCreate">
        {{ t('priceWatch.newRule') }}
      </button>
      <button v-if="tab === 'channels'" class="rounded-md border px-3 py-1.5 text-sm" @click="editingChannel = true">
        {{ t('priceWatch.newChannel') }}
      </button>
    </div>

    <p v-if="error" class="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
      {{ error }}
    </p>
    <p
      v-if="notice"
      class="mb-3 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300"
    >
      {{ notice }}
    </p>

    <section v-if="editing" class="mb-6 rounded-lg border p-4">
      <h2 class="mb-3 text-sm font-medium">{{ draft.id ? t('priceWatch.editRule') : t('priceWatch.newRule') }}</h2>
      <div class="grid gap-3">
        <label class="grid gap-1 text-sm">
          <span>{{ t('priceWatch.fields.name') }}</span>
          <input
            v-model="draft.name"
            class="rounded-md border px-2 py-1.5"
            :placeholder="t('priceWatch.placeholders.name')"
          />
        </label>
        <label class="grid gap-1 text-sm">
          <span>{{ t('priceWatch.fields.keywords') }}</span>
          <input
            v-model="draft.keywords"
            class="rounded-md border px-2 py-1.5"
            :placeholder="t('priceWatch.placeholders.keywords')"
          />
        </label>
        <label class="grid gap-1 text-sm">
          <span>{{ t('priceWatch.fields.excludeKeywords') }}</span>
          <input
            v-model="draft.excludeKeywords"
            class="rounded-md border px-2 py-1.5"
            :placeholder="t('priceWatch.placeholders.excludeKeywords')"
          />
        </label>
        <label class="grid gap-1 text-sm">
          <span>{{ t('priceWatch.fields.maxPrice') }}</span>
          <input
            v-model="draft.maxPrice"
            type="number"
            class="rounded-md border px-2 py-1.5"
            :placeholder="t('priceWatch.placeholders.maxPrice')"
          />
        </label>
        <div class="grid gap-1 text-sm">
          <span>{{ t('priceWatch.fields.sessions') }}</span>
          <div class="max-h-40 overflow-y-auto rounded-md border p-2">
            <label v-for="session in sessions" :key="session.id" class="flex items-center gap-2 py-0.5">
              <input v-model="draft.sessionIds" type="checkbox" :value="session.id" />
              <span class="truncate">{{ session.name }}</span>
            </label>
          </div>
        </div>
        <div class="grid gap-1 text-sm">
          <span>{{ t('priceWatch.fields.channels') }}</span>
          <div class="flex flex-wrap gap-3 rounded-md border p-2">
            <label v-for="channel in channels" :key="channel.id" class="flex items-center gap-2">
              <input v-model="draft.channelIds" type="checkbox" :value="channel.id" />
              <span>{{ channel.name }}</span>
            </label>
            <span v-if="channels.length === 0" class="text-gray-500">{{ t('priceWatch.noChannels') }}</span>
          </div>
        </div>
        <div class="flex gap-2">
          <button
            class="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white dark:bg-gray-100 dark:text-gray-900"
            :disabled="!canSaveRule || busy"
            @click="saveRule"
          >
            {{ t('priceWatch.save') }}
          </button>
          <button class="rounded-md border px-3 py-1.5 text-sm" @click="editing = false">
            {{ t('priceWatch.cancel') }}
          </button>
        </div>
      </div>
    </section>

    <section v-if="tab === 'rules'">
      <p v-if="rules.length === 0" class="text-sm text-gray-500">{{ t('priceWatch.emptyRules') }}</p>
      <article v-for="rule in rules" :key="rule.id" class="mb-3 rounded-lg border p-4">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="truncate text-sm font-medium">{{ rule.name }}</h3>
            <p class="mt-1 text-xs text-gray-500">
              {{ t('priceWatch.ruleSummary', { keywords: rule.keywords.join(' / '), price: rule.maxPrice ?? '—' }) }}
            </p>
            <p class="mt-1 text-xs text-gray-500">
              {{ t('priceWatch.ruleSessions', { count: rule.sessionIds.length }) }} ·
              {{ rule.enabled ? t('priceWatch.enabled') : t('priceWatch.disabled') }}
            </p>
          </div>
          <div class="flex shrink-0 gap-2 text-xs">
            <button class="rounded border px-2 py-1" @click="startEdit(rule)">{{ t('priceWatch.edit') }}</button>
            <button class="rounded border px-2 py-1" :disabled="busy" @click="runScan(rule)">
              {{ t('priceWatch.scan') }}
            </button>
            <button class="rounded border px-2 py-1" :disabled="busy" @click="runBackfill(rule)">
              {{ t('priceWatch.backfill') }}
            </button>
            <button class="rounded border px-2 py-1 text-red-600" @click="removeRule(rule)">
              {{ t('priceWatch.delete') }}
            </button>
          </div>
        </div>
      </article>
    </section>

    <section v-if="tab === 'hits'">
      <p v-if="hits.length === 0" class="text-sm text-gray-500">{{ t('priceWatch.emptyHits') }}</p>
      <article v-for="hit in hits" :key="hit.id" class="mb-3 rounded-lg border p-4">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="text-sm font-medium">
              ¥{{ formatPrice(hit.finalPrice) }}
              <span class="ml-2 text-xs text-gray-500">{{ hitSummary(hit).rule }}</span>
            </h3>
            <p class="mt-1 truncate text-xs text-gray-500">{{ hitSummary(hit).text }}</p>
            <p class="mt-1 text-xs text-gray-500">
              {{ formatTime(hit.createdAt) }} · {{ t(`priceWatch.hitStatus.${hit.status}`) }}
              <template v-if="hitSummary(hit).samples > 0">
                · {{ t('priceWatch.hitSamples', { count: hitSummary(hit).samples }) }}
              </template>
            </p>
          </div>
          <button class="shrink-0 rounded border px-2 py-1 text-xs" :disabled="busy" @click="resend(hit)">
            {{ t('priceWatch.resend') }}
          </button>
        </div>
      </article>
    </section>

    <section v-if="tab === 'channels'">
      <p v-if="channels.length === 0" class="text-sm text-gray-500">{{ t('priceWatch.emptyChannels') }}</p>
      <article v-for="channel in channels" :key="channel.id" class="mb-3 rounded-lg border p-4">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <h3 class="text-sm font-medium">{{ channel.name }}</h3>
            <p class="mt-1 truncate text-xs text-gray-500">
              {{ channel.type }} · {{ channel.type === 'telegram' ? channel.chatId : channel.url }}
            </p>
          </div>
          <button class="shrink-0 rounded border px-2 py-1 text-xs text-red-600" @click="removeChannel(channel)">
            {{ t('priceWatch.delete') }}
          </button>
        </div>
      </article>

      <section v-if="editingChannel" class="rounded-lg border p-4">
        <div class="grid gap-3">
          <label class="grid gap-1 text-sm">
            <span>{{ t('priceWatch.fields.channelName') }}</span>
            <input v-model="channelDraft.name" class="rounded-md border px-2 py-1.5" />
          </label>
          <label class="grid gap-1 text-sm">
            <span>{{ t('priceWatch.fields.channelType') }}</span>
            <select v-model="channelDraft.type" class="rounded-md border px-2 py-1.5">
              <option value="webhook">{{ t('priceWatch.channelType.webhook') }}</option>
              <option value="telegram">{{ t('priceWatch.channelType.telegram') }}</option>
            </select>
          </label>
          <label class="grid gap-1 text-sm">
            <span>
              {{
                channelDraft.type === 'telegram' ? t('priceWatch.fields.botToken') : t('priceWatch.fields.webhookUrl')
              }}
            </span>
            <input v-model="channelDraft.url" class="rounded-md border px-2 py-1.5" />
          </label>
          <label v-if="channelDraft.type === 'telegram'" class="grid gap-1 text-sm">
            <span>{{ t('priceWatch.fields.chatId') }}</span>
            <input v-model="channelDraft.chatId" class="rounded-md border px-2 py-1.5" />
          </label>
          <div class="flex gap-2">
            <button
              class="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white dark:bg-gray-100 dark:text-gray-900"
              :disabled="busy"
              @click="saveChannel"
            >
              {{ t('priceWatch.save') }}
            </button>
            <button class="rounded-md border px-3 py-1.5 text-sm" @click="editingChannel = false">
              {{ t('priceWatch.cancel') }}
            </button>
          </div>
        </div>
      </section>
    </section>
  </div>
</template>
