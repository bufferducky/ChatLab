export interface AutomationDataSourceLike {
  id: string
  sessions: Array<{ id: string; targetSessionId?: string | null }>
}

export type AutomationSessionKind = 'group' | 'private' | 'other'

export interface AutomationCollectScope {
  type?: AutomationSessionKind
  sessionIds?: string[]
}

export interface AutomationRouteContext {
  dsManager: {
    loadAll: () => unknown[]
    get: (id: string) => AutomationDataSourceLike | null | undefined
    add: (source: {
      name?: string
      baseUrl: string
      token: string
      intervalMinutes: number
      pullLimit?: number
    }) => unknown
    update: (
      id: string,
      updates: {
        name?: string
        baseUrl?: string
        token?: string
        intervalMinutes?: number
        pullLimit?: number
        enabled?: boolean
      }
    ) => unknown | null
    delete: (id: string) => boolean
    addSessions: (sourceId: string, sessions: Array<{ name: string; remoteSessionId: string }>) => unknown[]
    removeSession: (sourceId: string, sessionId: string) => { targetSessionId?: string | null } | null | undefined
  }
  pullEngine: {
    subscribeSessionImported?: (listener: (sessionId: string) => void) => () => void
    triggerPull: (sourceId: string, sessionId?: string) => Promise<unknown>
    triggerPullAll: (sourceId: string) => Promise<unknown>
    getProgress: () => unknown[]
  }
  collectAndPull?: (sourceId: string, scope: AutomationCollectScope) => Promise<unknown>
  serverInfo?: { port: number; host: string; socket?: string; token: string }
  deleteSessionData?: (sessionId: string) => void
  reloadTimer?: (sourceId: string, immediate?: boolean) => void
  stopTimer?: (sourceId: string) => void
}

export interface AutomationRouteHostContext {
  automation?: AutomationRouteContext
}
