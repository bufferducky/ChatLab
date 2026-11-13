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
      class="flex size-10 cursor-pointer items-center justify-center rounded-xl transition-colors focus-visible:ring-2 focus-visible:ring-primary-500"
      :class="
        active
          ? 'bg-primary-100/70 text-primary-600 dark:bg-primary-500/15 dark:text-primary-400'
          : 'text-chat-text hover:bg-chat-control dark:text-gray-300 dark:hover:bg-white/5'
      "
    >
      <UIcon :name="icon" class="size-[22px] shrink-0" :class="iconClass" />
    </UButton>
  </UTooltip>
</template>
