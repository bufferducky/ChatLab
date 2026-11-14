<script setup lang="ts">
/**
 * 消息列表组件
 * 使用 @tanstack/vue-virtual 实现虚拟滚动
 */
import { ref, watch, nextTick, toRaw, computed, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useVirtualizer } from '@tanstack/vue-virtual'
import dayjs from 'dayjs'
import MessageItem from './MessageItem.vue'
import { chatTopicColorStyle, isMessageInChatTopicHighlight, type ChatTopicHighlight } from './topic-highlight'
import type { ChatRecordMessage, ChatRecordQuery } from './types'
import { useSessionStore } from '@/stores/session'
import { useMessageService } from '@/services'
import { resolveChatRecordSessionId } from './query-session'
import { getSenderColor, isSenderContinuation } from './sender-presentation'

// 时间分隔阈值（秒）：消息间隔超过此值则显示时间分隔线
const TIME_SEPARATOR_THRESHOLD = 5 * 60 // 5 分钟

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    /** 当前查询条件 */
    query: ChatRecordQuery
    /** 外部传入的消息列表（可选，传入后不自动加载） */
    externalMessages?: ChatRecordMessage[]
    /** 外部传入时需要高亮的消息 ID 列表（命中的消息） */
    hitMessageIds?: number[]
    /** 由话题卡片选中的完整消息归属；旧快照按时间范围兼容 */
    highlightTopic?: ChatTopicHighlight | null
    /** 外部消息变化时的滚动行为：top=滚动到顶部，preserve=保持当前位置 */
    externalScrollBehavior?: 'top' | 'preserve'
  }>(),
  {
    externalMessages: undefined,
    hitMessageIds: () => [],
    highlightTopic: null,
    externalScrollBehavior: 'top',
  }
)

const emit = defineEmits<{
  /** 消息数量变化 */
  (e: 'count-change', count: number): void
  /** 当前可见消息变化（用于联动时间线） */
  (e: 'visible-message-change', payload: { id: number; timestamp: number }): void
  /** 跳转到指定消息（用于查看上下文） */
  (e: 'jump-to-message', messageId: number): void
  /** 滚动到底部（外部模式专用，用于加载下一个块） */
  (e: 'reach-bottom'): void
  /** 滚动到顶部（外部模式专用，用于加载上一个块） */
  (e: 'reach-top'): void
  /** 消息时间戳列表变化（用于联动会话时间线筛选） */
  (e: 'message-timestamps-change', timestamps: number[]): void
}>()

const sessionStore = useSessionStore()
const effectiveSessionId = computed(() => resolveChatRecordSessionId(props.query, sessionStore.currentSessionId))
const focusedSender = ref<{ id: string; name: string } | null>(null)
const focusedMessageId = ref<number | null>(null)
const navigationMessageId = ref<number | null>(null)
let navigationHighlightTimer: ReturnType<typeof setTimeout> | null = null
const focusedSenderColor = computed(() =>
  getSenderColor(sessionStore.currentSession?.platform ?? '', focusedSender.value?.id ?? '')
)

function toggleSenderFocus(message: ChatRecordMessage) {
  if (!message.senderPlatformId) return
  focusedSender.value =
    focusedSender.value?.id === message.senderPlatformId
      ? null
      : { id: message.senderPlatformId, name: message.senderName }
  focusedMessageId.value = focusedSender.value ? message.id : null
}

function clearSenderFocus() {
  focusedSender.value = null
  focusedMessageId.value = null
}

watch(effectiveSessionId, () => {
  clearSenderFocus()
  clearNavigationHighlight()
})

// 判断是否使用外部传入的消息
const isExternalMode = computed(() => !!props.externalMessages?.length)

// 判断是否处于筛选模式（有筛选条件且消息不连贯时显示上下文按钮）
// 注意：通过消息 ID 定位时上下文是连贯的，不需要显示
// 外部模式下不显示上下文按钮（数据已经处理好）
const isFiltered = computed(() => {
  if (isExternalMode.value) return false
  const q = props.query
  // 只有关键词、成员筛选时才需要显示上下文按钮
  return !!(q.memberId || q.keywords?.length)
})

// 消息列表
const messages = ref<ChatRecordMessage[]>([])
const focusedMessages = computed(() =>
  focusedSender.value ? messages.value.filter((message) => message.senderPlatformId === focusedSender.value!.id) : []
)
const focusedMessagePosition = computed(() =>
  focusedMessages.value.findIndex((message) => message.id === focusedMessageId.value)
)
const highlightedTopicMessageIds = computed(() => new Set(props.highlightTopic?.messageIds ?? []))
const isLoading = ref(false)
const isLoadingMore = ref(false)
const hasMoreBefore = ref(false)
const hasMoreAfter = ref(false)

// 搜索模式相关状态
const isSearchMode = ref(false)
const searchOffset = ref(0)

// 滚动容器引用
const scrollContainerRef = ref<HTMLElement | null>(null)

// 待滚动到的目标消息 ID（用于初始加载后定位）
const pendingScrollToId = ref<number | null>(null)

// 估算的消息高度（用于虚拟滚动初始化）
const ESTIMATED_MESSAGE_HEIGHT = 80

// 虚拟化器实例
const virtualizer = useVirtualizer(
  computed(() => ({
    count: messages.value.length,
    getScrollElement: () => scrollContainerRef.value,
    estimateSize: () => ESTIMATED_MESSAGE_HEIGHT,
    overscan: 10, // 额外渲染的项目数（上下各 10 个）
    getItemKey: (index: number) => messages.value[index]?.id ?? index,
  }))
)

// 虚拟化后的消息项
const virtualItems = computed(() => virtualizer.value.getVirtualItems())

// 总高度（用于滚动容器的占位）
const totalSize = computed(() => virtualizer.value.getTotalSize())

// 构建筛选参数
function buildFilterParams(query: ChatRecordQuery) {
  return {
    filter: query.startTs || query.endTs ? { startTs: query.startTs, endTs: query.endTs } : undefined,
    senderId: query.memberId,
    keywords: query.keywords ? [...toRaw(query.keywords)] : undefined,
  }
}

// 映射消息类型（补充缺失字段）
function mapMessages(messages: any[]): ChatRecordMessage[] {
  return messages.map((m) => ({
    ...m,
    replyToMessageId: m.replyToMessageId ?? null,
    replyToContent: m.replyToContent ?? null,
    replyToSenderName: m.replyToSenderName ?? null,
  })) as ChatRecordMessage[]
}

// 记录上一次消息数量（用于判断是扩展还是替换）
let previousExternalMessageCount = 0

// 初始加载消息
async function loadInitialMessages() {
  clearNavigationHighlight()
  // 外部模式：直接使用外部消息
  if (isExternalMode.value) {
    const currentCount = props.externalMessages!.length
    const isExpanding = previousExternalMessageCount > 0 && currentCount > previousExternalMessageCount

    messages.value = props.externalMessages!
    hasMoreBefore.value = false
    hasMoreAfter.value = false
    isSearchMode.value = false
    emit('count-change', messages.value.length)

    previousExternalMessageCount = currentCount

    await nextTick()

    // 根据滚动行为 prop 和是否是扩展来决定滚动位置
    if (props.externalScrollBehavior === 'preserve' && isExpanding) {
      // 保持当前位置（不做任何滚动操作）
    } else {
      scrollToTop()
    }
    return
  }

  const sessionId = effectiveSessionId.value
  if (!sessionId) {
    messages.value = []
    emit('count-change', 0)
    return
  }

  isLoading.value = true
  messages.value = []
  pendingScrollToId.value = null

  try {
    const query = toRaw(props.query)
    const { filter, senderId, keywords } = buildFilterParams(query)
    const targetId = query.scrollToMessageId

    if (targetId) {
      // 以目标消息为中心，加载前后各 50 条
      const messageService = useMessageService()
      const [beforeResult, afterResult] = await Promise.all([
        messageService.getMessagesBefore(sessionId, targetId, 50, filter, senderId, keywords),
        messageService.getMessagesAfter(sessionId, targetId, 50, filter, senderId, keywords),
      ])

      // 获取目标消息本身
      const targetMessages = await messageService.getMessageContext(sessionId, targetId, 0)

      // 合并消息列表
      messages.value = mapMessages([...beforeResult.messages, ...targetMessages, ...afterResult.messages])

      hasMoreBefore.value = beforeResult.hasMore
      hasMoreAfter.value = afterResult.hasMore

      // 设置待滚动的目标
      pendingScrollToId.value = targetId
    } else if ((keywords && keywords.length > 0) || senderId != null) {
      // 有关键词或成员筛选时，统一走搜索分页；底层支持空关键词 + senderId。
      isSearchMode.value = true
      searchOffset.value = 0
      const result = await useMessageService().searchMessages(sessionId, keywords ?? [], filter, 100, 0, senderId)
      messages.value = mapMessages(result.messages)
      hasMoreBefore.value = false // 搜索结果从最新开始，没有更早的
      searchOffset.value = result.messages.length
      hasMoreAfter.value = searchOffset.value < result.total

      // 滚动到顶部
      await nextTick()
      scrollToTop()
    } else {
      // 没有目标消息和关键词，加载最新的 100 条
      isSearchMode.value = false
      searchOffset.value = 0
      const result = await useMessageService().getAllRecentMessages(sessionId, filter, 100)
      messages.value = mapMessages(result.messages)
      hasMoreBefore.value = result.messages.length >= 100
      hasMoreAfter.value = false

      // 滚动到底部（最新消息在下面）
      // 需要延时确保虚拟化器完成初始化和高度计算
      await nextTick()
      setTimeout(() => {
        scrollToBottom()
      }, 50)
    }

    emit('count-change', messages.value.length)

    // emit 消息时间戳列表，用于联动会话时间线筛选
    const timestamps = messages.value.map((m) => m.timestamp)
    emit('message-timestamps-change', timestamps)

    // 处理待滚动的目标
    if (pendingScrollToId.value) {
      await nextTick()
      setTimeout(() => {
        if (pendingScrollToId.value) {
          scrollToMessage(pendingScrollToId.value)
          pendingScrollToId.value = null
        }
      }, 100)
    }
  } catch (e) {
    console.error('加载消息失败:', e)
    messages.value = []
    emit('count-change', 0)
  } finally {
    isLoading.value = false
  }
}

// 滚动到顶部
function scrollToTop() {
  virtualizer.value.scrollToOffset(0)
}

// 滚动到底部
function scrollToBottom() {
  if (messages.value.length === 0) return

  // 使用 scrollToIndex 定位到最后一条消息，对齐到底部
  virtualizer.value.scrollToIndex(messages.value.length - 1, { align: 'end' })

  // 额外确保：直接设置容器滚动位置到最底部
  // 这是为了处理虚拟化器初始化时高度可能还未准确的情况
  requestAnimationFrame(() => {
    const container = scrollContainerRef.value
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  })
}

// 加载更早的消息（向上滚动）
async function loadMoreBefore() {
  if (isLoadingMore.value || !hasMoreBefore.value || messages.value.length === 0) return

  const sessionId = effectiveSessionId.value
  if (!sessionId) return

  const firstMessage = messages.value[0]
  if (!firstMessage) return

  isLoadingMore.value = true

  try {
    const query = toRaw(props.query)
    const { filter, senderId, keywords } = buildFilterParams(query)
    const result = await useMessageService().getMessagesBefore(
      sessionId,
      firstMessage.id,
      50,
      filter,
      senderId,
      keywords
    )

    if (result.messages.length > 0) {
      // 记录当前的第一个可见项索引
      const currentOffset = virtualizer.value.scrollOffset ?? 0

      // prepend 消息
      const newMessages = [...mapMessages(result.messages), ...messages.value]
      messages.value = newMessages

      // 虚拟化器会自动处理滚动位置，但需要调整 offset
      // 新增的消息高度需要补偿
      await nextTick()
      const addedCount = result.messages.length
      const estimatedAddedHeight = addedCount * ESTIMATED_MESSAGE_HEIGHT
      virtualizer.value.scrollToOffset(currentOffset + estimatedAddedHeight)

      emit('count-change', messages.value.length)
      emit(
        'message-timestamps-change',
        messages.value.map((m) => m.timestamp)
      )
    }

    hasMoreBefore.value = result.hasMore
  } catch (e) {
    console.error('加载更早消息失败:', e)
  } finally {
    isLoadingMore.value = false
  }
}

// 加载更多消息（向下滚动）
async function loadMoreAfter() {
  if (isLoadingMore.value || !hasMoreAfter.value || messages.value.length === 0) return

  const sessionId = effectiveSessionId.value
  if (!sessionId) return

  isLoadingMore.value = true

  try {
    const query = toRaw(props.query)
    const { filter, senderId, keywords } = buildFilterParams(query)

    if (isSearchMode.value) {
      // 搜索模式：使用分页加载
      const result = await useMessageService().searchMessages(
        sessionId,
        keywords ?? [],
        filter,
        50,
        searchOffset.value,
        senderId
      )

      if (result.messages.length > 0) {
        messages.value = [...messages.value, ...mapMessages(result.messages)]
        searchOffset.value += result.messages.length
        emit('count-change', messages.value.length)
        emit(
          'message-timestamps-change',
          messages.value.map((m) => m.timestamp)
        )
      }

      hasMoreAfter.value = searchOffset.value < result.total
    } else {
      // 普通模式：服务端会根据末条消息 ID 解析 (timestamp, id) 复合时间游标。
      const lastMessage = messages.value[messages.value.length - 1]
      if (!lastMessage) return

      const result = await useMessageService().getMessagesAfter(
        sessionId,
        lastMessage.id,
        50,
        filter,
        senderId,
        keywords
      )

      if (result.messages.length > 0) {
        messages.value = [...messages.value, ...mapMessages(result.messages)]
        emit('count-change', messages.value.length)
        emit(
          'message-timestamps-change',
          messages.value.map((m) => m.timestamp)
        )
      }

      hasMoreAfter.value = result.hasMore
    }
  } catch (e) {
    console.error('加载更多消息失败:', e)
  } finally {
    isLoadingMore.value = false
  }
}

// 滚动到指定消息
function scrollToMessage(messageId: number) {
  const index = messages.value.findIndex((m) => m.id === messageId)
  if (index !== -1) {
    virtualizer.value.scrollToIndex(index, { align: 'center' })
    clearNavigationHighlight()
    navigationMessageId.value = messageId
    navigationHighlightTimer = setTimeout(clearNavigationHighlight, 2500)
  }
}

function clearNavigationHighlight() {
  if (navigationHighlightTimer) clearTimeout(navigationHighlightTimer)
  navigationHighlightTimer = null
  navigationMessageId.value = null
}

function navigateSender(direction: -1 | 1) {
  const message = focusedMessages.value[focusedMessagePosition.value + direction]
  if (!message) return
  focusedMessageId.value = message.id
  scrollToMessage(message.id)
}

function jumpToReply(messageId: number) {
  if (messages.value.some((message) => message.id === messageId)) {
    scrollToMessage(messageId)
  } else {
    // The workspace clears search/time filters to include the original and its context.
    emit('jump-to-message', messageId)
  }
}

// 处理滚动事件（检测边界）- 仅处理加载更多逻辑
function handleScroll() {
  const container = scrollContainerRef.value
  if (!container) return

  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight

  // 外部模式：通知到达边界
  if (isExternalMode.value) {
    if (container.scrollTop < 50) {
      emit('reach-top')
    }
    if (distanceFromBottom < 50) {
      emit('reach-bottom')
    }
  }

  // 检测加载更多（非外部模式）
  if (!isExternalMode.value && !isLoadingMore.value) {
    // 接近顶部时加载更多
    if (container.scrollTop < 100 && hasMoreBefore.value) {
      loadMoreBefore()
    }

    // 接近底部时加载更多
    if (distanceFromBottom < 100 && hasMoreAfter.value) {
      loadMoreAfter()
    }
  }

  // 使用防抖处理联动（避免频繁计算）
  scheduleVisibleMessageUpdate()
}

// 防抖定时器
let visibleMessageTimer: ReturnType<typeof setTimeout> | null = null
let lastEmittedMessageId = 0

// 防抖调度可见消息更新
function scheduleVisibleMessageUpdate() {
  if (visibleMessageTimer) return // 已有待处理的更新

  visibleMessageTimer = setTimeout(() => {
    visibleMessageTimer = null
    updateVisibleMessage()
  }, 150) // 150ms 防抖
}

// 更新可见消息（使用虚拟化器的可见项）
function updateVisibleMessage() {
  const items = virtualItems.value
  if (items.length === 0) return

  // 取中间可见项作为当前消息
  const middleIndex = Math.floor(items.length / 2)
  const middleItem = items[middleIndex]
  if (!middleItem) return

  const message = messages.value[middleItem.index]
  if (message && message.id !== lastEmittedMessageId) {
    lastEmittedMessageId = message.id
    // 同时上报消息 ID 与时间戳，供父组件优先按时间范围匹配会话。
    emit('visible-message-change', { id: message.id, timestamp: message.timestamp })
  }
}

// 判断是否是目标消息（高亮显示）
function isTargetMessage(message: ChatRecordMessage): boolean {
  if (message.id === navigationMessageId.value) return true
  if (isTopicMessage(message)) return true
  // 外部模式：检查是否在命中列表中
  if (isExternalMode.value && props.hitMessageIds?.length) {
    return props.hitMessageIds.includes(message.id)
  }
  return false
}

function isTopicMessage(message: ChatRecordMessage): boolean {
  const topic = props.highlightTopic
  if (!topic) return false
  return isMessageInChatTopicHighlight(topic, message, highlightedTopicMessageIds.value)
}

function topicSeparatorHighlightClass(index: number): string | undefined {
  const topic = props.highlightTopic
  const currentMessage = messages.value[index]
  const previousMessage = index > 0 ? messages.value[index - 1] : undefined
  if (!topic || !currentMessage || !previousMessage) return undefined
  if (!isTopicMessage(currentMessage) || !isTopicMessage(previousMessage)) return undefined
  return chatTopicColorStyle(topic.colorIndex).message
}

/**
 * 判断是否需要在消息前显示时间分隔线
 * @param index 当前消息在数组中的索引
 * @returns 需要显示时返回格式化的时间字符串，否则返回 null
 */
function getTimeSeparator(index: number): string | null {
  const currentMsg = messages.value[index]
  if (!currentMsg) return null

  const prevMsg = index > 0 ? messages.value[index - 1] : null

  // 第一条消息始终显示时间
  if (!prevMsg) {
    return formatSeparatorTime(currentMsg.timestamp)
  }

  const currentTs = currentMsg.timestamp
  const prevTs = prevMsg.timestamp
  const gap = currentTs - prevTs

  // 检查是否跨天
  const currentDay = dayjs.unix(currentTs).startOf('day')
  const prevDay = dayjs.unix(prevTs).startOf('day')
  const isDifferentDay = !currentDay.isSame(prevDay)

  // 跨天或间隔超过阈值时显示时间分隔线
  if (isDifferentDay || gap >= TIME_SEPARATOR_THRESHOLD) {
    return formatSeparatorTime(currentTs, isDifferentDay)
  }

  return null
}

const senderContinuations = computed(() => {
  // Search and external result sets can omit intervening speakers.
  if (isFiltered.value || isExternalMode.value) return []
  let groupLength = 0
  return messages.value.map((message, index) => {
    // Repeat identity in long runs so scrolling never leaves many anonymous bubbles.
    const continues =
      groupLength < 5 && !getTimeSeparator(index) && isSenderContinuation(messages.value[index - 1], message)
    groupLength = continues ? groupLength + 1 : 1
    return continues
  })
})

/**
 * 格式化时间分隔线的时间显示
 * - 当天消息：HH:mm
 * - 非当天消息：YYYY-MM-DD HH:mm
 */
function formatSeparatorTime(timestamp: number, showDate = false): string {
  const msgTime = dayjs.unix(timestamp)
  const today = dayjs().startOf('day')

  if (!showDate && msgTime.isSame(today, 'day')) {
    return msgTime.format('HH:mm')
  }
  return msgTime.format('YYYY-MM-DD HH:mm')
}

// 测量元素高度的回调（用于动态高度）
function measureElement(el: Element | null) {
  if (el) {
    virtualizer.value.measureElement(el)
  }
}

// 监听查询变化
watch(
  () => props.query,
  () => {
    if (!isExternalMode.value) {
      loadInitialMessages()
    }
  },
  { deep: true }
)

// 监听外部消息变化
watch(
  () => props.externalMessages,
  () => {
    if (isExternalMode.value) {
      loadInitialMessages()
    }
  },
  { deep: true, immediate: true }
)

// 清理定时器
onUnmounted(() => {
  clearNavigationHighlight()
  if (visibleMessageTimer) {
    clearTimeout(visibleMessageTimer)
    visibleMessageTimer = null
  }
})

// 暴露方法
defineExpose({
  refresh: loadInitialMessages,
  scrollToMessage,
})
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-chat-bg dark:bg-chat-dark">
    <div
      v-if="focusedSender"
      class="flex shrink-0 flex-col gap-1 border-b border-chat-divider px-4 py-2 text-xs dark:border-white/10"
    >
      <div class="flex min-w-0 items-center justify-between gap-2" role="status">
        <span class="min-w-0 truncate font-medium" :class="focusedSenderColor.text" :title="focusedSender.name">
          {{ t('records.messageList.highlightingSender', { name: focusedSender.name }) }}
        </span>
        <span class="shrink-0 tabular-nums text-gray-500 dark:text-gray-400">
          {{
            t('records.messageList.senderPosition', {
              current: focusedMessagePosition + 1,
              total: focusedMessages.length,
            })
          }}
        </span>
      </div>
      <div
        class="flex shrink-0 items-center justify-end gap-1"
        role="group"
        :aria-label="t('records.messageList.senderNavigation')"
      >
        <button
          type="button"
          class="min-h-6 rounded px-2 py-1 font-medium text-gray-600 enabled:cursor-pointer enabled:hover:bg-gray-200/70 focus-visible:outline-2 focus-visible:outline-primary-500 disabled:opacity-40 dark:text-gray-300 dark:enabled:hover:bg-white/10"
          :disabled="focusedMessagePosition <= 0"
          @click="navigateSender(-1)"
        >
          {{ t('records.messageList.previousSenderMessage') }}
        </button>
        <button
          type="button"
          class="min-h-6 rounded px-2 py-1 font-medium text-gray-600 enabled:cursor-pointer enabled:hover:bg-gray-200/70 focus-visible:outline-2 focus-visible:outline-primary-500 disabled:opacity-40 dark:text-gray-300 dark:enabled:hover:bg-white/10"
          :disabled="focusedMessagePosition >= focusedMessages.length - 1"
          @click="navigateSender(1)"
        >
          {{ t('records.messageList.nextSenderMessage') }}
        </button>
        <button
          type="button"
          class="min-h-6 rounded px-2 py-1 font-medium text-gray-600 hover:bg-gray-200/70 focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-gray-300 dark:hover:bg-white/10 cursor-pointer"
          @click="clearSenderFocus"
        >
          {{ t('records.messageList.clearSenderHighlight') }}
        </button>
      </div>
    </div>
    <!-- 加载中 -->
    <div v-if="isLoading" class="flex h-full items-center justify-center">
      <div class="text-center">
        <UIcon name="i-heroicons-arrow-path" class="h-8 w-8 animate-spin text-gray-400" />
        <p class="mt-2 text-sm text-gray-500">{{ t('records.messageList.loading') }}</p>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else-if="messages.length === 0" class="flex h-full items-center justify-center">
      <div class="text-center">
        <UIcon name="i-heroicons-chat-bubble-left-right" class="h-12 w-12 text-gray-300 dark:text-gray-600" />
        <p class="mt-2 text-sm text-gray-500">{{ t('records.messageList.noMessages') }}</p>
        <p class="mt-1 text-xs text-gray-400">{{ t('records.messageList.tryAdjustFilter') }}</p>
      </div>
    </div>

    <!-- 虚拟滚动容器 -->
    <div
      v-else
      ref="scrollContainerRef"
      class="min-h-0 flex-1 overflow-y-auto"
      data-testid="chat-record-message-scroller"
      @scroll="handleScroll"
    >
      <!-- 顶部加载指示器 -->
      <div v-if="hasMoreBefore" class="flex justify-center py-2">
        <span v-if="isLoadingMore" class="text-xs text-gray-400">
          <UIcon name="i-heroicons-arrow-path" class="mr-1 inline h-3 w-3 animate-spin" />
          {{ t('records.messageList.loadingMore') }}
        </span>
        <span v-else class="text-xs text-gray-400">{{ t('records.messageList.scrollUpForMore') }}</span>
      </div>

      <!-- 虚拟滚动列表 -->
      <div class="relative w-full" :style="{ height: `${totalSize}px` }">
        <div
          v-for="virtualItem in virtualItems"
          :key="String(virtualItem.key)"
          :ref="(el) => measureElement(el as Element)"
          class="absolute left-0 top-0 w-full"
          :style="{
            transform: `translateY(${virtualItem.start}px)`,
          }"
          :data-index="virtualItem.index"
        >
          <!-- 时间分隔线 -->
          <div
            v-if="getTimeSeparator(virtualItem.index)"
            class="flex items-center justify-center py-2 transition-colors duration-300"
            :class="topicSeparatorHighlightClass(virtualItem.index)"
          >
            <div class="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
              <div class="h-px w-8 bg-gray-200 dark:bg-gray-700" />
              <span>{{ getTimeSeparator(virtualItem.index) }}</span>
              <div class="h-px w-8 bg-gray-200 dark:bg-gray-700" />
            </div>
          </div>

          <!-- 消息项 -->
          <MessageItem
            :data-message-id="messages[virtualItem.index]?.id"
            :message="messages[virtualItem.index]!"
            :is-target="isTargetMessage(messages[virtualItem.index]!)"
            :topic-color-index="
              messages[virtualItem.index]!.id !== navigationMessageId && isTopicMessage(messages[virtualItem.index]!)
                ? highlightTopic?.colorIndex
                : undefined
            "
            :highlight-keywords="query.highlightKeywords"
            :is-filtered="isFiltered"
            :is-continuation="senderContinuations[virtualItem.index]"
            :is-sender-focused="focusedSender?.id === messages[virtualItem.index]!.senderPlatformId"
            @view-context="(id) => emit('jump-to-message', id)"
            @focus-sender="toggleSenderFocus"
            @jump-to-reply="jumpToReply"
          />
        </div>
      </div>

      <!-- 底部加载指示器 -->
      <div v-if="hasMoreAfter" class="flex justify-center py-2">
        <span v-if="isLoadingMore" class="text-xs text-gray-400">
          <UIcon name="i-heroicons-arrow-path" class="mr-1 inline h-3 w-3 animate-spin" />
          {{ t('records.messageList.loadingMore') }}
        </span>
        <span v-else class="text-xs text-gray-400">{{ t('records.messageList.scrollDownForMore') }}</span>
      </div>
    </div>
  </div>
</template>
