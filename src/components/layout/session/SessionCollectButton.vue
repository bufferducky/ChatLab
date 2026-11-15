<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApiServerStore } from '@/stores/apiServer'
import { useToast } from '@/composables/useToast'
import { IS_WEB_WASM } from '@/utils/platform'

const props = defineProps<{ sessionId: string }>()
const emit = defineEmits<{ collected: [sessionId: string] }>()
const store = useApiServerStore()
const toast = useToast()
const { t } = useI18n()
const busy = ref(false)
const subscription = computed(() => {
  const matches = store.dataSources.flatMap((source) =>
    source.sessions
      .filter((session) => session.targetSessionId === props.sessionId)
      .map((session) => ({ source, session }))
  )
  return matches.length === 1 ? matches[0] : undefined
})
const pending = computed(
  () => busy.value || !!(subscription.value && store.pullingIds.has(subscription.value.source.id))
)
watch(
  () => props.sessionId,
  () => {
    if (!IS_WEB_WASM) void store.fetchDataSources()
  },
  { immediate: true }
)

async function collect() {
  const target = subscription.value
  if (!target || pending.value) return
  const sessionId = props.sessionId
  busy.value = true
  try {
    const result = await store.collectAndPull(target.source.id, { sessionIds: [target.session.id] })
    if (!result) {
      toast.fail(t('common.collectFailed'))
      return
    }
    emit('collected', sessionId)
    if (result.pull.errors.length || ['failed', 'timeout', 'busy'].includes(result.collect.state)) {
      toast.warn(t('common.collectPartial'), { description: result.pull.errors[0] || result.collect.error })
    } else if (result.collect.state === 'skipped') {
      toast.warn(t('common.collectPullOnly', { count: result.pull.newMessages }))
    } else {
      toast.success(t('common.collectDone', { count: result.pull.newMessages }))
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UButton
    v-if="!IS_WEB_WASM && subscription"
    size="xs"
    color="neutral"
    variant="soft"
    icon="i-heroicons-cloud-arrow-down"
    :loading="pending"
    :disabled="pending"
    class="shrink-0 whitespace-nowrap"
    @click="collect"
  >
    {{ t(pending ? 'common.collecting' : 'common.collectAndUpdate') }}
  </UButton>
</template>
