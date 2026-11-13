export type HotspotCategory = 'ai' | 'tech' | 'news' | 'gossip' | 'other'
export type HotspotWindow = 'day' | 'week' | 'month'
export type HotspotKind = 'tool' | 'solution' | 'news' | 'discussion' | 'question' | 'noise'
export interface HotspotSource {
  sessionId: string
  sessionName: string
  messageId: number
  timestamp: number
  snippet: string
  fingerprint?: string
}
export interface Hotspot {
  id: string
  title: string
  summary: string
  why: string
  category: HotspotCategory
  confidence: 'discussion' | 'rumor' | 'disputed'
  kind: HotspotKind
  topic: string
  activity: 'new' | 'progress' | 'renewed'
  /** Independent discussions; fingerprints prevent copied forwards from counting again. */
  rounds: Array<{ sessionId: string; startedAt: number; lastAt: number; fingerprints: string[] }>
  heatThrough: number
  firstSeen: number
  updatedAt: number
  readAt: number | null
  dismissed: boolean
  saved: boolean
  archived?: boolean
  sources: HotspotSource[]
  links: string[]
  updates: Array<{ timestamp: number; text: string }>
  outcome?: 'open' | 'proposed' | 'resolved' | 'disputed'
  conclusion?: string
}
export interface HotspotConfig {
  sessionIds: string[]
  enabled: boolean
  locale: string
  interests: string
  categoryPriorities?: Partial<Record<HotspotCategory, number>>
  reducedTopics?: string[]
  reducedSessionIds?: string[]
  budget?: HotspotBudget
  obsidianVault?: string
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
  highlights: string[]
  config: HotspotConfig
  status: HotspotStatus
  usage: HotspotUsage
  digest: HotspotDigest | null
  knowledge: Array<{ id: string; item: Hotspot; exportedPath: string | null; changed: boolean }>
}

export interface HotspotBudget {
  monthlyLimit: number | null
  currency: 'CNY' | 'USD'
  modelId: string
  inputPerMillion: number | null
  outputPerMillion: number | null
}
export interface HotspotUsage {
  month: string
  modelId: string | null
  currency: 'CNY' | 'USD'
  calls: number
  inputTokens: number
  outputTokens: number
  estimatedCost: number
  reservedCost: number
  unpricedCalls: number
  uncertainCalls: number
  monthlyLimit: number | null
  paused: boolean
  reason: 'limit' | 'pricing' | 'uncertain' | null
  nearLimit: boolean
  byGroup: Array<{ sessionId: string; calls: number; tokens: number; estimatedCost: number }>
}
export interface HotspotDigest {
  window: HotspotWindow
  generatedAt: number
  signature: string
  overview: string
  sections: Array<{ title: string; text: string; hotspotIds: string[] }>
  stale: boolean
}
export interface HotspotSearch {
  query: string
  matches: Array<{ item: Hotspot; reason: string }>
  scanned: number
}
export interface HotspotRecommendation {
  sessionId: string
  analyzedMessages: number
  topics: number
  usefulTopics: number
  noiseMessages: number
  repeatedSources: number
  score: number | null
  recommendation: 'focus' | 'normal' | 'less' | 'insufficient'
}
export interface HotspotKnowledgeDraft {
  id: string
  title: string
  content: string
  exportedPath: string | null
}
