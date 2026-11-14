/**
 * @openchatlab/sync — Collect then pull
 *
 * One manual action: ask the source to collect now, then pull the selected
 * sessions. A source without on-demand collection still gets a plain pull.
 */

import { NOOP_LOGGER } from './types'
import type { CollectCoordinator, CollectOutcome } from './collect'
import type { DataSourceManager } from './data-source-manager'
import type { PullEngine } from './pull-engine'
import { classifySession, fetchRemoteSessions } from './scope'
import type { SessionKind } from './scope'
import type { DataSource, SyncLogger } from './types'

export interface CollectScope {
  type?: SessionKind
  sessionIds?: string[]
}

export interface CollectAndPullResult {
  collect: CollectOutcome
  pull: {
    sessions: number
    newMessages: number
    errors: string[]
  }
}

export interface CollectAndPullServiceOptions {
  dsManager: DataSourceManager
  pullEngine: PullEngine
  collect: CollectCoordinator
  logger?: SyncLogger
}

export class CollectAndPullService {
  private dsManager: DataSourceManager
  private pullEngine: PullEngine
  private collect: CollectCoordinator
  private logger: SyncLogger

  constructor(options: CollectAndPullServiceOptions) {
    this.dsManager = options.dsManager
    this.pullEngine = options.pullEngine
    this.collect = options.collect
    this.logger = options.logger ?? NOOP_LOGGER
  }

  async run(sourceId: string, scope: CollectScope = {}): Promise<CollectAndPullResult> {
    const ds = this.dsManager.get(sourceId)
    if (!ds) throw new Error('Data source not found')

    const collect = await this.collect.collect(ds.baseUrl, ds.token)
    if (collect.state === 'failed' || collect.state === 'timeout') {
      // Collection problems must not hide already collected data.
      this.logger.warn(`[Collect] ${collect.state} for ${ds.baseUrl}; pulling previously collected data`)
    }

    const targets = await this.resolveTargets(ds, scope)
    const pull = await this.pullEngine.pullSessions(sourceId, targets)
    return {
      collect,
      pull: { sessions: targets.length, newMessages: pull.newMessages, errors: pull.errors },
    }
  }

  private async resolveTargets(ds: DataSource, scope: CollectScope): Promise<string[]> {
    if (scope.sessionIds?.length) return scope.sessionIds
    if (!scope.type) return ds.sessions.map((session) => session.id)

    const remote = await fetchRemoteSessions(ds.baseUrl, ds.token)
    const kinds = new Map(remote.map((session) => [String(session.id), classifySession(session)]))
    return ds.sessions
      .filter((session) => kinds.get(session.remoteSessionId) === scope.type)
      .map((session) => session.id)
  }
}
