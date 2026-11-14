/**
 * @openchatlab/sync — Session type classification and target selection
 *
 * Collection is a source-level operation: QQ, for example, decrypts the whole
 * database and cannot collect a single conversation. Type and session filters
 * therefore decide which already-collected sessions are pulled.
 */

import { buildRemoteSessionsUrl, parseRemoteSessionsResponse } from './discovery'
import type { RemoteSession } from './types'

export type SessionKind = 'group' | 'private' | 'other'

export interface SessionIdentity {
  type?: string
  id?: string
}

const OTHER_TYPES = new Set(['channel', 'official', 'other'])
const DISCOVERY_PAGE_LIMIT = 500
const DISCOVERY_MAX_PAGES = 100

export function classifySession(session: SessionIdentity): SessionKind {
  const rawType = String(session.type ?? '')
    .trim()
    .toLowerCase()
  const id = String(session.id ?? '')
    .trim()
    .toLowerCase()

  if (rawType === 'group' || id.endsWith('@chatroom')) return 'group'
  if (rawType === 'private') return 'private'
  if (
    OTHER_TYPES.has(rawType) ||
    id.startsWith('gh_') ||
    id.includes('@openim') ||
    (id.startsWith('weixin') && id !== 'weixin')
  ) {
    return 'other'
  }
  return 'other'
}

/**
 * Load every remote session so type filters can map local subscriptions back
 * to the source's declared type.
 */
export async function fetchRemoteSessions(baseUrl: string, token: string): Promise<RemoteSession[]> {
  const sessions: RemoteSession[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  for (let page = 0; page < DISCOVERY_MAX_PAGES; page++) {
    const response = await fetch(buildRemoteSessionsUrl(baseUrl, { cursor, limit: DISCOVERY_PAGE_LIMIT }), {
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Session discovery returned HTTP ${response.status}`)

    const parsed = parseRemoteSessionsResponse(await response.text())
    for (const session of parsed.sessions) {
      if (session && typeof session === 'object' && session.id !== undefined) {
        sessions.push(session)
      }
    }

    if (!parsed.page?.hasMore || !parsed.page.nextCursor) return sessions
    if (seenCursors.has(parsed.page.nextCursor)) {
      throw new Error('Session discovery did not advance its cursor')
    }
    seenCursors.add(parsed.page.nextCursor)
    cursor = parsed.page.nextCursor
  }

  throw new Error('Session discovery page limit reached')
}
