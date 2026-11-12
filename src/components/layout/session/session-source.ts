import type { DataSource } from '@/stores/apiServer'

/** Match the exact local conversation, never a platform name or a remote conversation title. */
export function getSessionSources(sessionId: string, sources: DataSource[]) {
  if (!sessionId) return []
  return sources.flatMap((source) =>
    source.sessions
      .filter((subscription) => subscription.targetSessionId === sessionId)
      .map((subscription) => ({
        id: `${source.id}:${subscription.id}`,
        name: source.name,
        enabled: source.enabled,
        intervalMinutes: source.intervalMinutes,
        // This is the saved incremental watermark, not the time the last pull finished.
        progressAt: subscription.lastPullAt,
        status: subscription.lastStatus,
      }))
  )
}
