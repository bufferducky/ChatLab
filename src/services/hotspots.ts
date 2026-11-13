import type { Hotspot, HotspotConfig, HotspotFeed, HotspotStatus, HotspotWindow } from '@openchatlab/shared-types'
import { fetchWithAuth } from './utils/http'
async function request<T>(path = '', method = 'GET', body?: unknown): Promise<T> {
  const response = await fetchWithAuth(`/_web/hotspots${path}`, {
    method,
    ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(error?.message || error?.error || `HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}
export const hotspotService = {
  feed: (window: HotspotWindow, saved: boolean) => request<HotspotFeed>(`?window=${window}&saved=${saved}`),
  configure: (config: HotspotConfig) => request<HotspotConfig>('/config', 'PUT', config),
  update: () => request<HotspotStatus>('/update', 'POST'),
  mark: (id: string, value: { read?: boolean; saved?: boolean; dismissed?: boolean }) =>
    request<Hotspot>(`/${encodeURIComponent(id)}`, 'PATCH', value),
}
