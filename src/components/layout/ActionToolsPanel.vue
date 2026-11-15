<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useLayoutStore } from '@/stores/layout'
import CaptureButton from '@/components/common/CaptureButton.vue'

const { t } = useI18n()
const layoutStore = useLayoutStore()
const { isToolsPanelMini, effectiveToolsPanelPosition, isToolsPanelOpen } = storeToRefs(layoutStore)

const isHeaderMode = computed(() => effectiveToolsPanelPosition.value === 'header')
const isPanelVisible = computed(() => !isHeaderMode.value || isToolsPanelOpen.value)
const panelRef = ref<HTMLElement | null>(null)

type ToolEvent =
  | 'openIncrementalImport'
  | 'openSemanticIndex'
  | 'openMemberManagement'
  | 'openChatRecord'
  | 'openMessageExport'

const emit = defineEmits<{
  (e: ToolEvent): void
}>()

function handleToolClick(event: ToolEvent) {
  emit(event)
  if (isHeaderMode.value) {
    isToolsPanelOpen.value = false
  }
}

function handleDocumentMouseDown(event: MouseEvent) {
  if (!isHeaderMode.value || !isToolsPanelOpen.value) return

  const target = event.target
  if (!(target instanceof Element)) return

  // header 模式下，“更多”按钮在面板外部，需要排除它，否则点按钮关闭时会被外部点击监听反向打开。
  if (panelRef.value?.contains(target) || target.closest('[data-tools-panel-trigger]')) return

  isToolsPanelOpen.value = false
}

const tools = [
  {
    event: 'openIncrementalImport' as const,
    icon: 'i-heroicons-plus-circle',
    hoverColor: 'text-inherit',
    miniHoverBg: 'text-inherit',
    labelKey: 'analysis.tooltip.incrementalImport',
  },
  {
    event: 'openSemanticIndex' as const,
    icon: 'i-heroicons-circle-stack',
    hoverColor: 'text-inherit',
    miniHoverBg: 'text-inherit',
    labelKey: 'analysis.tooltip.semanticIndex',
  },
  {
    event: 'openMemberManagement' as const,
    icon: 'i-heroicons-user-group',
    hoverColor: 'text-inherit',
    miniHoverBg: 'text-inherit',
    labelKey: 'analysis.tooltip.memberManagement',
  },
  {
    event: 'openChatRecord' as const,
    icon: 'i-heroicons-chat-bubble-bottom-center-text',
    hoverColor: 'text-inherit',
    miniHoverBg: 'text-inherit',
    labelKey: 'analysis.tooltip.viewChatRecord',
  },
  {
    event: 'openMessageExport' as const,
    icon: 'i-heroicons-document-arrow-down',
    hoverColor: 'text-inherit',
    miniHoverBg: 'text-inherit',
    labelKey: 'analysis.messageExport.title',
  },
]

const headerTools = tools.filter((tool) => tool.event !== 'openChatRecord')

const visibleTools = computed(() => (isHeaderMode.value ? headerTools : tools))

watch(effectiveToolsPanelPosition, () => {
  isToolsPanelOpen.value = false
})

onMounted(() => {
  document.addEventListener('mousedown', handleDocumentMouseDown)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleDocumentMouseDown)
})
</script>

<template>
  <!-- Mini 模式：常驻竖条，只有图标（仅 side 模式） -->
  <div v-if="!isHeaderMode && isToolsPanelMini" class="fixed right-0 top-1/3">
    <div
      class="no-capture flex flex-col items-center gap-0.5 rounded-l-lg border border-r-0 border-gray-200/60 bg-white py-1.5 shadow-sm dark:border-white/5 dark:bg-page-dark"
    >
      <UTooltip v-for="tool in tools" :key="tool.event" :text="t(tool.labelKey)" :popper="{ placement: 'left' }">
        <button
          class="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 dark:text-gray-500 dark:hover:bg-white/5"
          :class="tool.miniHoverBg"
          @click="handleToolClick(tool.event)"
        >
          <UIcon :name="tool.icon" class="h-3.5 w-3.5" />
        </button>
      </UTooltip>

      <!-- 分隔线 -->
      <div class="my-0.5 h-px w-4 bg-gray-200 dark:bg-gray-700" />

      <!-- 退出 mini 模式 -->
      <UTooltip :text="t('analysis.toolsPanel.exitMini')" :popper="{ placement: 'left' }">
        <button
          class="flex h-7 w-7 items-center justify-center rounded-md text-gray-300 transition-colors hover:bg-gray-100 hover:text-gray-500 dark:text-gray-600 dark:hover:bg-white/5 dark:hover:text-gray-400"
          @click="layoutStore.toggleToolsPanelMini()"
        >
          <UIcon name="i-heroicons-arrows-pointing-out" class="h-3 w-3" />
        </button>
      </UTooltip>
    </div>
  </div>

  <!-- header 模式：点击更多后从右侧滑入；side 模式：面板常驻 -->
  <div v-else class="fixed right-0 z-40" :class="isHeaderMode ? 'top-14 right-5' : 'top-1/3'">
    <div
      class="absolute right-0 top-0 transition-all duration-250 ease-in-out"
      :class="isPanelVisible ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-1 opacity-0'"
      :inert="!isPanelVisible"
      :aria-hidden="!isPanelVisible"
      @keydown.esc.stop="isToolsPanelOpen = false"
    >
      <div
        ref="panelRef"
        class="no-capture flex w-52 flex-col rounded-xl border border-gray-200/80 bg-white p-2 shadow-overlay dark:border-white/5 dark:bg-page-dark"
      >
        <div class="mb-2 flex items-center justify-between">
          <span class="px-2 pt-1 text-[11px] font-medium text-gray-500 dark:text-gray-500">
            {{ t('analysis.overview.tools') }}
          </span>
          <!-- Mini 模式按钮（仅 side 模式） -->
          <UTooltip v-if="!isHeaderMode" :text="t('analysis.toolsPanel.miniMode')" :popper="{ placement: 'left' }">
            <button
              class="flex h-5 w-5 items-center justify-center rounded text-gray-300 transition-colors hover:text-gray-500 dark:text-gray-600 dark:hover:text-gray-400"
              @click="layoutStore.toggleToolsPanelMini()"
            >
              <UIcon name="i-heroicons-arrows-pointing-in" class="h-3 w-3" />
            </button>
          </UTooltip>
        </div>

        <div class="flex flex-col gap-0.5">
          <button
            v-for="tool in visibleTools"
            :key="tool.event"
            class="group flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs font-medium text-gray-600 transition-all hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white"
            @click="handleToolClick(tool.event)"
          >
            <UIcon
              :name="tool.icon"
              class="h-3.5 w-3.5 text-gray-400 transition-colors dark:text-gray-500"
              :class="tool.hoverColor"
            />
            <span class="whitespace-nowrap">{{ t(tool.labelKey) }}</span>
          </button>
          <CaptureButton
            v-if="isHeaderMode"
            color="neutral"
            :label="t('common.capture')"
            class="w-full justify-start rounded-md px-2 py-2 text-xs"
          />
        </div>
      </div>
    </div>
  </div>
</template>
