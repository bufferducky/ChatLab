import { fetchWithAuth } from './utils/http'

export interface PriceRule {
  id: string
  name: string
  sessionIds: string[]
  keywords: string[]
  excludeKeywords: string[]
  maxPrice: number | null
  historyPercentile: number | null
  minHistorySamples: number
  cooldownMinutes: number
  channelIds: string[]
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export type PriceChannelType = 'webhook' | 'telegram'

export interface PriceChannel {
  id: string
  name: string
  type: PriceChannelType
  url: string
  chatId: string
  enabled: boolean
  createdAt: number
}

export interface PriceHit {
  id: string
  ruleId: string
  sessionId: string
  messageId: number
  finalPrice: number
  originalPrice: number | null
  status: 'pending' | 'sent' | 'failed' | 'suppressed'
  createdAt: number
  payload: string
}

export interface ScanResult {
  sessionId: string
  rulesConsidered: number
  messagesRead: number
  observations: number
  hits: number
  suppressed: number
  delivered: number
  failed: number
}

async function request<T>(path = '', method = 'GET', body?: unknown): Promise<T> {
  const response = await fetchWithAuth(`/_web/price-watch${path}`, {
    method,
    ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(
      error?.message ||
        error?.error?.message ||
        (typeof error?.error === 'string' ? error.error : `HTTP ${response.status}`)
    )
  }
  return response.json() as Promise<T>
}

export const priceWatchService = {
  listRules: () => request<{ rules: PriceRule[] }>('/rules'),
  saveRule: (rule: Partial<PriceRule>, id?: string) =>
    request<{ rule: PriceRule }>(`/rules${id ? `?id=${encodeURIComponent(id)}` : ''}`, 'POST', rule),
  deleteRule: (id: string) => request<{ success: boolean }>(`/rules/${encodeURIComponent(id)}`, 'DELETE'),
  listChannels: () => request<{ channels: PriceChannel[] }>('/channels'),
  saveChannel: (channel: Partial<PriceChannel>, id?: string) =>
    request<{ channel: PriceChannel }>(`/channels${id ? `?id=${encodeURIComponent(id)}` : ''}`, 'POST', channel),
  deleteChannel: (id: string) => request<{ success: boolean }>(`/channels/${encodeURIComponent(id)}`, 'DELETE'),
  listHits: (limit = 50) => request<{ hits: PriceHit[] }>(`/hits?limit=${limit}`),
  listSessions: () => request<{ sessions: Array<{ id: string; name: string }> }>('/sessions'),
  scan: (sessionId: string) => request<ScanResult>(`/scan/${encodeURIComponent(sessionId)}`, 'POST', {}),
  backfill: (sessionId: string, days = 30) =>
    request<{ messages: number; observations: number }>(`/backfill/${encodeURIComponent(sessionId)}`, 'POST', { days }),
  resend: (hitId: string) => request<{ delivered: number }>(`/hits/${encodeURIComponent(hitId)}/resend`, 'POST', {}),
}
