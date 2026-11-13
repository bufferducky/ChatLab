<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { getChatPlatform } from '@/utils/chat-platform'

const props = defineProps<{ platform: string; iconOnly?: boolean }>()
const { t } = useI18n()
const presentation = computed(() => getChatPlatform(props.platform))
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1 py-0.5 text-[10px] font-medium leading-none"
    :class="presentation.badgeClass"
    :title="t(presentation.labelKey)"
  >
    <UIcon :name="presentation.icon" class="size-2.5 shrink-0" aria-hidden="true" />
    <span :class="iconOnly ? 'sr-only' : ''">{{ t(presentation.labelKey) }}</span>
  </span>
</template>
