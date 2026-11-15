<script setup lang="ts">
withDefaults(
  defineProps<{
    icon: string
    title: string
    active?: boolean
    iconClass?: string
  }>(),
  { active: false, iconClass: '' }
)
</script>

<template>
  <UTooltip :text="title" :content="{ side: 'right' }">
    <UButton
      :aria-label="title"
      :aria-current="active ? 'page' : undefined"
      color="neutral"
      variant="ghost"
      class="flex size-10 cursor-pointer items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-primary-500"
      :class="
        active
          ? 'bg-session-selected text-gray-900 dark:bg-session-selected-dark dark:text-gray-100'
          : 'text-gray-500 hover:bg-chat-control hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-100'
      "
    >
      <UIcon :name="icon" class="size-5 shrink-0" :class="iconClass" />
    </UButton>
  </UTooltip>
</template>
