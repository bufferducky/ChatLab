import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import persistedstate from 'pinia-plugin-persistedstate'

class Player extends EventTarget {
  muted = false
  volume = 1
  paused = true
  pause() {
    this.paused = true
  }
  play() {
    this.paused = false
    this.dispatchEvent(new Event('play'))
  }
  changeMuted(value: boolean) {
    this.muted = value
    this.dispatchEvent(new Event('volumechange'))
  }
}

test('sound preference follows the conversation across players, large windows and reloads', async () => {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  })
  const { useVideoPlaybackStore } = await import('./videoPlayback')
  function setup() {
    const pinia = createPinia().use(persistedstate)
    createApp({}).use(pinia)
    setActivePinia(pinia)
    return useVideoPlaybackStore(pinia)
  }
  const store = setup()
  const first = new Player(),
    next = new Player(),
    other = new Player()
  const detach = store.register(first, 'a')
  store.register(next, 'a')
  store.register(other, 'b')
  assert.equal(first.muted, true)
  first.changeMuted(false)
  assert.equal(next.muted, false)
  assert.equal(other.muted, true)
  const large = new Player()
  store.register(large, 'a')
  assert.equal(large.muted, false)
  large.changeMuted(true)
  assert.equal(first.muted, true)
  first.volume = 0
  first.dispatchEvent(new Event('volumechange'))
  next.changeMuted(false)
  assert.equal(first.volume, 1)
  detach()
  await nextTick()
  const reloaded = setup()
  const returned = new Player(),
    separate = new Player()
  reloaded.register(returned, 'a')
  reloaded.register(separate, 'b')
  assert.equal(returned.muted, false)
  assert.equal(separate.muted, true)
})

test('starting another inline or large player pauses the previous player', async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => {} },
  })
  const { useVideoPlaybackStore } = await import('./videoPlayback')
  const store = useVideoPlaybackStore(createPinia())
  const inline = new Player(),
    next = new Player(),
    large = new Player()
  store.register(inline, 'a')
  store.register(next, 'a')
  const detach = store.register(large, 'a')
  inline.play()
  next.play()
  assert.equal(inline.paused, true)
  assert.equal(next.paused, false)
  large.play()
  assert.equal(next.paused, true)
  assert.equal(large.paused, false)
  detach()
})
