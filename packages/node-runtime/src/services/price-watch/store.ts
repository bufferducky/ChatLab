import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseAdapter } from '@openchatlab/core'
import { openBetterSqliteDatabase } from '../../better-sqlite3-adapter'

/**
 * Price watch storage: a shared database next to the chat databases, not inside
 * them. Rules span several groups, and none of this data belongs to a session.
 */

export interface PriceRuleDraft {
  name: string
  sessionIds: string[]
  keywords: string[]
  excludeKeywords: string[]
  maxPrice: number | null
  historyPercentile: number | null
  /** Minimum number of stored observations before the percentile condition applies. */
  minHistorySamples: number
  cooldownMinutes: number
  channelIds: string[]
  enabled: boolean
}

export interface PriceRule extends PriceRuleDraft {
  id: string
  createdAt: number
  updatedAt: number
}

export type PriceChannelType = 'webhook' | 'telegram'

export interface PriceChannel {
  id: string
  name: string
  type: PriceChannelType
  /** webhook: target URL. telegram: bot token. */
  url: string
  /** telegram only */
  chatId: string
  enabled: boolean
  createdAt: number
}

export interface PriceObservation {
  ruleId: string
  fingerprint: string
  sessionId: string
  messageId: number
  price: number
  ts: number
}

export type PriceHitStatus = 'pending' | 'sent' | 'failed' | 'suppressed'

export interface PriceHit {
  id: string
  ruleId: string
  sessionId: string
  messageId: number
  fingerprint: string
  finalPrice: number
  originalPrice: number | null
  payload: string
  status: PriceHitStatus
  createdAt: number
}

export interface PriceCursor {
  ruleId: string
  sessionId: string
  lastMessageId: number
}

export interface PriceWatchStore {
  listRules(): PriceRule[]
  saveRule(rule: PriceRule): void
  deleteRule(ruleId: string): void
  listChannels(): PriceChannel[]
  saveChannel(channel: PriceChannel): void
  deleteChannel(channelId: string): void
  getCursors(ruleId: string): PriceCursor[]
  setCursor(ruleId: string, sessionId: string, lastMessageId: number): void
  addObservations(observations: PriceObservation[]): void
  /** Recent prices for distinct source messages, newest first. */
  listObservationPrices(fingerprint: string, limit: number): Array<{ price: number; ts: number }>
  /** True when this rule already pushed a comparable price recently. */
  hasRecentHit(ruleId: string, fingerprint: string, price: number, since: number): boolean
  addHit(hit: PriceHit): void
  updateHitStatus(hitId: string, status: PriceHitStatus): void
  listHits(limit: number): PriceHit[]
  close(): void
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS price_rule (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS price_channel (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS price_rule_cursor (
    rule_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    last_message_id INTEGER NOT NULL,
    PRIMARY KEY (rule_id, session_id)
  );
  CREATE TABLE IF NOT EXISTS price_observation (
    rule_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    session_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    price REAL NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (rule_id, session_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_price_observation_fingerprint
    ON price_observation(fingerprint, ts);
  CREATE TABLE IF NOT EXISTS price_hit (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    final_price REAL NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_price_hit_created_at ON price_hit(created_at);
  CREATE INDEX IF NOT EXISTS idx_price_hit_dedupe ON price_hit(rule_id, fingerprint, created_at);
`

export function openPriceWatchStore(dataDir: string, nativeBinding?: string): PriceWatchStore {
  const directory = path.join(dataDir, 'price-watch')
  fs.mkdirSync(directory, { recursive: true })
  const db = openBetterSqliteDatabase(path.join(directory, 'price-watch.db'), { nativeBinding })
  db.pragma('busy_timeout = 5000')
  db.exec(SCHEMA)

  const readJSON = <T>(payload: string): T => JSON.parse(payload) as T

  return {
    listRules() {
      const rows = db.prepare('SELECT payload FROM price_rule ORDER BY created_at').all() as Array<{ payload: string }>
      return rows.map((row) => readJSON<PriceRule>(row.payload))
    },
    saveRule(rule) {
      db.prepare(
        `INSERT INTO price_rule(id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(rule.id, JSON.stringify(rule), rule.createdAt, rule.updatedAt)
    },
    deleteRule(ruleId) {
      db.transaction(() => {
        db.prepare('DELETE FROM price_rule WHERE id = ?').run(ruleId)
        db.prepare('DELETE FROM price_rule_cursor WHERE rule_id = ?').run(ruleId)
      })
    },
    listChannels() {
      const rows = db.prepare('SELECT payload FROM price_channel ORDER BY created_at').all() as Array<{
        payload: string
      }>
      return rows.map((row) => readJSON<PriceChannel>(row.payload))
    },
    saveChannel(channel) {
      db.prepare(
        `INSERT INTO price_channel(id, payload, created_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`
      ).run(channel.id, JSON.stringify(channel), channel.createdAt)
    },
    deleteChannel(channelId) {
      db.prepare('DELETE FROM price_channel WHERE id = ?').run(channelId)
    },
    getCursors(ruleId) {
      const rows = db
        .prepare('SELECT rule_id, session_id, last_message_id FROM price_rule_cursor WHERE rule_id = ?')
        .all(ruleId) as Array<{ rule_id: string; session_id: string; last_message_id: number }>
      return rows.map((row) => ({
        ruleId: row.rule_id,
        sessionId: row.session_id,
        lastMessageId: row.last_message_id,
      }))
    },
    setCursor(ruleId, sessionId, lastMessageId) {
      db.prepare(
        `INSERT INTO price_rule_cursor(rule_id, session_id, last_message_id) VALUES (?, ?, ?)
         ON CONFLICT(rule_id, session_id) DO UPDATE SET last_message_id = excluded.last_message_id`
      ).run(ruleId, sessionId, lastMessageId)
    },
    addObservations(observations) {
      const statement = db.prepare(
        `INSERT OR REPLACE INTO price_observation(rule_id, fingerprint, session_id, message_id, price, ts)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      db.transaction(() => {
        for (const item of observations) {
          statement.run(item.ruleId, item.fingerprint, item.sessionId, item.messageId, item.price, item.ts)
        }
      })
    },
    listObservationPrices(fingerprint, limit) {
      const rows = db
        .prepare(
          `SELECT price, ts FROM price_observation WHERE fingerprint = ?
           GROUP BY session_id, message_id ORDER BY ts DESC LIMIT ?`
        )
        .all(fingerprint, limit) as Array<{ price: number; ts: number }>
      return rows
    },
    hasRecentHit(ruleId, fingerprint, price, since) {
      const row = db
        .prepare(
          `SELECT 1 AS present FROM price_hit
           WHERE rule_id = ? AND fingerprint = ? AND created_at >= ?
             AND final_price BETWEEN ? AND ?
           LIMIT 1`
        )
        .get(ruleId, fingerprint, since, price * 0.99, price * 1.01) as { present: number } | undefined
      return Boolean(row)
    },
    addHit(hit) {
      db.prepare(
        `INSERT INTO price_hit(id, payload, rule_id, fingerprint, final_price, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(hit.id, hit.payload, hit.ruleId, hit.fingerprint, hit.finalPrice, hit.status, hit.createdAt)
    },
    updateHitStatus(hitId, status) {
      db.prepare('UPDATE price_hit SET status = ? WHERE id = ?').run(status, hitId)
    },
    listHits(limit) {
      const rows = db
        .prepare(
          `SELECT id, payload, rule_id, fingerprint, final_price, status, created_at
           FROM price_hit ORDER BY created_at DESC LIMIT ?`
        )
        .all(limit) as Array<{
        id: string
        payload: string
        rule_id: string
        fingerprint: string
        final_price: number
        status: string
        created_at: number
      }>
      return rows.map((row) => ({
        id: row.id,
        ruleId: row.rule_id,
        sessionId: readJSON<{ sessionId?: string }>(row.payload).sessionId ?? '',
        messageId: readJSON<{ messageId?: number }>(row.payload).messageId ?? 0,
        fingerprint: row.fingerprint,
        finalPrice: row.final_price,
        originalPrice: readJSON<{ originalPrice?: number | null }>(row.payload).originalPrice ?? null,
        payload: row.payload,
        status: row.status as PriceHitStatus,
        createdAt: row.created_at,
      }))
    },
    close() {
      ;(db as DatabaseAdapter & { close?: () => void }).close?.()
    },
  }
}
