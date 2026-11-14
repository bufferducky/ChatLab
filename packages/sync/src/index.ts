/**
 * @openchatlab/sync
 *
 * Platform-agnostic data sync engine for ChatLab.
 * Provides config management, data source CRUD, remote discovery,
 * pull engine, and scheduler.
 */

export { NOOP_LOGGER } from './types'

export type {
  ApiServerConfig,
  ImportSession,
  DataSource,
  DataSourceUpdatable,
  RemoteSession,
  RemoteSessionDiscoveryPage,
  RemoteSessionDiscoveryResult,
  RemoteSessionDiscoveryQuery,
  FetchParams,
  SyncMeta,
  ImportResult,
  PullSessionResult,
  PullProgress,
  HttpFetcher,
  DataImporter,
  SyncNotifier,
  SyncLogger,
} from './types'

export { ConfigManager } from './config-manager'
export { DataSourceManager, normalizeBaseUrl } from './data-source-manager'
export { buildRemoteSessionsUrl, parseRemoteSessionsResponse } from './discovery'
export { PullEngine, buildPullUrl, deriveLocalSessionId, parseSyncFromFile } from './pull-engine'
export type { PullEngineOptions } from './pull-engine'
export { CollectCoordinator } from './collect'
export type { CollectStatus, CollectOutcome, CollectCoordinatorOptions } from './collect'
export { classifySession, fetchRemoteSessions } from './scope'
export type { SessionKind } from './scope'
export { CollectAndPullService } from './collect-and-pull'
export type { CollectScope, CollectAndPullResult, CollectAndPullServiceOptions } from './collect-and-pull'
export { initScheduler, stopAllTimers, stopTimer, reloadTimer } from './scheduler'
export type { SchedulerOptions } from './scheduler'
