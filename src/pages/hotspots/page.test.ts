import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as Vue from 'vue'
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import ts from 'typescript'

// Exercise the real page handlers and template; isolate platform services and UI primitives.
async function page() {
  const filename = new URL('./index.vue', import.meta.url).pathname
  const { descriptor } = parse(readFileSync(filename, 'utf8'))
  const script = compileScript(descriptor, { id: 'hotspots-test' })
  const code = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const config = {
    sessionIds: ['source-group'],
    enabled: false,
    locale: 'zh-CN',
    interests: '',
    budget: { monthlyLimit: 10, currency: 'CNY', modelId: 'fixture', inputPerMillion: 1, outputPerMillion: 2 },
  }
  const layout = Vue.reactive({
    chatRecordQuery: null as unknown,
    openChatRecords(query: unknown) {
      this.chatRecordQuery = query
    },
  })
  const sidePanel = Vue.defineComponent({
    setup(_, { slots }) {
      return () =>
        Vue.h('div', [
          slots.default?.(),
          layout.chatRecordQuery
            ? Vue.h('aside', { 'data-record-query': JSON.stringify(layout.chatRecordQuery) })
            : null,
        ])
    },
  })
  const deps: Record<string, unknown> = {
    vue: Vue,
    'vue-i18n': { useI18n: () => ({ t: (key: string) => key, locale: Vue.ref('zh-CN') }) },
    '@/stores/session': {
      useSessionStore: () => ({ sessions: [{ id: 'source-group', name: 'Source', type: 'group', platform: 'qq' }] }),
    },
    '@/stores/layout': { useLayoutStore: () => layout },
    '@/services/hotspots': {
      hotspotService: {
        feed: async () => ({
          config,
          items: [],
          highlights: [],
          status: {},
          knowledge: [],
          usage: { modelId: 'fixture' },
        }),
        recommendations: async () => [],
      },
    },
    '@/utils/platform': { IS_WEB_WASM: false },
    '@/components/layout/SidePanelLayout.vue': { default: sidePanel },
  }
  const mod = { exports: {} as { default?: Vue.Component & { setup: (...args: any[]) => any } } }
  new Function('require', 'module', 'exports', code)(
    (name: string) => {
      assert.ok(name in deps, `Unexpected page dependency: ${name}`)
      return deps[name]
    },
    mod,
    mod.exports
  )
  const compiled = compileTemplate({
    source: descriptor.template!.content,
    filename,
    id: 'hotspots-test',
    compilerOptions: { mode: 'function', prefixIdentifiers: true, expressionPlugins: ['typescript'] },
  })
  assert.deepEqual(compiled.errors, [])
  const render = new Function('Vue', compiled.code)(Vue)
  let state: any
  const component = Vue.defineComponent({
    setup() {
      state = mod.exports.default!.setup({}, { expose: () => undefined })
      return { ...state }
    },
    render,
  })
  const modal = Vue.defineComponent({
    props: ['open'],
    setup: (props) => () => (props.open ? Vue.h('dialog', { open: true }) : null),
  })
  function app() {
    const app = Vue.createSSRApp(component)
    app.component('SidePanelLayout', sidePanel)
    app.component('UModal', modal)
    for (const name of ['UButton', 'UIcon', 'UInput', 'USkeleton']) {
      app.component(
        name,
        Vue.defineComponent({
          setup:
            (_, { slots }) =>
            () =>
              Vue.h('div', slots.default?.()),
        })
      )
    }
    return app
  }
  await renderToString(app())
  await state.load()
  return {
    state,
    layout,
    config,
    render: () =>
      renderToString(
        Vue.createSSRApp({
          setup: () => ({ ...state }),
          render,
          components: {
            SidePanelLayout: sidePanel,
            UModal: modal,
            ...Object.fromEntries(
              ['UButton', 'UIcon', 'UInput', 'USkeleton'].map((name) => [
                name,
                Vue.defineComponent({
                  setup:
                    (_, { slots }) =>
                    () =>
                      Vue.h('div', slots.default?.()),
                }),
              ])
            ),
          },
        })
      ),
  }
}

test('preferences open with a stored reactive budget, and cancel edits cannot mutate the saved config', async () => {
  const { state, config, render } = await page()
  state.openSettings()
  assert.equal(state.settings.value, true)
  assert.match(await render(), /<dialog open/)
  state.draft.value.budget.monthlyLimit = 42
  assert.equal(config.budget.monthlyLimit, 10)
})

test('opening a hotspot source renders the message panel with the source group and exact message ID', async () => {
  const { state, layout, render } = await page()
  state.source({ sessionId: 'source-group', messageId: 27 })
  assert.deepEqual(layout.chatRecordQuery, { sessionId: 'source-group', scrollToMessageId: 27 })
  assert.match(await render(), /data-record-query=/)
})

test('favorites and knowledge views are exclusive, and favorites clear a stale category filter', async () => {
  const { state } = await page()
  state.toggleKnowledge()
  state.category.value = 'news'
  state.toggleSaved()
  await Vue.nextTick()
  assert.equal(state.knowledgeOnly.value, false)
  assert.equal(state.category.value, 'all')
  state.toggleKnowledge()
  await Vue.nextTick()
  assert.equal(state.savedOnly.value, false)
  assert.equal(state.knowledgeOnly.value, true)
})

test('the default weekly feed shows useful topics beyond the fifteen curated picks', async () => {
  const { state, render } = await page()
  state.data.value.items = Array.from({ length: 21 }, (_, index) => ({
    id: `topic-${index}`,
    title: `Useful topic ${index}`,
    summary: 'Concrete findings',
    category: 'tech',
    kind: 'tool',
    activity: 'new',
    sources: [],
    links: [],
    updates: [],
  }))
  state.data.value.highlights = state.data.value.items.slice(0, 15).map((item: { id: string }) => item.id)
  assert.equal(state.window.value, 'week')
  assert.equal((await render()).match(/<article\b/g)?.length, 21)
})
