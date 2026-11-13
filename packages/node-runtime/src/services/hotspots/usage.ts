import { randomUUID } from 'node:crypto'
import type { DatabaseAdapter } from '@openchatlab/core'
import type { HotspotBudget, HotspotUsage } from '@openchatlab/shared-types'
import type { ChatTopicModelClient } from '../topics/model-client'

export const defaultHotspotBudget: HotspotBudget = {
  monthlyLimit: null,
  currency: 'CNY',
  modelId: '',
  inputPerMillion: null,
  outputPerMillion: null,
}

/** A persistent receipt is written before every request, including failed requests and invalid output. */
export function createHotspotUsage(db: DatabaseAdapter, now: () => number, budget: () => HotspotBudget) {
  db.exec(`CREATE TABLE IF NOT EXISTS hotspot_usage (
    id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, month TEXT NOT NULL,
    model_id TEXT NOT NULL, purpose TEXT NOT NULL, session_id TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL, reserved REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL,
    status TEXT NOT NULL, messages INTEGER NOT NULL DEFAULT 0, noise INTEGER NOT NULL DEFAULT 0
  );`)
  const month = () => {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(new Date(now() * 1000))
    return `${parts.find((part) => part.type === 'year')!.value}-${parts.find((part) => part.type === 'month')!.value}`
  }
  const priced = (modelId: string) => {
    const cfg = budget()
    return cfg.modelId === modelId && cfg.inputPerMillion !== null && cfg.outputPerMillion !== null
  }
  function snapshot(modelId: string | null): HotspotUsage {
    const cfg = budget()
    if (!db.prepare('SELECT 1 FROM hotspot_lease WHERE expires>?').get(now())) {
      db.prepare("UPDATE hotspot_usage SET status='uncertain',cost=reserved,reserved=0 WHERE status='reserved'").run()
    }
    const rows = db.prepare('SELECT * FROM hotspot_usage WHERE month=?').all(month())
    const uncertainCalls = rows.filter((row) => row.status === 'uncertain').length
    const unpricedCalls = rows.filter((row) => row.cost === null && row.status !== 'reserved').length
    // Currency changes never reinterpret historic receipts as a different denomination.
    const currencyMismatch = rows.some((row) => row.currency !== cfg.currency)
    const estimatedCost = rows
      .filter((row) => row.currency === cfg.currency)
      .reduce((sum, row) => sum + Number(row.cost ?? 0), 0)
    const reservedCost = rows
      .filter((row) => row.currency === cfg.currency && row.status === 'reserved')
      .reduce((sum, row) => sum + Number(row.reserved), 0)
    const limit = cfg.monthlyLimit
    const reason =
      limit === null
        ? null
        : uncertainCalls || currencyMismatch || unpricedCalls
          ? 'uncertain'
          : !modelId || !priced(modelId)
            ? 'pricing'
            : estimatedCost + reservedCost >= limit
              ? 'limit'
              : null
    const groups = new Map<string, { sessionId: string; calls: number; tokens: number; estimatedCost: number }>()
    for (const row of rows) {
      if (!row.session_id) continue
      const id = String(row.session_id)
      const group = groups.get(id) ?? { sessionId: id, calls: 0, tokens: 0, estimatedCost: 0 }
      group.calls++
      group.tokens += Number(row.input_tokens) + Number(row.output_tokens)
      if (row.currency === cfg.currency) group.estimatedCost += Number(row.cost ?? 0)
      groups.set(id, group)
    }
    return {
      month: month(),
      modelId,
      currency: cfg.currency,
      calls: rows.filter((row) => row.purpose !== 'adjustment').length,
      inputTokens: rows.reduce((sum, row) => sum + Number(row.input_tokens), 0),
      outputTokens: rows.reduce((sum, row) => sum + Number(row.output_tokens), 0),
      estimatedCost,
      reservedCost,
      unpricedCalls,
      uncertainCalls,
      monthlyLimit: limit,
      paused: reason !== null,
      reason,
      nearLimit: limit !== null && limit > 0 && estimatedCost + reservedCost >= limit * 0.8,
      byGroup: [...groups.values()].sort((a, b) => b.estimatedCost - a.estimatedCost || b.tokens - a.tokens),
    }
  }
  async function complete(
    model: ChatTopicModelClient,
    prompts: Parameters<ChatTopicModelClient['complete']>[0],
    options: Parameters<ChatTopicModelClient['complete']>[1],
    purpose: 'analysis' | 'digest' | 'search',
    sessionId?: string,
    messageCount = 0
  ) {
    const cfg = budget()
    const id = randomUUID()
    // UTF-8 bytes + framing and the configured output ceiling deliberately overestimate normal usage.
    // Provider billing may differ; this is an estimate guard, never advertised as a provider-enforced money cap.
    const inputCeiling = Buffer.byteLength(prompts.systemPrompt + prompts.userPrompt, 'utf8') + 1024
    const reservation = priced(model.modelId)
      ? (inputCeiling * cfg.inputPerMillion! + (model.maxOutputTokens ?? 4096) * cfg.outputPerMillion!) / 1_000_000
      : 0
    db.transaction(() => {
      const usage = snapshot(model.modelId)
      if (
        usage.paused ||
        (cfg.monthlyLimit !== null && usage.estimatedCost + usage.reservedCost + reservation > cfg.monthlyLimit)
      ) {
        throw Object.assign(new Error(`Hotspot budget paused: ${usage.reason ?? 'limit'}`), { statusCode: 402 })
      }
      db.prepare(
        `INSERT INTO hotspot_usage (id,timestamp,month,model_id,purpose,session_id,reserved,currency,status,messages)
        VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id,
        now(),
        month(),
        model.modelId,
        purpose,
        sessionId ?? null,
        reservation,
        cfg.currency,
        'reserved',
        messageCount
      )
    })
    try {
      const result = await model.complete(prompts, options)
      const inputTokens = result.inputTokens + (result.cacheReadTokens ?? 0) + (result.cacheWriteTokens ?? 0)
      const valid =
        Number.isFinite(inputTokens) &&
        inputTokens >= 0 &&
        Number.isFinite(result.outputTokens) &&
        result.outputTokens >= 0
      const cost =
        valid && priced(model.modelId)
          ? (inputTokens * cfg.inputPerMillion! + result.outputTokens * cfg.outputPerMillion!) / 1_000_000
          : null
      db.prepare('UPDATE hotspot_usage SET input_tokens=?,output_tokens=?,cost=?,reserved=0,status=? WHERE id=?').run(
        valid ? inputTokens : 0,
        valid ? result.outputTokens : 0,
        cost,
        valid ? 'complete' : 'uncertain',
        id
      )
      return { ...result, inputTokens, receiptId: id }
    } catch (error) {
      // Transport errors may already be billable. Keep the reservation and stop budgeted retries.
      db.prepare(
        "UPDATE hotspot_usage SET status='uncertain',cost=reserved,reserved=0 WHERE id=? AND status='reserved'"
      ).run(id)
      throw error
    }
  }
  function settle(amount: number) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)
      throw Object.assign(new Error('Invalid manually reconciled cost'), { statusCode: 400 })
    return db.transaction(() => {
      if (db.prepare('SELECT 1 FROM hotspot_lease WHERE expires>?').get(now()))
        throw Object.assign(new Error('Wait for the current hotspot update to finish'), { statusCode: 409 })
      const cfg = budget()
      const rows = db
        .prepare("SELECT * FROM hotspot_usage WHERE month=? AND (cost IS NULL OR status='uncertain' OR currency<>?)")
        .all(month(), cfg.currency)
      if (!rows.length) return
      // Preserve original receipts for audit; the user supplies the combined cost in the selected currency.
      db.exec('CREATE TABLE IF NOT EXISTS hotspot_usage_reconciliation (id TEXT PRIMARY KEY, payload TEXT NOT NULL)')
      db.prepare('INSERT INTO hotspot_usage_reconciliation VALUES (?,?)').run(
        randomUUID(),
        JSON.stringify({ timestamp: now(), amount, currency: cfg.currency, receipts: rows })
      )
      for (const row of rows)
        db.prepare("UPDATE hotspot_usage SET cost=0,reserved=0,status='settled',currency=? WHERE id=?").run(
          cfg.currency,
          row.id
        )
      db.prepare(
        `INSERT INTO hotspot_usage (id,timestamp,month,model_id,purpose,cost,currency,status) VALUES (?,?,?,?,?,?,?,?)`
      ).run(randomUUID(), now(), month(), cfg.modelId, 'adjustment', amount, cfg.currency, 'manual')
    })
  }
  return { snapshot, complete, settle }
}
