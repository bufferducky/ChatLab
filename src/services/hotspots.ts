import type {
  Hotspot,
  HotspotConfig,
  HotspotFeed,
  HotspotStatus,
  HotspotWindow,
  HotspotDigest,
  HotspotSearch,
  HotspotRecommendation,
  HotspotKnowledgeDraft,
} from '@openchatlab/shared-types'
import { fetchWithAuth } from './utils/http'
async function request<T>(path = '', method = 'GET', body?: unknown): Promise<T> {
  const response = await fetchWithAuth(`/_web/hotspots${path}`, {
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
export const hotspotService = {
  feed: (window: HotspotWindow, saved: boolean) => request<HotspotFeed>(`?window=${window}&saved=${saved}`),
  configure: (config: HotspotConfig) => request<HotspotConfig>('/config', 'PUT', config),
  summarize: (window: HotspotWindow) => request<HotspotDigest | null>('/digest', 'POST', { window }),
  search: (query: string) => request<HotspotSearch>('/search', 'POST', { query }),
  recommendations: () => request<HotspotRecommendation[]>('/recommendations'),
  reconcileUsage: (amount: number) => request('/usage/reconcile', 'POST', { amount }),
  knowledgeDraft: (id: string) => request<HotspotKnowledgeDraft>(`/${encodeURIComponent(id)}/knowledge`),
  exportKnowledge: (id: string, content: string) =>
    request<{ path: string; uri: string }>(`/${encodeURIComponent(id)}/knowledge`, 'POST', { content }),
  update: (rebuild = false) => request<HotspotStatus>('/update', 'POST', { rebuild }),
  feedback: (id: string, value: { topic?: boolean; sessionId?: string; reduced: boolean }) =>
    request<HotspotConfig>(`/${encodeURIComponent(id)}/feedback`, 'POST', value),
  mark: (id: string, value: { read?: boolean; saved?: boolean; dismissed?: boolean }) =>
    request<Hotspot>(`/${encodeURIComponent(id)}`, 'PATCH', value),
}
