import type {
  ChatTopicDay,
  ChatTopicPreflight,
  ChatTopicRun,
  ChatTopicRangeKind,
  CreateChatTopicsRequest,
  ChatTopicAutomationSettings,
  ChatTopicGlobalAutomationSettings,
  ChatTopicFeed,
} from '@openchatlab/shared-types'

export interface ChatTopicsAdapter {
  getGlobalAutomation(): Promise<ChatTopicGlobalAutomationSettings>
  setGlobalAutomation(settings: ChatTopicGlobalAutomationSettings): Promise<ChatTopicGlobalAutomationSettings>
  getFeed(sessionId: string): Promise<ChatTopicFeed>
  setAutomation(sessionId: string, settings: ChatTopicAutomationSettings): Promise<ChatTopicFeed>
  updateFeed(sessionId: string): Promise<ChatTopicRun | null>
  markRead(sessionId: string, topics: Array<{ id: string; version: number }>): Promise<void>
  preflight(sessionId: string, request: CreateChatTopicsRequest): Promise<ChatTopicPreflight>
  start(sessionId: string, request: CreateChatTopicsRequest): Promise<ChatTopicRun>
  generateDay(sessionId: string, dayKey: string, timezone: string, locale?: string): Promise<ChatTopicRun>
  getLatestRun(sessionId: string): Promise<ChatTopicRun | null>
  getRun(sessionId: string, runId: string): Promise<ChatTopicRun>
  pause(sessionId: string, runId: string): Promise<ChatTopicRun>
  resume(sessionId: string, runId: string): Promise<ChatTopicRun>
  cancel(sessionId: string, runId: string): Promise<ChatTopicRun>
  getDay(sessionId: string, dayKey: string, timezone: string): Promise<ChatTopicDay | null>
  deleteDay(sessionId: string, dayKey: string): Promise<boolean>
}

export type { ChatTopicDay, ChatTopicPreflight, ChatTopicRangeKind, ChatTopicRun, CreateChatTopicsRequest }
