import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionUsageReport, { localDayStartMs } from '@deepseek-ai/dsh-session-usage-report'

const DAY_MS = 86_400_000
const SAMPLE_FILE = 'usage-report-samples.json'

/** A session-query backend that serves only the live corpus (no search, no persistence). */
class LiveOnlySessionQuery extends SessionQueryEngine {
  constructor(ctx: Context) {
    super(ctx, {})
  }

  async searchSessions(): Promise<never> {
    throw new Error('search is not used by usage-report tests')
  }

  async searchEvents(): Promise<never> {
    throw new Error('search is not used by usage-report tests')
  }
}

/** A session-query backend that counts corpus reads, for scan-budget assertions. */
class CountingSessionQuery extends LiveOnlySessionQuery {
  listCalls = 0
  readCalls = 0

  override async listSessions(signal?: AbortSignal) {
    this.listCalls += 1
    return super.listSessions(signal)
  }

  override async readSession(sessionId: Parameters<SessionQueryEngine['readSession']>[0]) {
    this.readCalls += 1
    return super.readSession(sessionId)
  }
}

/** A session-query backend whose exact reads always fail (one corrupt session). */
class FailingReadQuery extends CountingSessionQuery {
  override async readSession(sessionId: Parameters<SessionQueryEngine['readSession']>[0]): Promise<never> {
    this.readCalls += 1
    throw new Error(`corrupt session ${sessionId}`)
  }
}

/** A session-query backend whose corpus listing always fails. */
class FailingListQuery extends LiveOnlySessionQuery {
  override async listSessions(): Promise<never> {
    throw new Error('persistence listing failed')
  }
}

/** The session's private append-only log (avoids the events snapshot cache). */
function logOf(session: Session): SessionEvent[] {
  return (session as unknown as { log: SessionEvent[] }).log
}

/** Inject one event with a controlled timestamp and contiguous seq, bypassing the append clock. */
function appendAt(session: Session, time: number, event: Record<string, unknown>): void {
  const log = logOf(session)
  log.push({ ...event, seq: log.length, time } as unknown as SessionEvent)
}

/** The minimal header a usage-report fold needs: provider + model. */
function header(provider: string, model: string) {
  return {
    header: { config: { provider, model } },
    reason: 'initial' as const,
  }
}

/** One assistant step with provider usage at a chosen timestamp (direct log injection). */
function usageStep(
  session: Session,
  time: number,
  provider: string,
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
  turn = 1,
  step = 1,
): void {
  appendAt(session, time, {
    type: 'request/header',
    data: header(provider, model),
  })
  appendAt(session, time, {
    type: 'step/start',
    data: { turn, step },
  })
  appendAt(session, time, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      turn,
      step,
      message: createMessage({
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider, model },
      }),
      usage,
    },
  })
  appendAt(session, time, {
    type: 'step/end',
    data: { turn, step },
  })
}

/** Append one real assistant step with usage to a live session (drives session/event). */
function appendRealStep(session: Session, input: number): void {
  session.append('request/header', {
    header: { config: { provider: 'mock', model: 'alpha' } },
    reason: 'initial',
  })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [],
      source: { kind: 'model', provider: 'mock', model: 'alpha' },
    }),
    usage: { inputTokens: input, outputTokens: 1 },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
}

interface HarnessOptions {
  cacheDir?: string
  /** Omit `cacheDir` entirely so the service uses its default (DSH home) location. */
  noCacheDir?: boolean
  retentionDays?: number
  persistDelayMs?: number
  /** Run before the usage service starts, so its one-time backfill sees these sessions. */
  seed?: (ctx: Context) => void
}

async function harness(
  options: HarnessOptions = {},
): Promise<{ ctx: Context; usage: SessionUsageReport; query: CountingSessionQuery }> {
  const cacheDir = options.noCacheDir === true ? undefined : (options.cacheDir ?? mkdtempSync(join(tmpdir(), 'usage-report-test-')))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CountingSessionQuery)
  options.seed?.(ctx)
  await ctx.plugin(SessionUsageReport, {
    ...cacheDir === undefined ? {} : { cacheDir },
    ...options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays },
    ...options.persistDelayMs === undefined ? {} : { persistDelayMs: options.persistDelayMs },
  })
  const usage = ctx.get('sessionUsage') as SessionUsageReport
  const query = ctx.get('sessionQuery') as CountingSessionQuery
  return { ctx, usage, query }
}

describe('localDayStartMs', () => {
  it('places an epoch ms into the UTC day at offset 0', () => {
    const start = Date.UTC(2026, 0, 15, 12, 0, 0)
    expect(localDayStartMs(start, 0)).toBe(Date.UTC(2026, 0, 15))
    expect(localDayStartMs(Date.UTC(2026, 0, 15, 0, 0, 0), 0)).toBe(Date.UTC(2026, 0, 15))
  })

  it('shifts day boundaries by the viewer offset', () => {
    // 2026-01-15T22:00Z is 2026-01-16 06:00 in UTC+8 (offset -480 minutes).
    const instant = Date.UTC(2026, 0, 15, 22, 0, 0)
    expect(localDayStartMs(instant, -480)).toBe(Date.UTC(2026, 0, 15, 16, 0, 0))
    expect(localDayStartMs(instant, 0)).toBe(Date.UTC(2026, 0, 15))
  })
})

describe('SessionUsageReport live aggregation', () => {
  it('reports an empty corpus as no days', async () => {
    const { usage } = await harness()
    const report = await usage.report()
    expect(report.days).toEqual([])
  })

  it('aggregates live appends into one day bucket with per-model totals', async () => {
    const { ctx, usage } = await harness()
    const session = ctx.sessions.create()
    appendRealStep(session, 100)
    appendRealStep(session, 50)

    const report = await usage.report()
    expect(report.days).toHaveLength(1)
    const day = report.days[0]!
    expect(day.sessions).toBe(1)
    expect(day.tokens).toEqual({ input: 150, output: 2, cacheRead: 0, cacheWrite: 0 })
    expect(day.models).toHaveLength(1)
    const model = day.models[0]!
    expect(model).toMatchObject({ provider: 'mock', model: 'alpha', calls: 2, sessions: 1 })
    expect(model.tokens).toEqual({ input: 150, output: 2, cacheRead: 0, cacheWrite: 0 })
  })

  it('reflects new appends immediately without any corpus read', async () => {
    const { ctx, usage, query } = await harness()
    // Settle the one-time cold-start backfill before opening the live stream,
    // so the no-corpus-read assertion below measures only the live path.
    await usage.report()
    const readsBefore = query.listCalls
    const session = ctx.sessions.create()
    appendRealStep(session, 10)
    const first = await usage.report()
    expect(first.days[0]!.models[0]!.calls).toBe(1)
    expect(first.days[0]!.tokens.input).toBe(10)

    // The ledger is event-driven: more appends change the report without a
    // single additional corpus read.
    appendRealStep(session, 20)
    const second = await usage.report()
    expect(second.days[0]!.models[0]!.calls).toBe(2)
    expect(second.days[0]!.tokens.input).toBe(30)
    expect(query.listCalls).toBe(readsBefore)
    expect(query.readCalls).toBe(0)
  })

  it('attributes usage to the latest preceding request header', async () => {
    const { ctx, usage } = await harness()
    const session = ctx.sessions.create()
    session.append('request/header', {
      header: { config: { provider: 'mock', model: 'alpha' } },
      reason: 'initial',
    })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: 'mock', model: 'alpha' },
      }),
      usage: { inputTokens: 10, outputTokens: 1 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('request/header', {
      header: { config: { provider: 'mock', model: 'beta' } },
      reason: 'initial',
    })
    session.append('step/start', { turn: 1, step: 2 })
    session.append('assistant/message', {
      turn: 1,
      step: 2,
      message: createMessage({
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: 'mock', model: 'beta' },
      }),
      usage: { inputTokens: 20, outputTokens: 2 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 2 })

    const report = await usage.report()
    const models = report.days[0]!.models
    expect(models.map(model => model.model).sort()).toEqual(['alpha', 'beta'])
    expect(models.find(model => model.model === 'alpha')!.tokens.output).toBe(1)
    expect(models.find(model => model.model === 'beta')!.tokens.output).toBe(2)
  })

  it('skips assistant messages without provider usage', async () => {
    const { ctx, usage } = await harness()
    const session = ctx.sessions.create()
    session.append('request/header', {
      header: { config: { provider: 'mock', model: 'alpha' } },
      reason: 'initial',
    })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: 'mock', model: 'alpha' },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })

    const report = await usage.report()
    expect(report.days).toEqual([])
  })

  it('skips live usage without a preceding request header', async () => {
    const { ctx, usage } = await harness()
    // Settle the one-time backfill, then append usage with no request header:
    // the sample has no attribution and must be skipped.
    await usage.report()
    const session = ctx.sessions.create()
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: 'mock', model: 'alpha' },
      }),
      usage: { inputTokens: 1, outputTokens: 1 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })

    const report = await usage.report()
    expect(report.days).toEqual([])
  })

  it('detaches the returned report from the ledger', async () => {
    const { ctx, usage } = await harness()
    const session = ctx.sessions.create()
    appendRealStep(session, 1)

    const first = await usage.report()
    first.days[0]!.tokens.input = 999
    const second = await usage.report()
    expect(second.days[0]!.tokens.input).toBe(1)
  })
})

describe('SessionUsageReport one-time backfill', () => {
  it('folds a seeded corpus once on cold start', async () => {
    const noon = Date.now() - DAY_MS
    const { usage, query } = await harness({ seed: (seedCtx) => {
      const session = seedCtx.sessions.create()
      usageStep(session, noon, 'mock', 'alpha', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 })
      usageStep(session, noon + 1000, 'mock', 'alpha', { inputTokens: 50, outputTokens: 10 }, 1, 2)
    } })

    const report = await usage.report()
    expect(report.days).toHaveLength(1)
    const day = report.days[0]!
    expect(day.dayStartMs).toBe(localDayStartMs(noon, 0))
    expect(day.sessions).toBe(1)
    expect(day.tokens).toEqual({ input: 150, output: 30, cacheRead: 5, cacheWrite: 0 })
    expect(day.models).toHaveLength(1)
    expect(day.models[0]).toMatchObject({ provider: 'mock', model: 'alpha', calls: 2, sessions: 1 })
    // One cold-start pass over the corpus; no scan on the report itself.
    expect(query.listCalls).toBe(1)
    expect(query.readCalls).toBe(1)
  })

  it('buckets sessions into separate local days and counts sessions per day', async () => {
    const today = new Date()
    const noonToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12)
    const noonYesterday = noonToday - DAY_MS
    const { usage } = await harness({ seed: (seedCtx) => {
      const first = seedCtx.sessions.create()
      const second = seedCtx.sessions.create()
      usageStep(first, noonYesterday, 'mock', 'alpha', { inputTokens: 1, outputTokens: 1 })
      usageStep(second, noonToday, 'mock', 'alpha', { inputTokens: 1, outputTokens: 1 })
      usageStep(second, noonToday + 3_600_000, 'mock', 'beta', { inputTokens: 1, outputTokens: 1 }, 1, 2)
    } })

    const report = await usage.report()
    expect(report.days.map(day => day.dayStartMs)).toEqual([localDayStartMs(noonYesterday, 0), localDayStartMs(noonToday, 0)])
    expect(report.days[0]!.sessions).toBe(1)
    expect(report.days[1]!.sessions).toBe(1)
    expect(report.days[1]!.models).toHaveLength(2)
  })

  it('respects the requested timezone when bucketing days', async () => {
    const today = new Date()
    // 17:00 UTC: UTC day is today, but UTC+8 (offset -480) local day is tomorrow.
    const instant = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 17)
    const { usage } = await harness({ seed: (seedCtx) => {
      const session = seedCtx.sessions.create()
      usageStep(session, instant, 'mock', 'alpha', { inputTokens: 1, outputTokens: 1 })
    } })

    const utc = await usage.report({ timezoneOffsetMinutes: 0 })
    expect(utc.days[0]!.dayStartMs).toBe(localDayStartMs(instant, 0))
    const east = await usage.report({ timezoneOffsetMinutes: -480 })
    expect(east.days[0]!.dayStartMs).toBe(localDayStartMs(instant, -480))
    expect(localDayStartMs(instant, 0)).not.toBe(localDayStartMs(instant, -480))
  })

  it('skips sessions without headers and messages without usage', async () => {
    const noon = Date.now() - DAY_MS
    const { usage } = await harness({ seed: (seedCtx) => {
      const session = seedCtx.sessions.create()
      appendAt(session, noon, {
        type: 'step/start',
        data: { turn: 1, step: 1 },
      })
      appendAt(session, noon, {
        type: 'assistant/message',
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: 'assistant',
            content: [],
            source: { kind: 'model', provider: 'mock', model: 'alpha' },
          }),
        },
      })
      appendAt(session, noon, {
        type: 'step/end',
        data: { turn: 1, step: 1 },
      })
    } })

    const report = await usage.report()
    expect(report.days).toEqual([])
  })

  it('reconciles backfill and live appends without double counting', async () => {
    // Seeded and live events share today's day so the count assertion is
    // about reconciliation, not day bucketing.
    const today = new Date()
    const noon = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12)
    let session!: Session
    const { usage } = await harness({ seed: (seedCtx) => {
      session = seedCtx.sessions.create()
      // Injected directly into the log: the backfill must count them once.
      usageStep(session, noon, 'mock', 'alpha', { inputTokens: 10, outputTokens: 1 })
      usageStep(session, noon + 1000, 'mock', 'alpha', { inputTokens: 20, outputTokens: 1 }, 1, 2)
    } })

    // A live append after the service started carries a higher seq than the
    // backfill read; the firehose must count it once, on top of the backfill.
    appendRealStep(session, 30)

    const report = await usage.report()
    expect(report.days).toHaveLength(1)
    const model = report.days[0]!.models[0]!
    expect(model.calls).toBe(3)
    expect(model.tokens.input).toBe(60)
  })

  it('stays firehose-only without the query seam', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionUsageReport, { cacheDir: mkdtempSync(join(tmpdir(), 'usage-report-noquery-')) })
    const usage = ctx.get('sessionUsage') as SessionUsageReport
    // Init settles without a backfill (no query seam); the live stream still counts.
    await usage.report()
    const session = ctx.sessions.create()
    appendRealStep(session, 5)
    const report = await usage.report()
    expect(report.days[0]!.models[0]!.calls).toBe(1)
    expect(report.days[0]!.tokens.input).toBe(5)
  })

  it('skips sessions whose read fails during backfill', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(FailingReadQuery)
    const session = ctx.sessions.create()
    usageStep(session, Date.now() - DAY_MS, 'mock', 'alpha', { inputTokens: 1, outputTokens: 1 })
    await ctx.plugin(SessionUsageReport, { cacheDir: mkdtempSync(join(tmpdir(), 'usage-report-failread-')) })
    const usage = ctx.get('sessionUsage') as SessionUsageReport
    const report = await usage.report()
    expect(report.days).toEqual([])
  })

  it('tolerates a failing corpus listing during backfill', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(FailingListQuery)
    const session = ctx.sessions.create()
    usageStep(session, Date.now() - DAY_MS, 'mock', 'alpha', { inputTokens: 1, outputTokens: 1 })
    await ctx.plugin(SessionUsageReport, { cacheDir: mkdtempSync(join(tmpdir(), 'usage-report-faillist-')) })
    const usage = ctx.get('sessionUsage') as SessionUsageReport
    const report = await usage.report()
    expect(report.days).toEqual([])
  })

  it('sorts models by billed total descending within a day', async () => {
    const noon = Date.now() - DAY_MS
    const { usage } = await harness({ seed: (seedCtx) => {
      const session = seedCtx.sessions.create()
      usageStep(session, noon, 'mock', 'small', { inputTokens: 1, outputTokens: 1 })
      usageStep(session, noon + 1000, 'mock', 'big', { inputTokens: 90, outputTokens: 10 }, 1, 2)
    } })

    const report = await usage.report()
    expect(report.days[0]!.models.map(model => model.model)).toEqual(['big', 'small'])
  })

  it('prunes samples older than the retention window', async () => {
    const old = Date.now() - 60 * DAY_MS
    const { usage } = await harness({ retentionDays: 40, seed: (seedCtx) => {
      const session = seedCtx.sessions.create()
      usageStep(session, old, 'mock', 'alpha', { inputTokens: 1, outputTokens: 1 })
    } })

    const report = await usage.report()
    expect(report.days).toEqual([])
  })
})

describe('SessionUsageReport durable sample file', () => {
  it('persists appended samples and reuses them on a cold start without a corpus read', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'usage-report-durable-'))
    const first = await harness({ cacheDir })
    const session = first.ctx.sessions.create()
    appendRealStep(session, 1)

    const report = await first.usage.report()
    expect(report.days[0]!.models[0]!.calls).toBe(1)
    // The write is debounced; wait for the sample file to land.
    await vi.waitFor(() => {
      expect(existsSync(join(cacheDir, SAMPLE_FILE))).toBe(true)
    }, { timeout: 2_000 })

    // A brand-new service over the same cache directory (process-restart
    // shape) loads the ledger and never touches the corpus.
    const second = await harness({ cacheDir })
    const cold = await second.usage.report()
    expect(cold.days[0]!.models[0]!.calls).toBe(1)
    expect(second.query.listCalls).toBe(0)
    expect(second.query.readCalls).toBe(0)
  })

  it('ignores a corrupt sample file and falls back to a backfill', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'usage-report-durable-corrupt-'))
    const first = await harness({ cacheDir })
    const session = first.ctx.sessions.create()
    appendRealStep(session, 1)
    await first.usage.report()
    await vi.waitFor(() => {
      expect(existsSync(join(cacheDir, SAMPLE_FILE))).toBe(true)
    }, { timeout: 2_000 })
    writeFileSync(join(cacheDir, SAMPLE_FILE), '{not-json')

    const { usage, query } = await harness({ cacheDir, seed: (seedCtx) => {
      const seeded = seedCtx.sessions.create()
      usageStep(seeded, Date.now() - DAY_MS, 'mock', 'beta', { inputTokens: 7, outputTokens: 1 })
    } })
    const cold = await usage.report()
    expect(cold.days[0]!.models[0]!.model).toBe('beta')
    expect(cold.days[0]!.models[0]!.calls).toBe(1)
    expect(query.listCalls).toBe(1)
  })

  it('ignores a version-mismatched sample file and falls back to a backfill', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'usage-report-durable-version-'))
    const first = await harness({ cacheDir })
    const session = first.ctx.sessions.create()
    appendRealStep(session, 1)
    await first.usage.report()
    await vi.waitFor(() => {
      expect(existsSync(join(cacheDir, SAMPLE_FILE))).toBe(true)
    }, { timeout: 2_000 })
    // A future format version must not be migrated; it is discarded.
    const record = JSON.parse(readFileSync(join(cacheDir, SAMPLE_FILE), 'utf8')) as { version: number }
    record.version = 99
    writeFileSync(join(cacheDir, SAMPLE_FILE), JSON.stringify(record))

    const { usage, query } = await harness({ cacheDir, seed: (seedCtx) => {
      const seeded = seedCtx.sessions.create()
      usageStep(seeded, Date.now() - DAY_MS, 'mock', 'beta', { inputTokens: 7, outputTokens: 1 })
    } })
    const cold = await usage.report()
    expect(cold.days[0]!.models[0]!.model).toBe('beta')
    expect(query.listCalls).toBe(1)
  })

  it('ignores a non-object sample file and falls back to a backfill', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'usage-report-nonobj-'))
    const first = await harness({ cacheDir })
    const session = first.ctx.sessions.create()
    appendRealStep(session, 1)
    await first.usage.report()
    await vi.waitFor(() => {
      expect(existsSync(join(cacheDir, SAMPLE_FILE))).toBe(true)
    }, { timeout: 2_000 })
    writeFileSync(join(cacheDir, SAMPLE_FILE), '"not-an-object"')

    const { usage, query } = await harness({ cacheDir, seed: (seedCtx) => {
      const seeded = seedCtx.sessions.create()
      usageStep(seeded, Date.now() - DAY_MS, 'mock', 'beta', { inputTokens: 7, outputTokens: 1 })
    } })
    const cold = await usage.report()
    expect(cold.days[0]!.models[0]!.model).toBe('beta')
    expect(query.listCalls).toBe(1)
  })

  it('filters malformed samples on load', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'usage-report-malformed-'))
    const valid = { time: Date.now(), provider: 'p', model: 'm', sessionId: 's', input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }
    const malformed = [
      null,
      42,
      { time: 'x', provider: 'p', model: 'm', sessionId: 's', input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      { time: 1, provider: 1, model: 'm', sessionId: 's', input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      { time: 1, provider: 'p', model: 1, sessionId: 's', input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      { time: 1, provider: 'p', model: 'm', sessionId: 1, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      { time: 1, provider: 'p', model: 'm', sessionId: 's', input: 'x', output: 1, cacheRead: 1, cacheWrite: 1 },
      { time: 1, provider: 'p', model: 'm', sessionId: 's', input: 1, output: 'x', cacheRead: 1, cacheWrite: 1 },
      { time: 1, provider: 'p', model: 'm', sessionId: 's', input: 1, output: 1, cacheRead: 'x', cacheWrite: 1 },
      { time: 1, provider: 'p', model: 'm', sessionId: 's', input: 1, output: 1, cacheRead: 1, cacheWrite: 'x' },
    ]
    writeFileSync(join(cacheDir, SAMPLE_FILE), JSON.stringify({ version: 1, samples: [...malformed, valid] }))

    const { usage } = await harness({ cacheDir })
    const report = await usage.report()
    expect(report.days).toHaveLength(1)
    expect(report.days[0]!.models[0]!.calls).toBe(1)
    expect(report.days[0]!.tokens.input).toBe(1)
  })

  it('flushes pending samples on disposal', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'usage-report-dispose-'))
    const { ctx, usage } = await harness({ cacheDir, persistDelayMs: 10_000 })
    // Settle init, then append a sample whose debounce never fires: disposal
    // must flush it anyway.
    await usage.report()
    const session = ctx.sessions.create()
    appendRealStep(session, 1)
    await ctx.fiber.dispose()
    await vi.waitFor(() => {
      const record = JSON.parse(readFileSync(join(cacheDir, SAMPLE_FILE), 'utf8')) as { samples: unknown[] }
      expect(record.samples).toHaveLength(1)
    }, { timeout: 2_000 })
  })

  it('tolerates a failing sample directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-report-baddir-'))
    const occupied = join(dir, 'occupied')
    writeFileSync(occupied, 'x')
    const { ctx, usage } = await harness({ cacheDir: occupied, persistDelayMs: 20 })
    await usage.report()
    const session = ctx.sessions.create()
    // The debounced write and the disposal write both fail (the cacheDir is a file).
    appendRealStep(session, 1)
    await new Promise(resolve => setTimeout(resolve, 80))
    await ctx.fiber.dispose()
  })

  it('defaults the sample directory to the DSH home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'usage-report-home-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const { usage } = await harness({ noCacheDir: true })
      const report = await usage.report()
      expect(report.days).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('SessionUsageReport day shape', () => {
  it('uses a fixed day length of 86400000ms regardless of offset', () => {
    expect(DAY_MS).toBe(86_400_000)
  })
})
