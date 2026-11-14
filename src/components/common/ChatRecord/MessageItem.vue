<script setup lang="ts">
/**
 * 单条消息展示组件 - 气泡样式
 * 支持 Owner 消息显示在右侧（类似聊天界面）
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'

import { analyzeMessyContent } from './messy-content'
import type { ChatRecordMessage } from './types'
import { chatTopicColorStyle } from './topic-highlight'
import { getSenderColor, getSenderInitials } from './sender-presentation'
import { useSessionStore } from '@/stores/session'
import { IS_WEB_WASM } from '@/utils/platform'
import MessageImages from './MessageImages.vue'

const { t } = useI18n()

const props = defineProps<{
  /** 消息数据 */
  message: ChatRecordMessage
  /** 是否为目标消息（需要高亮） */
  isTarget?: boolean
  /** 话题高亮颜色；普通消息定位仍使用默认主色。 */
  topicColorIndex?: number
  /** 高亮关键词 */
  highlightKeywords?: string[]
  /** 是否处于筛选模式（显示上下文按钮） */
  isFiltered?: boolean
  /** Hide repeated identity within a continuous run of messages. */
  isContinuation?: boolean
  /** Highlight all messages from the selected member. */
  isSenderFocused?: boolean
}>()

const emit = defineEmits<{
  (e: 'view-context', messageId: number): void
  (e: 'focus-sender', message: ChatRecordMessage): void
  (e: 'jump-to-reply', messageId: number): void
}>()

const sessionStore = useSessionStore()
const messageTime = computed(() => dayjs.unix(props.message.timestamp))
const fullMessageTime = computed(() => messageTime.value.format('YYYY-MM-DD HH:mm:ss'))
const imageCaption = ref<string | null>(null)
const canLoadImages = computed(
  () =>
    !IS_WEB_WASM &&
    !!sessionStore.currentSessionId &&
    ['qq', 'telegram'].includes(sessionStore.currentSession?.platform ?? '') &&
    [1, 5, 99].includes(props.message.type)
)
const imageMessageContent = computed(() => {
  if (!canLoadImages.value) return visibleMessageContent.value
  if (imageCaption.value !== null) return imageCaption.value
  if (props.message.type === 1) {
    return sessionStore.currentSession?.platform === 'telegram'
      ? props.message.content.replace(/^\[(?:photo|animation)\]\s*/, '')
      : ''
  }
  return visibleMessageContent.value
})

// 判断当前消息是否是 Owner 发送的
const isOwner = computed(() => {
  const ownerId = sessionStore.currentSession?.ownerId
  if (!ownerId) return false
  return props.message.senderPlatformId === ownerId
})

const targetColor = computed(() =>
  props.topicColorIndex === undefined
    ? 'bg-primary-500/5 dark:bg-primary-500/10'
    : chatTopicColorStyle(props.topicColorIndex).message
)
const showFullMessyContent = ref(false)

const contentAnalysis = computed(() => analyzeMessyContent(props.message.content || ''))
const visibleMessageContent = computed(() => {
  const analysis = contentAnalysis.value
  if (!analysis.shouldCollapse || showFullMessyContent.value) {
    return analysis.normalizedContent
  }
  return analysis.previewLines.join('\n')
})

watch(
  () => [props.message.id, props.message.content, sessionStore.currentSessionId],
  () => {
    showFullMessyContent.value = false
    imageCaption.value = null
  }
)

// 显示名称（包含别名）
const displayName = computed(() => {
  const name = props.message.senderName || ''
  const aliases = props.message.senderAliases || []

  // 如果有别名，在名称后面括号显示第一个别名
  if (aliases.length > 0) {
    return `${name}（${aliases[0]}）`
  }
  return name
})

const avatarLetter = computed(() => getSenderInitials(props.message.senderName))
const senderColor = computed(() =>
  getSenderColor(sessionStore.currentSession?.platform ?? '', props.message.senderPlatformId)
)
const focusLabel = computed(() =>
  t(props.isSenderFocused ? 'records.messageItem.unhighlightSender' : 'records.messageItem.highlightSender', {
    name: displayName.value,
  })
)

const HIGHLIGHT_MARK_CLASS =
  'bg-transparent text-inherit underline decoration-primary-500/80 underline-offset-4 dark:decoration-primary-400/80'

function escapeHtml(content: string): string {
  return content.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      case "'":
        return '&#39;'
      default:
        return char
    }
  })
}

// 高亮关键词
function highlightContent(content: string): string {
  const escapedContent = escapeHtml(content)
  const escapedKeywords = props.highlightKeywords?.map((keyword) => escapeHtml(keyword)).filter(Boolean) ?? []
  if (!escapedKeywords.length || !escapedContent) return escapedContent

  const pattern = escapedKeywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const regex = new RegExp(`(${pattern})`, 'gi')
  return escapedContent.replace(regex, `<mark class="${HIGHLIGHT_MARK_CLASS}">$1</mark>`)
}
</script>

<template>
  <div
    class="group px-4 pb-1 transition-colors"
    :class="[isContinuation ? 'pt-0.5' : 'pt-3', isTarget ? targetColor : '']"
    :data-sender-id="message.senderPlatformId"
    :data-sender-focused="isSenderFocused || undefined"
    :data-continuation="isContinuation || undefined"
  >
    <!-- Owner 消息显示在右侧 -->
    <div class="flex gap-2.5" :class="isOwner ? 'flex-row-reverse' : ''">
      <!-- 头像 -->
      <button
        v-if="!isContinuation"
        type="button"
        class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-semibold cursor-pointer transition-shadow hover:ring-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
        :class="[senderColor.avatar, senderColor.text, senderColor.ring, { 'ring-2': isSenderFocused }]"
        :title="focusLabel"
        :aria-label="focusLabel"
        :aria-pressed="!!isSenderFocused"
        @click="emit('focus-sender', message)"
      >
        <img v-if="message.senderAvatar" :src="message.senderAvatar" alt="" class="h-full w-full object-cover" />
        <span v-else>{{ avatarLetter }}</span>
      </button>
      <div v-else class="w-8 shrink-0" aria-hidden="true" />

      <!-- 消息内容区 -->
      <div class="min-w-0 flex-1" :class="isOwner ? 'flex flex-col items-end' : ''">
        <!-- 发送者名称 -->
        <div v-if="!isContinuation" class="mb-1 flex items-center gap-2" :class="isOwner ? 'flex-row-reverse' : ''">
          <button
            type="button"
            class="text-left text-xs font-semibold cursor-pointer hover:underline underline-offset-2 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
            :class="senderColor.text"
            :title="focusLabel"
            :aria-label="focusLabel"
            :aria-pressed="!!isSenderFocused"
            @click="emit('focus-sender', message)"
          >
            {{ displayName }}
          </button>
          <time
            class="shrink-0 text-[11px] tabular-nums text-gray-500 dark:text-gray-400"
            :datetime="messageTime.toISOString()"
            :title="fullMessageTime"
            :aria-label="fullMessageTime"
          >
            {{ messageTime.format('HH:mm') }}
          </time>
        </div>
        <span v-else class="sr-only">{{ displayName }}</span>

        <!-- 气泡和上下文按钮 -->
        <div class="flex min-w-0 max-w-[min(88%,46rem)] items-start gap-1" :class="isOwner ? 'flex-row-reverse' : ''">
          <div
            class="relative min-w-0 max-w-full rounded-xl px-3 py-2"
            :class="[
              isOwner ? 'bg-chat-owner dark:bg-chat-owner-dark' : 'bg-chat-bubble dark:bg-chat-bubble-dark',
              isSenderFocused ? ['ring-2 ring-inset', senderColor.ring] : '',
            ]"
          >
            <!-- 回复引用样式 -->
            <button
              v-if="message.replyToMessageId"
              type="button"
              class="mb-2 block w-full rounded-r border-l-2 border-primary-400 bg-gray-500/5 py-1 pl-2.5 pr-2 text-left text-xs text-gray-500 transition-colors enabled:cursor-pointer enabled:hover:bg-gray-500/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 disabled:cursor-default dark:border-primary-500 dark:bg-white/5 dark:text-gray-400 dark:enabled:hover:bg-white/10"
              :disabled="!message.replyToInternalId"
              :title="
                t(
                  message.replyToInternalId
                    ? 'records.messageItem.jumpToOriginal'
                    : 'records.messageItem.originalNotImported'
                )
              "
              :aria-label="
                t(
                  message.replyToInternalId
                    ? 'records.messageItem.jumpToOriginal'
                    : 'records.messageItem.originalNotImported'
                )
              "
              @click="message.replyToInternalId && emit('jump-to-reply', message.replyToInternalId)"
            >
              <span class="flex items-center gap-1">
                <span class="shrink-0 font-medium text-gray-600 dark:text-gray-300">
                  {{ t('records.messageItem.replyTo') }}
                </span>
                <span
                  v-if="message.replyToSenderName"
                  class="min-w-0 truncate font-semibold text-gray-700 dark:text-gray-200"
                >
                  {{ message.replyToSenderName }}
                </span>
                <UIcon
                  v-if="message.replyToInternalId"
                  name="i-heroicons-arrow-up-left"
                  class="ml-auto h-3.5 w-3.5 shrink-0"
                />
              </span>
              <p
                v-if="message.replyToContent"
                class="mt-1 line-clamp-2 italic text-gray-500 dark:text-gray-400 leading-normal"
              >
                {{ message.replyToContent }}
              </p>
              <span v-if="!message.replyToInternalId" class="mt-1 block text-[11px]">
                {{ t('records.messageItem.originalNotImported') }}
              </span>
            </button>
            <MessageImages
              v-if="canLoadImages && sessionStore.currentSessionId"
              :session-id="sessionStore.currentSessionId"
              :message-id="message.id"
              :show-unavailable="message.type !== 99"
              @caption="imageCaption = $event"
            />
            <p
              v-if="imageMessageContent"
              class="reading-text chat-record-message-content whitespace-pre-wrap break-all text-chat-text dark:text-gray-100"
              :class="{ 'mt-2': imageCaption !== null }"
              v-html="highlightContent(imageMessageContent)"
            />
            <ul
              v-if="imageCaption === null && contentAnalysis.linkUrls.length"
              class="chat-record-message-content mt-2 min-w-0 max-w-full list-disc space-y-1 pl-4 text-xs text-primary-600 dark:text-primary-400"
            >
              <li v-for="linkUrl in contentAnalysis.linkUrls" :key="linkUrl" class="min-w-0">
                <a
                  :href="linkUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="block min-w-0 max-w-full truncate transition-colors hover:text-primary-700 dark:hover:text-primary-300"
                  @click.stop
                >
                  {{ linkUrl }}
                </a>
              </li>
            </ul>
            <button
              v-if="imageCaption === null && contentAnalysis.shouldCollapse"
              type="button"
              class="mt-2 inline-flex items-center gap-1 text-xs font-medium text-gray-500 transition-colors select-none hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 cursor-pointer"
              @click="showFullMessyContent = !showFullMessyContent"
            >
              <UIcon
                :name="showFullMessyContent ? 'i-heroicons-chevron-up' : 'i-heroicons-chevron-down'"
                class="h-3.5 w-3.5"
              />
              <span>
                {{
                  showFullMessyContent
                    ? t('records.messageItem.collapseMessyContent')
                    : t('records.messageItem.expandMessyContent')
                }}
              </span>
            </button>
          </div>

          <time
            v-if="isContinuation"
            class="mb-1 shrink-0 self-end text-[11px] tabular-nums text-gray-500 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 dark:text-gray-400"
            :datetime="messageTime.toISOString()"
            :title="fullMessageTime"
            :aria-label="fullMessageTime"
          >
            {{ messageTime.format('HH:mm') }}
          </time>

          <!-- 上下文查看按钮 -->
          <button
            v-if="isFiltered"
            class="mt-1 flex h-6 w-6 items-center justify-center rounded-lg opacity-0 transition-all duration-200 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-primary-500 dark:hover:text-primary-400 active:scale-95 group-hover:opacity-100 focus-visible:opacity-100 cursor-pointer"
            :title="t('records.messageItem.viewContext')"
            @click="$emit('view-context', message.id)"
          >
            <UIcon name="i-heroicons-chat-bubble-left-ellipsis" class="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
