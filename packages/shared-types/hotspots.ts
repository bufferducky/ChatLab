export type HotspotCategory = 'ai' | 'tech' | 'news' | 'gossip' | 'other'
export type HotspotWindow = 'day' | 'week' | 'month'
export interface HotspotSource {
  sessionId: string
  sessionName: string
  messageId: number
  timestamp: number
  snippet: string
}
export interface Hotspot {
  id: string
  title: string
  summary: string
  why: string
  category: HotspotCategory
  confidence: 'discussion' | 'rumor'
  firstSeen: number
  updatedAt: number
  readAt: number | null
  dismissed: boolean
  saved: boolean
  sources: HotspotSource[]
  links: string[]
  updates: Array<{ timestamp: number; text: string }>
}
export interface HotspotConfig {
  sessionIds: string[]
  enabled: boolean
  locale: string
  interests: string
}
export interface HotspotStatus {
  running: boolean
  lastAttempt: number | null
  lastCompleted: number | null
  analyzedThrough: number | null
  sourceLatest: number | null
  backlog: number
  modelCalls: number
  inputTokens: number
  outputTokens: number
  error: string | null
}
export interface HotspotFeed {
  items: Hotspot[]
  config: HotspotConfig
  status: HotspotStatus
}
