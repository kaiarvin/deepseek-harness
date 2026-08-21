/**
 * Cross-session token usage report service (`ctx.sessionUsage`): an
 * incremental usage ledger. Every `assistant/message` carrying provider usage
 * lands as one sample (wall-clock time, provider, model, session, billed
 * tokens) the moment it is appended to a live session — nothing is folded on
 * open. Samples are persisted durably (debounced, atomic temp-file replace)
 * and loaded at service start, so a `report` call buckets in-memory samples
 * by the viewer's local day and answers instantly, with no corpus reads.
 *
 * A first start with no persisted samples backfills once from the session
 * corpus through `ctx.sessionQuery` (exact reads, never the search index),
 * after which the aggregate is purely event-driven.
 *
 * Correctness: `session/event` fires only for live appends — constructor
 * seeds (replay, fork, resume) never publish — so a restart never
 * double-counts. The one-time backfill and the live stream are reconciled by
 * sequence: a live event whose `seq` is within its session's backfill read
 * boundary was already counted by that read and is dropped; events for
 * sessions the backfill never read are all kept. Compaction and session
 * deletion do not retroactively remove counted usage — the ledger counts
 * usage as it happened, it is not a projection of the current log.
 *
 * @module @deepseek-ai/dsh-session-usage-report
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {
  TokenTotals, UsageDay, UsageModelTotals, UsageReport, UsageReportRequest,
} from './types.ts'

export type * from './types.ts'

const DAY_MS = 86_400_000
/** Backfill reads sessions concurrently; live sessions are already in memory. */
const BACKFILL_READ_CONCURRENCY = 4
/** Samples older than this many local days are pruned; the Web dialog shows 30. */
export const DEFAULT_RETENTION_DAYS = 40
/** Debounce before persisting newly appended samples. */
export const DEFAULT_PERSIST_DELAY_MS = 1_000
/** Sample-file format version; a mismatch discards the file instead of migrating it. */
const SAMPLE_FILE_VERSION = 1
/** Single durable file: samples are timezone-independent, so one file serves every viewer. */
const SAMPLE_FILE = 'usage-report-samples.json'

/** Identity of the request header a usage sample is attributed to. */
interface ModelKey {
  readonly provider: string
  readonly model: string
}

/** One provider-reported usage sample: one `assistant/message` with `usage`. */
interface UsageSample {
  /** Event wall-clock ms. */
  readonly time: number
  readonly provider: string
  readonly model: string
  readonly sessionId: string
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** Durable sample file. */
interface DurableSamples {
  readonly version: number
  readonly samples: UsageSample[]
}

/** Mutable per-model fold bucket inside one day (report assembly only). */
interface ModelBucket {
  readonly provider: string
  readonly model: string
  readonly tokens: TokenTotals
  calls: number
  readonly sessions: Set<SessionId>
}

/** Mutable per-day fold bucket (report assembly only). */
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

/** Apply one usage sample's billed token deltas to a model bucket. */
function addSample(bucket: ModelBucket, sample: UsageSample): void {
  bucket.tokens.input += sample.input
  bucket.tokens.output += sample.output
  bucket.tokens.cacheRead += sample.cacheRead
  bucket.tokens.cacheWrite += sample.cacheWrite
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
function modelKeyOf(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/** Construction options (the Cordis plugin config face). */
export interface SessionUsageReportConfig {
  /** Directory for the sample file; defaults to `dshHomePath('usage-report')`. */
  cacheDir?: string
  /** Prune samples older than this many days on load and write; default {@link DEFAULT_RETENTION_DAYS}. */
  retentionDays?: number
  /** Debounce before persisting newly appended samples; default {@link DEFAULT_PERSIST_DELAY_MS}. */
  persistDelayMs?: number
}

/**
 * Replay-aware incremental cross-session usage report service. The report is
 * assembled on every call from the in-memory sample ledger, so it is always
 * current and never blocks on corpus reads after the one-time backfill.
 */
export class SessionUsageReport extends Service {
  private readonly cacheDir: string
  private readonly retentionDays: number
  private readonly persistDelayMs: number
  private query: SessionQueryEngine | undefined
  private samples: UsageSample[] = []
  /** Per-session provider/model of the latest live `request/header`. */
  private readonly attribution = new Map<string, ModelKey>()
  /** Per-session last seq covered by the backfill read; smaller live seqs were already counted. */
  private readonly coveredSeq = new Map<string, number>()
  /** Load + one-time backfill; every entry point awaits it before touching state. */
  private readonly ready: Promise<void>
  private flushTimer: ReturnType<typeof setTimeout> | undefined

  constructor(ctx: Context, config: SessionUsageReportConfig = {}) {
    super(ctx, 'sessionUsage')
    this.cacheDir = config.cacheDir ?? dshHomePath('usage-report')
    this.retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS
    this.persistDelayMs = config.persistDelayMs ?? DEFAULT_PERSIST_DELAY_MS
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      void this._onEvent(session.id, event)
    })
    ctx.effect(() => () => {
      if (this.flushTimer !== undefined) {
        clearTimeout(this.flushTimer)
        this.flushTimer = undefined
      }
      void this._writeSamples(this.samples)
        .catch((error: unknown) => {
          this.ctx.logger.warn(`session-usage-report: final sample write failed: ${String(error)}`)
        })
    }, 'session-usage-report: final sample flush')
    this.ready = this._init()
  }

  /**
   * Load the persisted ledger; backfill from the corpus when absent. The
   * query seam is optional (`ctx.get`, active-fiber read): without it the
   * service still grows from the live stream and the backfill is skipped.
   * Never rejects — a failed backfill leaves an empty ledger that still
   * grows from the live stream.
   */
  private async _init(): Promise<void> {
    try {
      const loaded = await this._loadSamples()
      if (!loaded) {
        this.query = this.ctx.get('sessionQuery') as SessionQueryEngine | undefined
        await this._backfill()
      }
      this._prune()
      // Persist the settled ledger so a cold-start backfill (or a prune) lands
      // on disk once; afterwards every live sample schedules its own flush.
      if (this.samples.length > 0) this._scheduleFlush()
    } catch (error: unknown) {
      /* v8 ignore next -- every step above is fail-soft, so this guards only future regressions */
      this.ctx.logger.warn(`session-usage-report: initialization failed: ${String(error)}`)
    }
  }

  /**
   * Aggregate the complete corpus into samples once (cold start only). Every
   * read records the session's last covered seq so concurrent live appends
   * are not double-counted (see {@link _onEvent}).
   */
  private async _backfill(): Promise<void> {
    const query = this.query
    if (query === undefined) return
    try {
      const records = await query.listSessions()
      const sessionIds = records.map(record => record.header.id)
      for (let index = 0; index < sessionIds.length; index += BACKFILL_READ_CONCURRENCY) {
        const batch = sessionIds.slice(index, index + BACKFILL_READ_CONCURRENCY)
        await Promise.all(batch.map(async (sessionId) => {
          try {
            const snapshot = await query.readSession(sessionId)
            let current: ModelKey | undefined
            let lastSeq = -1
            for (const event of snapshot.events) {
              lastSeq = event.seq
              if (event.type === 'request/header') {
                current = { provider: event.data.header.config.provider, model: event.data.header.config.model }
              } else if (event.type === 'assistant/message' && current !== undefined && event.data.usage !== undefined) {
                const usage = event.data.usage
                this.samples.push({
                  time: event.time,
                  provider: current.provider,
                  model: current.model,
                  sessionId,
                  input: usage.inputTokens,
                  output: usage.outputTokens,
                  cacheRead: usage.cacheReadTokens ?? 0,
                  cacheWrite: usage.cacheWriteTokens ?? 0,
                })
              }
            }
            this.coveredSeq.set(sessionId, lastSeq)
            // Seed attribution so a resumed session's first live usage is
            // attributed even when its request header lives in the seed.
            if (current !== undefined) this.attribution.set(sessionId, current)
          } catch (error) {
            this.ctx.logger.warn(`session-usage-report: skipped session ${sessionId}: ${String(error)}`)
          }
        }))
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(`session-usage-report: backfill failed: ${String(error)}`)
    }
  }

  /** Live-stream entry: reconcile with the backfill boundary, then aggregate. */
  private _onEvent(sessionId: SessionId, event: SessionEvent): void {
    void this.ready.then(() => {
      if (event.seq <= (this.coveredSeq.get(sessionId) ?? -1)) return
      if (event.type === 'request/header') {
        this.attribution.set(sessionId, {
          provider: event.data.header.config.provider,
          model: event.data.header.config.model,
        })
        return
      }
      if (event.type !== 'assistant/message') return
      const current = this.attribution.get(sessionId)
      if (current === undefined || event.data.usage === undefined) return
      this._recordSample(sessionId, current, event.data.usage, event)
    })
  }

  /** Record one usage-bearing `assistant/message` as a sample and schedule persistence. */
  private _recordSample(
    sessionId: SessionId,
    current: ModelKey,
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
    event: SessionEvent,
  ): void {
    this.samples.push({
      time: event.time,
      provider: current.provider,
      model: current.model,
      sessionId,
      input: usage.inputTokens,
      output: usage.outputTokens,
      cacheRead: usage.cacheReadTokens ?? 0,
      cacheWrite: usage.cacheWriteTokens ?? 0,
    })
    this._scheduleFlush()
  }

  /** Drop samples older than the retention window (bounds the file and memory). */
  private _prune(): void {
    const cutoff = Date.now() - this.retentionDays * DAY_MS
    this.samples = this.samples.filter(sample => sample.time >= cutoff)
  }

  /** Debounced, single-flighted durable write of the current ledger. */
  private _scheduleFlush(): void {
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      const snapshot = this.samples.slice()
      void this._writeSamples(snapshot)
        .catch((error: unknown) => {
          this.ctx.logger.warn(`session-usage-report: sample write failed: ${String(error)}`)
        })
    }, this.persistDelayMs)
  }

  /**
   * Fold the sample ledger into a per-day, per-model report for one viewer
   * timezone. Pure over `samples`, so the returned report is always detached.
   * @param request - optional viewer timezone (minutes east of UTC).
   * @param signal - forwarded cancellation; aborted before the ledger is read.
   * @returns the assembled report.
   */
  async report(request: UsageReportRequest = {}, signal?: AbortSignal): Promise<UsageReport> {
    const timezoneOffsetMinutes = request.timezoneOffsetMinutes ?? 0
    signal?.throwIfAborted()
    await this.ready
    return { timezoneOffsetMinutes, days: this._bucket(timezoneOffsetMinutes) }
  }

  /** Bucket the ledger by local day and model for one viewer timezone. */
  private _bucket(timezoneOffsetMinutes: number): UsageDay[] {
    const days = new Map<number, DayBucket>()
    for (const sample of this.samples) {
      const dayStart = localDayStartMs(sample.time, timezoneOffsetMinutes)
      let day = days.get(dayStart)
      if (day === undefined) {
        day = { dayStartMs: dayStart, sessions: new Set(), models: new Map() }
        days.set(dayStart, day)
      }
      day.sessions.add(sample.sessionId as SessionId)
      const key = modelKeyOf(sample.provider, sample.model)
      let bucket = day.models.get(key)
      if (bucket === undefined) {
        bucket = {
          provider: sample.provider,
          model: sample.model,
          tokens: emptyTotals(),
          calls: 0,
          sessions: new Set(),
        }
        day.models.set(key, bucket)
      }
      bucket.sessions.add(sample.sessionId as SessionId)
      addSample(bucket, sample)
      bucket.calls += 1
    }
    return [...days.values()].map(dayOf).sort((a, b) => a.dayStartMs - b.dayStartMs)
  }

  /** Read the durable sample file, or `false` when absent, mismatched, or unreadable. */
  private async _loadSamples(): Promise<boolean> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this._path(), 'utf8'))
    } catch {
      return false
    }
    if (typeof parsed !== 'object' || parsed === null) return false
    const record = parsed as { version?: unknown; samples?: unknown }
    if (record.version !== SAMPLE_FILE_VERSION || !Array.isArray(record.samples)) return false
    this.samples = record.samples.filter((sample): sample is UsageSample => {
      if (typeof sample !== 'object' || sample === null) return false
      const value = sample as Partial<UsageSample>
      return typeof value.time === 'number'
        && typeof value.provider === 'string'
        && typeof value.model === 'string'
        && typeof value.sessionId === 'string'
        && typeof value.input === 'number'
        && typeof value.output === 'number'
        && typeof value.cacheRead === 'number'
        && typeof value.cacheWrite === 'number'
    })
    return true
  }

  /** Persist one ledger snapshot durably with an atomic temp-file replace. */
  private async _writeSamples(samples: readonly UsageSample[]): Promise<void> {
    const target = this._path()
    const temp = `${target}.tmp`
    const record: DurableSamples = { version: SAMPLE_FILE_VERSION, samples: [...samples] }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(temp, JSON.stringify(record), 'utf8')
    await rename(temp, target)
  }

  private _path(): string {
    return join(this.cacheDir, SAMPLE_FILE)
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
