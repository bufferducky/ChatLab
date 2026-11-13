<script setup lang="ts">
import { ChatRecordWorkspace } from '@/components/common/ChatRecord'
import { IS_WEB_WASM } from '@/utils/platform'

defineProps<{ sessionId: string; sessionName?: string }>()
</script>

<template>
  <ChatRecordWorkspace
    :key="sessionId"
    :session-id="sessionId"
    mode="page"
    :show-topics="!IS_WEB_WASM"
    class="h-full min-h-0"
  />
</template>
