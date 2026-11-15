<script setup lang="ts">
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { UiIcon } from '@/components/UI/primitives'
import type { NavigationTabItem } from './types'

interface PageTabItem extends NavigationTabItem {
  to?: RouteLocationRaw
}

const props = withDefaults(
  defineProps<{
    modelValue: string
    items: PageTabItem[]
    ariaLabel?: string
  }>(),
  {
    ariaLabel: undefined,
  }
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [value: string]
}>()

function selectItem(item: PageTabItem): void {
  if (item.to || item.id === props.modelValue) return
  emit('update:modelValue', item.id)
  emit('change', item.id)
}
</script>

<template>
  <div class="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-3">
    <nav class="max-w-full shrink-0 overflow-x-auto scrollbar-hide" :aria-label="ariaLabel">
      <div class="flex w-max items-center gap-5">
        <template v-for="item in items" :key="item.id">
          <component
            :is="item.to ? RouterLink : 'button'"
            :to="item.to"
            :type="item.to ? undefined : 'button'"
            class="flex shrink-0 items-center gap-1.5 border-b-2 px-0.5 py-3 text-xs font-medium whitespace-nowrap transition-colors"
            :class="
              modelValue === item.id
                ? 'border-gray-900 text-gray-900 dark:border-gray-100 dark:text-gray-100'
                : 'border-transparent text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
            "
            :aria-pressed="item.to ? undefined : modelValue === item.id"
            @click="selectItem(item)"
          >
            <UiIcon v-if="item.icon" :name="item.icon" size="sm" />
            <span>{{ item.label }}</span>
          </component>
          <slot name="after-item" :item="item" />
        </template>
      </div>
    </nav>

    <div v-if="$slots.right" class="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end">
      <slot name="right" />
    </div>
  </div>
</template>
