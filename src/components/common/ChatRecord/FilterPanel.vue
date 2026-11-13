<script setup lang="ts">
/**
 * 聊天记录筛选面板
 * 支持消息ID、成员、时间范围、关键词的组合筛选
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { DatePicker } from '@/components/UI'
import MemberSearchSelect from '@/components/common/member/MemberSearchSelect.vue'
import type { ChatRecordQuery, FilterFormData } from './types'

const { t } = useI18n()

const props = defineProps<{
  /** 当前查询条件 */
  query: ChatRecordQuery
  /** 当前会话 ID，用于分页搜索成员 */
  sessionId?: string
}>()

const emit = defineEmits<{
  /** 应用筛选 */
  (e: 'apply', query: ChatRecordQuery): void
  /** 重置筛选 */
  (e: 'reset'): void
}>()

const advancedOpen = ref(false)
const appliedConditions = computed(() => {
  const query = props.query
  const conditions: string[] = []
  if (query.scrollToMessageId) conditions.push(`${t('records.filter.messageId')}: ${query.scrollToMessageId}`)
  if (query.memberId != null)
    conditions.push(`${t('records.filter.memberPlaceholder')}: ${query.memberName || query.memberId}`)
  if (query.keywords?.length) conditions.push(query.keywords.join(', '))
  if (query.startTs)
    conditions.push(`${t('records.filter.startDate')}: ${dayjs.unix(query.startTs).format('YYYY-MM-DD')}`)
  if (query.endTs) conditions.push(`${t('records.filter.endDate')}: ${dayjs.unix(query.endTs).format('YYYY-MM-DD')}`)
  return conditions
})

// 本地表单数据
const formData = ref<FilterFormData>({
  messageId: '',
  memberId: null,
  memberName: '',
  keywords: '',
  startDate: '',
  endDate: '',
})

// 同步外部 query 到表单
watch(
  () => props.query,
  (query) => {
    if (query) {
      formData.value = {
        messageId: query.scrollToMessageId?.toString() || '',
        memberId: query.memberId ?? null,
        memberName: query.memberName || '',
        keywords: query.keywords?.join(', ') || '',
        startDate: query.startTs ? dayjs.unix(query.startTs).format('YYYY-MM-DD') : '',
        endDate: query.endTs ? dayjs.unix(query.endTs).format('YYYY-MM-DD') : '',
      }
    }
  },
  { immediate: true }
)

// 应用筛选
function applyFilter() {
  const f = formData.value
  const query: ChatRecordQuery = {}

  // 关键词和消息 ID 互斥：如果有关键词，则清空消息 ID
  const hasKeywords = f.keywords && f.keywords.trim()

  // 消息 ID（只有在没有关键词时才使用）
  if (f.messageId && !hasKeywords) {
    const id = parseInt(f.messageId, 10)
    if (!isNaN(id)) {
      query.scrollToMessageId = id
    }
  }

  // 成员筛选可与关键词、时间范围组合使用。
  if (f.memberId !== null) {
    query.memberId = f.memberId
    query.memberName = f.memberName
  }

  // 关键词
  if (hasKeywords) {
    const keywords = f.keywords
      .split(/[,，]/)
      .map((k) => k.trim())
      .filter((k) => k)
    if (keywords.length > 0) {
      query.keywords = keywords
      query.highlightKeywords = keywords
      // 清空消息 ID（互斥）
      formData.value.messageId = ''
    }
  }

  // 时间范围
  if (f.startDate) {
    query.startTs = dayjs(f.startDate).startOf('day').unix()
  }
  if (f.endDate) {
    query.endTs = dayjs(f.endDate).endOf('day').unix()
  }

  emit('apply', query)
  advancedOpen.value = false
}

// 回车搜索
function handleKeywordsKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault()
    applyFilter()
  }
}

// 重置筛选
function resetFilter() {
  formData.value = {
    messageId: '',
    memberId: null,
    memberName: '',
    keywords: '',
    startDate: '',
    endDate: '',
  }
  emit('reset')
}
</script>

<template>
  <div class="shrink-0 border-b border-chat-divider bg-session-bg px-4 py-2 dark:border-white/5 dark:bg-chat-dark">
    <div class="flex min-w-0 items-center gap-2">
      <UInput
        v-model="formData.keywords"
        :ui="{
          base: 'bg-chat-control ring-0 dark:bg-chat-bubble-dark focus-visible:ring-2 focus-visible:ring-primary-500',
        }"
        icon="i-heroicons-magnifying-glass"
        :placeholder="t('records.filter.keywordsPlaceholder')"
        :aria-label="t('records.filter.keywordsPlaceholder')"
        size="sm"
        class="min-w-0 flex-1"
        @keydown="handleKeywordsKeydown"
      />
      <UButton
        icon="i-heroicons-magnifying-glass"
        color="neutral"
        variant="ghost"
        size="sm"
        :aria-label="t('layout.tooltip.search')"
        @click="applyFilter"
      />
      <UPopover
        v-model:open="advancedOpen"
        :content="{ align: 'end' }"
        :ui="{ content: 'z-50 w-80 max-w-[calc(100vw-2rem)] p-4' }"
      >
        <UButton
          icon="i-lucide-sliders-horizontal"
          color="neutral"
          variant="ghost"
          size="sm"
          :aria-label="t('records.filter.filter')"
        >
          {{ t('records.filter.filter') }}
          <span
            v-if="appliedConditions.length"
            class="flex size-4 items-center justify-center rounded-full bg-primary-100 text-[10px] text-primary-700 dark:bg-primary-900 dark:text-primary-200"
          >
            {{ appliedConditions.length }}
          </span>
        </UButton>
        <template #content>
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-sm font-medium">{{ t('records.filter.filter') }}</h2>
            <UButton
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              size="xs"
              :aria-label="t('common.close')"
              @click="advancedOpen = false"
            />
          </div>
          <div class="space-y-3">
            <label class="block space-y-1 text-xs text-gray-600 dark:text-gray-300">
              <span>{{ t('records.filter.messageId') }}</span>
              <UInput
                v-model="formData.messageId"
                type="number"
                :placeholder="t('records.filter.messageId')"
                class="w-full"
                size="sm"
                @keydown.enter="applyFilter"
              />
            </label>
            <label class="block space-y-1 text-xs text-gray-600 dark:text-gray-300">
              <span>{{ t('records.filter.memberPlaceholder') }}</span>
              <MemberSearchSelect
                v-model="formData.memberId"
                v-model:member-name="formData.memberName"
                :session-id="sessionId"
                :placeholder="t('records.filter.memberPlaceholder')"
                width-class="w-full"
                @select="applyFilter"
                @clear="applyFilter"
              />
            </label>
            <div class="flex items-center gap-2">
              <div class="min-w-0 flex-1 space-y-1">
                <p class="text-xs text-gray-600 dark:text-gray-300">{{ t('records.filter.startDate') }}</p>
                <DatePicker
                  v-model="formData.startDate"
                  :placeholder="t('records.filter.startDate')"
                  width-class="w-full"
                />
              </div>
              <div class="min-w-0 flex-1 space-y-1">
                <p class="text-xs text-gray-600 dark:text-gray-300">{{ t('records.filter.endDate') }}</p>
                <DatePicker
                  v-model="formData.endDate"
                  :placeholder="t('records.filter.endDate')"
                  width-class="w-full"
                />
              </div>
            </div>
          </div>
          <div class="mt-4 flex justify-end gap-2">
            <UButton color="neutral" variant="ghost" size="sm" @click="resetFilter">
              {{ t('records.filter.reset') }}
            </UButton>
            <UButton size="sm" @click="applyFilter">{{ t('records.filter.filter') }}</UButton>
          </div>
        </template>
      </UPopover>
    </div>
    <div v-if="appliedConditions.length" class="mt-2 flex flex-wrap items-center gap-1.5" aria-live="polite">
      <span
        v-for="condition in appliedConditions"
        :key="condition"
        class="max-w-full truncate rounded bg-primary-50 px-2 py-0.5 text-[11px] text-primary-700 dark:bg-primary-950 dark:text-primary-200"
        :title="condition"
      >
        {{ condition }}
      </span>
      <UButton color="neutral" variant="link" size="xs" @click="resetFilter">{{ t('records.filter.reset') }}</UButton>
    </div>
  </div>
</template>
