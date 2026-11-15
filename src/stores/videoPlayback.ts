import { ref } from 'vue'
import { defineStore } from 'pinia'

type VideoPlayer = Pick<HTMLMediaElement, 'muted' | 'volume' | 'pause' | 'addEventListener' | 'removeEventListener'>

/** Persist sound by conversation; keep actual player instances in memory only. */
export const useVideoPlaybackStore = defineStore(
  'videoPlayback',
  () => {
    const mutedBySession = ref<Record<string, boolean>>({})
    const players = new Map<VideoPlayer, string>()
    const isMuted = (sessionId: string) => mutedBySession.value[sessionId] ?? true

    function apply(player: VideoPlayer, muted: boolean) {
      if (!muted && player.volume === 0) player.volume = 1
      player.muted = muted
    }

    function setMuted(sessionId: string, muted: boolean) {
      mutedBySession.value[sessionId] = muted
      for (const [player, session] of players) if (session === sessionId) apply(player, muted)
    }

    function register(player: VideoPlayer, sessionId: string): () => void {
      apply(player, isMuted(sessionId))
      players.set(player, sessionId)
      const volumeChanged = () => {
        const muted = player.muted || player.volume === 0
        if (muted !== isMuted(sessionId)) setMuted(sessionId, muted)
      }
      const playing = () => {
        for (const other of players.keys()) if (other !== player) other.pause()
      }
      player.addEventListener('volumechange', volumeChanged)
      player.addEventListener('play', playing)
      return () => {
        player.removeEventListener('volumechange', volumeChanged)
        player.removeEventListener('play', playing)
        players.delete(player)
      }
    }

    return { mutedBySession, isMuted, register }
  },
  {
    persist: { pick: ['mutedBySession'], storage: localStorage },
  }
)
