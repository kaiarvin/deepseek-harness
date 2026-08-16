/**
 * Cross-session token usage report service (`ctx.sessionUsage`): folds every
 * logical session's durable log (live sessions first, persisted sessions
 * through the mounted persistence backend) into per-local-day, per-model
 * billed token totals. The fold reads each session once through
 * `ctx.sessionQuery` — exact reads, not the search index — so the report
 * works in every profile that mounts the query seam, and caches its result
 * until a session event invalidates it. The wire face lives in the apiproxy
 * `usage` domain; this package owns the aggregation.
 *
 * @module @deepseek-ai/dsh-session-usage-report
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {
  TokenTotals, UsageDay, UsageModelTotals, UsageReport, UsageReportRequest,
} from './types.ts'

export type * from './types.ts'

const DAY_MS = 86_400_000
/** Persisted sessions read concurrently; live sessions are already in memory. */
const PERSISTED_READ_CONCURRENCY = 4
/**
 * Stale-while-revalidate window: a report call served from cache keeps serving
 * the cached report for this long after a `session/event` marks it dirty (a
 * background rescan refreshes it meanwhile), so rapid dialog opens do not pay
 * a full corpus fold each time.
 */
export const DEFAULT_FRESH_MS = 30_000
/**
 * Durable-cache freshness window: a report loaded from disk is reused as-is
 * (no corpus scan) for this long after it was scanned, surviving process
 * restarts, so a cold dialog open after a restart stays fast. A background
 * rescan refreshes it right after the load, so the served data catches up
 * within seconds.
 */
export const DEFAULT_DISK_FRESH_MS = 3_600_000
/** Durable cache file format version; a mismatch discards the row instead of migrating it. */
const DURABLE_CACHE_VERSION = 1

/** Identity of the request header a usage sample is attributed to. */
interface ModelKey {
  readonly provider: string
  readonly model: string
}

/** Mutable per-model fold bucket inside one day. */
interface ModelBucket {
  readonly provider: string
  readonly model: string
  readonly tokens: TokenTotals
  calls: number
  readonly sessions: Set<SessionId>
}

/** Mutable per-day fold bucket. */
interface DayBucket {
  readonly dayStartMs: number
  readonly sessions: Set<SessionId>
  readonly models: Map<string, ModelBucket>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionUsage: SessionUsageReport
  }
}

/** Start a fresh token bucket. */
function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

/** Add one provider usage sample into a totals bucket (all fields disjoint). */
function addUsage(totals: TokenTotals, usage: {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}): void {
  totals.input += usage.inputTokens
  totals.output += usage.outputTokens
  totals.cacheRead += usage.cacheReadTokens ?? 0
  totals.cacheWrite += usage.cacheWriteTokens ?? 0
}

/**
 * Place an epoch-ms timestamp into the local-day bucket of a viewer whose
 * wall clock is `timezoneOffsetMinutes` east of UTC. The returned epoch ms is
 * the local day's zero hour expressed in UTC — rendering it with the viewer's
 * locale yields that viewer's calendar date.
 * @param time - event time in epoch ms.
 * @param timezoneOffsetMinutes - minutes east of UTC (`Date.getTimezoneOffset()` semantics).
 * @returns the local day start as a UTC epoch ms.
 */
export function localDayStartMs(time: number, timezoneOffsetMinutes: number): number {
  const shifted = time - timezoneOffsetMinutes * 60_000
  return Math.floor(shifted / DAY_MS) * DAY_MS + timezoneOffsetMinutes * 60_000
}

/** Deterministic bucket key for one (provider, model) pair. */
function modelKeyOf(key: ModelKey): string {
  return `${key.provider}\u0000${key.model}`
}

/** One durable cache record on disk (one file per timezone). */
interface DurableUsageCache {
  readonly version: number
  /** Wall-clock ms of the last scan that produced `report`. */
  readonly updatedAt: number
  readonly timezoneOffsetMinutes: number
  readonly report: UsageReport
}

/** Construction options (the Cordis plugin config face). */
export interface SessionUsageReportConfig {
  /** Stale-while-revalidate window in ms; see {@link DEFAULT_FRESH_MS}. */
  freshMs?: number
  /** Durable-cache freshness window in ms; see {@link DEFAULT_DISK_FRESH_MS}. */
  diskFreshMs?: number
  /** Directory for the durable cache; defaults to `dshHomePath('usage-report')`. */
  cacheDir?: string
}

/**
 * Replay-aware cross-session usage report service. The report is cached per
 * requested timezone; a `session/event` marks it dirty, and a dirty cache is
 * still served for the fresh window while a background rescan refreshes it —
 * a report call rescans synchronously only when its cache is cold or has been
 * dirty past the fresh window. Fresh scans are also persisted to disk per
 * timezone, so a process restart reuses the last scan within the disk fresh
 * window instead of paying a full corpus fold on the first cold open.
 */
export class SessionUsageReport extends Service {
  private readonly _cache = new Map<number, UsageReport>()
  private dirty = true
  private scannedAt = 0
  private refreshing = false
  private readonly freshMs: number
  private readonly diskFreshMs: number
  private readonly cacheDir: string
  private query: SessionQueryEngine | undefined

  constructor(ctx: Context, config: SessionUsageReportConfig = {}) {
    super(ctx, 'sessionUsage')
    this.freshMs = config.freshMs ?? DEFAULT_FRESH_MS
    this.diskFreshMs = config.diskFreshMs ?? DEFAULT_DISK_FRESH_MS
    this.cacheDir = config.cacheDir ?? dshHomePath('usage-report')
    ctx.inject(['sessionQuery'], (childCtx) => {
      this.query = childCtx.sessionQuery
    })
    ctx.on('session/event', () => {
      this.dirty = true
    })
  }

  /**
   * Fold the complete logical corpus into a per-day, per-model usage report.
   * @param request - optional viewer timezone (minutes east of UTC).
   * @param signal - optional cancellation for corpus listing and reads.
   * @returns a detached report; sessions or reads that fail individually are skipped.
   */
  async report(request: UsageReportRequest = {}, signal?: AbortSignal): Promise<UsageReport> {
    const timezoneOffsetMinutes = request.timezoneOffsetMinutes ?? 0
    signal?.throwIfAborted()
    const cached = this._cache.get(timezoneOffsetMinutes)
    if (cached !== undefined) {
      const fresh = Date.now() - this.scannedAt
      if (!this.dirty || fresh < this.freshMs) {
        if (this.dirty && !this.refreshing) this._refresh(timezoneOffsetMinutes)
        return structuredClone(cached)
      }
    } else {
      const durable = await this._loadDurable(timezoneOffsetMinutes)
      if (durable !== undefined) {
        // The disk copy becomes the in-memory cache and is served instantly;
        // a background rescan then refreshes it (a fresh process has no event
        // history, so dirty stays set and drives that refresh).
        this._cache.set(timezoneOffsetMinutes, durable.report)
        this.scannedAt = durable.updatedAt
        if (this.dirty && !this.refreshing) this._refresh(timezoneOffsetMinutes)
        return structuredClone(durable.report)
      }
    }

    const report = await this._scan(timezoneOffsetMinutes, signal)
    this._stash(timezoneOffsetMinutes, report)
    return report
  }

  /** Fire-and-forget background rescan of one timezone bucket, single-flighted. */
  private _refresh(timezoneOffsetMinutes: number): void {
    this.refreshing = true
    this._scan(timezoneOffsetMinutes)
      .then((report) => { this._stash(timezoneOffsetMinutes, report) })
      .catch((error: unknown) => {
        this.ctx.logger.warn(`session-usage-report: background refresh failed: ${String(error)}`)
      })
      .finally(() => { this.refreshing = false })
  }

  /** Record one scan result as the fresh cache and persist it durably (fail-soft). */
  private _stash(timezoneOffsetMinutes: number, report: UsageReport): void {
    this._cache.set(timezoneOffsetMinutes, structuredClone(report))
    this.scannedAt = Date.now()
    this.dirty = false
    this._writeDurable(timezoneOffsetMinutes, report)
  }

  /**
   * Read one timezone's durable cache, or `undefined` when absent, stale past
   * the disk fresh window, or unreadable (all fail-soft: a lost or corrupt
   * cache costs one full scan on the next cold read).
   */
  private async _loadDurable(timezoneOffsetMinutes: number): Promise<DurableUsageCache | undefined> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this._durablePath(timezoneOffsetMinutes), 'utf8'))
    } catch {
      return undefined
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as {
      version?: unknown
      updatedAt?: unknown
      timezoneOffsetMinutes?: unknown
      report?: unknown
    }
    if (record.version !== DURABLE_CACHE_VERSION
      || record.timezoneOffsetMinutes !== timezoneOffsetMinutes
      || typeof record.updatedAt !== 'number'
      || typeof record.report !== 'object' || record.report === null) {
      return undefined
    }
    if (Date.now() - record.updatedAt >= this.diskFreshMs) return undefined
    return {
      version: DURABLE_CACHE_VERSION,
      updatedAt: record.updatedAt,
      timezoneOffsetMinutes,
      report: record.report as UsageReport,
    }
  }

  /** Persist one report durably with an atomic temp-file replace (fail-soft). */
  private _writeDurable(timezoneOffsetMinutes: number, report: UsageReport): void {
    const record: DurableUsageCache = {
      version: DURABLE_CACHE_VERSION,
      updatedAt: Date.now(),
      timezoneOffsetMinutes,
      report,
    }
    const target = this._durablePath(timezoneOffsetMinutes)
    const temp = `${target}.tmp`
    void mkdir(dirname(target), { recursive: true })
      .then(() => writeFile(temp, JSON.stringify(record), 'utf8'))
      .then(() => rename(temp, target))
      .catch((error: unknown) => {
        this.ctx.logger.warn(`session-usage-report: durable cache write failed: ${String(error)}`)
      })
  }

  private _durablePath(timezoneOffsetMinutes: number): string {
    return join(this.cacheDir, `usage-report-${timezoneOffsetMinutes}.json`)
  }

  /** One full corpus fold. */
  private async _scan(timezoneOffsetMinutes: number, signal?: AbortSignal): Promise<UsageReport> {
    const query = this.query
    if (query === undefined) return { timezoneOffsetMinutes, days: [] }
    const records = await query.listSessions(signal)

    const days = new Map<number, DayBucket>()
    const sessionIds = records.map(record => record.header.id)
    for (let index = 0; index < sessionIds.length; index += PERSISTED_READ_CONCURRENCY) {
      signal?.throwIfAborted()
      const batch = sessionIds.slice(index, index + PERSISTED_READ_CONCURRENCY)
      await Promise.all(batch.map(async (sessionId) => {
        try {
          const snapshot = await query.readSession(sessionId)
          this._foldSession(days, sessionId, snapshot.events, timezoneOffsetMinutes)
        } catch (error) {
          this.ctx.logger.warn(`session-usage-report: skipped session ${sessionId}: ${String(error)}`)
        }
      }))
    }
    return {
      timezoneOffsetMinutes,
      days: [...days.values()].map(dayOf).sort((a, b) => a.dayStartMs - b.dayStartMs),
    }
  }

  /**
   * Fold one session's raw events into the day buckets. Attribution follows
   * the latest preceding `request/header`; only `assistant/message` events
   * carrying provider usage count.
   */
  private _foldSession(
    days: Map<number, DayBucket>,
    sessionId: SessionId,
    events: readonly SessionEvent[],
    timezoneOffsetMinutes: number,
  ): void {
    let current: ModelKey | undefined
    let currentDayStart = Number.NaN
    let currentDay: DayBucket | undefined
    for (const event of events) {
      if (event.type === 'request/header') {
        const config = event.data.header.config
        current = { provider: config.provider, model: config.model }
        continue
      }
      if (event.type !== 'assistant/message' || current === undefined) continue
      const usage = event.data.usage
      if (usage === undefined) continue
      const dayStart = localDayStartMs(event.time, timezoneOffsetMinutes)
      if (dayStart !== currentDayStart || currentDay === undefined) {
        currentDay = days.get(dayStart) ?? { dayStartMs: dayStart, sessions: new Set(), models: new Map() }
        days.set(dayStart, currentDay)
        currentDayStart = dayStart
      }
      const day = currentDay
      day.sessions.add(sessionId)
      const key = modelKeyOf(current)
      let bucket = day.models.get(key)
      if (bucket === undefined) {
        bucket = {
          provider: current.provider,
          model: current.model,
          tokens: emptyTotals(),
          calls: 0,
          sessions: new Set(),
        }
        day.models.set(key, bucket)
      }
      bucket.sessions.add(sessionId)
      addUsage(bucket.tokens, usage)
      bucket.calls += 1
    }
  }
}

/** Freeze a day bucket into its detached report shape. */
function dayOf(day: DayBucket): UsageDay {
  const models: UsageModelTotals[] = [...day.models.values()]
    .map(bucket => ({
      provider: bucket.provider,
      model: bucket.model,
      tokens: { ...bucket.tokens },
      calls: bucket.calls,
      sessions: bucket.sessions.size,
    }))
    .sort((a, b) => totalOf(b.tokens) - totalOf(a.tokens))
  const tokens = models.reduce<TokenTotals>(
    (total, model) => {
      total.input += model.tokens.input
      total.output += model.tokens.output
      total.cacheRead += model.tokens.cacheRead
      total.cacheWrite += model.tokens.cacheWrite
      return total
    },
    emptyTotals(),
  )
  return { dayStartMs: day.dayStartMs, sessions: day.sessions.size, tokens, models }
}

/** Billed token total of one bucket (disjoint input buckets plus output). */
function totalOf(tokens: TokenTotals): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output
}

export default SessionUsageReport
