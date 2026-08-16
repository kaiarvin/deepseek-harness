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

/** One assistant step with provider usage at a chosen timestamp. */
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
  freshMs?: number
  diskFreshMs?: number
  cacheDir?: string
}

async function harness(
  options: HarnessOptions = {},
): Promise<{ ctx: Context; usage: SessionUsageReport; query: CountingSessionQuery }> {
  const cacheDir = options.cacheDir ?? mkdtempSync(join(tmpdir(), 'usage-report-test-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CountingSessionQuery)
  await ctx.plugin(SessionUsageReport, {
    ...options.freshMs === undefined ? {} : { freshMs: options.freshMs },
    ...options.diskFreshMs === undefined ? {} : { diskFreshMs: options.diskFreshMs },
    cacheDir,
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

describe('SessionUsageReport aggregation', () => {
  it('reports an empty corpus as no days', async () => {
    const { usage } = await harness()
    const report = await usage.report()
    expect(report.days).toEqual([])
  })

  it('folds one session into one day bucket with per-model totals', async () => {
    const { ctx, usage } = await harness()
    const session = ctx.sessions.create()
    const noon = Date.UTC(2026, 2, 10, 12)
    usageStep(session, noon, 'mock', 'alpha', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 })
    usageStep(session, noon + 1000, 'mock', 'alpha', { inputTokens: 50, outputTokens: 10 }, 1, 2)

    const report = await usage.report()
    expect(report.days).toHaveLength(1)
    const day = report.days[0]!
    expect(day.dayStartMs).toBe(Date.UTC(2026, 2, 10))
    expect(day.sessions).toBe(1)
    expect(day.tokens).toEqual({ input: 150, output: 30, cacheRead: 5, cacheWrite: 0 })
    expect(day.models).toHaveLength(1)
    const model = day.models[0]!
    expect(model).toMatchObject({ provider: 'mock', model: 'alpha', calls: 2, sessions: 1 })
    expect(model.tokens).toEqual({ input: 150, output: 30, cacheRead: 5, cacheWrite: 0 })
  })

  it('attributes usage to the latest preceding request header', async () => {
    const { ctx, usage } = await harness()
    const session = ctx.sessions.create()
    const noon = Date.UTC(2026, 2, 10, 12)
    usageStep(session, noon, 'mock', 'alpha', { inputTokens: 10, outputTokens: 1 })
    usageStep(session, noon + 1000, 'mock', 'beta', { inputTokens: 20, outputTokens: 2 }, 1, 2)

    const report = await usage.report()
    const models = report.days[0]!.models
    expect(models.map(model => model.model).sort()).toEqual(['alpha', 'beta'])
    expect(models.find(model => model.model === 'alpha')!.tokens.output).toBe(1)
    expect(models.find(model => model.model === 'beta')!.tokens.output).toBe(2)
  })

  it('buckets sessions into separate local days and counts sessions per day', async () => {
    const { ctx, usage } = await harness()
    const first = ctx.sessions.create()
    const second = ctx.sessions.create()
    usageStep(first, Date.UTC(2026, 2, 10, 12), 'mock', 'alpha', { inputTokens: 1, outputTokens: 1 })
    usageStep(second, Date.UTC(2026, 2, 11, 12), 'mock', 'alpha', { inputTokens: 1, outputTokens: 1 })
    usageStep(second, Date.UTC(2026, 2, 11, 13), 'mock', 'beta', { inputTokens: 1, outputTokens: 1 }, 1, 2)

    const report = await usage.report()
    expect(report.days.map(day => day.dayStartMs)).toEqual([Date.UTC(2026, 2, 10), Date.UTC(2026, 2, 11)])
    expect(report.days[0]!.sessions).toBe(1)
    expect(report.days[1]!.sessions).toBe(1)
    expect(report.days[1]!.models).toHaveLength(2)
  })

  it('respects the requested timezone when bucketing days', async () => {
    const { ctx, usage } = await harness()
    const session = ctx.sessions.create()
    // 2026-03-10T23:00Z: UTC day 03-10, but UTC+8 local day 03-11.
    usageStep(session, Date.UTC(2026, 2, 10, 23), 'mock', 'alpha', { inputTokens: 1, outputTokens: 1 })

    const utc = await usage.report({ timezoneOffsetMinutes: 0 })
    expect(utc.days[0]!.dayStartMs).toBe(Date.UTC(2026, 2, 10))
    const east = await usage.report({ timezoneOffsetMinutes: -480 })
    expect(east.days[0]!.dayStartMs).toBe(Date.UTC(2026, 2, 10, 16))
  })

  it('skips assistant messages without provider usage and sessions without headers', async () => {
    const { ctx, usage } = await harness()
    const session = ctx.sessions.create()
    const noon = Date.UTC(2026, 2, 10, 12)
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

    const report = await usage.report()
    expect(report.days).toEqual([])
  })

  it('rescans immediately when the fresh window is zero and a session event lands', async () => {
    const { ctx, usage } = await harness({ freshMs: 0 })
    const session = ctx.sessions.create()
    // Real appends drive the dirty flag through session/event; the wall clock
    // keeps both steps in one day bucket for the calls assertion.
    const step = (usage: { inputTokens: number; outputTokens: number }): void => {
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
        usage,
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step: 1 })
    }
    step({ inputTokens: 1, outputTokens: 1 })

    const first = await usage.report()
    expect(first.days[0]!.models[0]!.calls).toBe(1)

    step({ inputTokens: 2, outputTokens: 2 })
    const second = await usage.report()
    expect(second.days[0]!.models[0]!.calls).toBe(2)
  })

  it('serves the cached report within the fresh window while dirty, then refreshes in the background', async () => {
    const { ctx, usage } = await harness({ freshMs: 60_000 })
    const session = ctx.sessions.create()
    appendRealStep(session, 1)

    const first = await usage.report()
    expect(first.days[0]!.models[0]!.calls).toBe(1)

    // A new session event marks the cache dirty, but the fresh window serves
    // the old value instantly instead of paying a full corpus fold.
    appendRealStep(session, 2)
    const stale = await usage.report()
    expect(stale.days[0]!.models[0]!.calls).toBe(1)

    // The background refresh catches up without another report call.
    await vi.waitFor(async () => {
      const refreshed = await usage.report()
      expect(refreshed.days[0]!.models[0]!.calls).toBe(2)
    }, { timeout: 2_000 })
  })

  it('rescans synchronously once the cache is dirty past the fresh window', async () => {
    const { ctx, usage } = await harness({ freshMs: 1 })
    const session = ctx.sessions.create()
    appendRealStep(session, 1)

    const first = await usage.report()
    expect(first.days[0]!.models[0]!.calls).toBe(1)

    appendRealStep(session, 2)
    await new Promise(resolve => setTimeout(resolve, 5))
    const fresh = await usage.report()
    expect(fresh.days[0]!.models[0]!.calls).toBe(2)
  })

  it('detaches the returned report from the service cache', async () => {
    const { ctx, usage } = await harness()
    const session = ctx.sessions.create()
    usageStep(session, Date.UTC(2026, 2, 10, 12), 'mock', 'alpha', { inputTokens: 1, outputTokens: 1 })

    const first = await usage.report()
    first.days[0]!.tokens.input = 999
    const second = await usage.report()
    expect(second.days[0]!.tokens.input).toBe(1)
  })
})

describe('SessionUsageReport durable cache', () => {
  it('persists a fresh scan to disk and reuses it on a cold start without a corpus read', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'usage-report-durable-'))
    const first = await harness({ freshMs: 0, cacheDir })
    const session = first.ctx.sessions.create()
    usageStep(session, Date.UTC(2026, 2, 10, 12), 'mock', 'alpha', { inputTokens: 1, outputTokens: 1 })

    const report = await first.usage.report()
    expect(report.days[0]!.models[0]!.calls).toBe(1)
    // The write is fire-and-forget; wait for the durable file to land.
    await vi.waitFor(() => {
      expect(existsSync(join(cacheDir, 'usage-report-0.json'))).toBe(true)
    }, { timeout: 2_000 })

    // A brand-new service over the same cache directory (process-restart shape)
    // serves the persisted report instantly, then refreshes in the background.
    const second = await harness({ freshMs: 0, cacheDir })
    const cold = await second.usage.report()
    expect(cold.days[0]!.models[0]!.calls).toBe(1)
    await vi.waitFor(() => {
      expect(second.query.listCalls).toBeGreaterThan(0)
    }, { timeout: 2_000 })
  })

  it('discards a durable cache past the disk fresh window and rescans', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'usage-report-durable-expired-'))
    const first = await harness({ freshMs: 0, cacheDir })
    const session = first.ctx.sessions.create()
    usageStep(session, Date.UTC(2026, 2, 10, 12), 'mock', 'alpha', { inputTokens: 1, outputTokens: 1 })
    await first.usage.report()
    await vi.waitFor(() => {
      expect(existsSync(join(cacheDir, 'usage-report-0.json'))).toBe(true)
    }, { timeout: 2_000 })

    // Rewrite the persisted record with an old timestamp so the disk window is expired.
    const path = join(cacheDir, 'usage-report-0.json')
    const record = JSON.parse(readFileSync(path, 'utf8')) as { updatedAt: number }
    record.updatedAt = Date.now() - 60_000
    writeFileSync(path, JSON.stringify(record))

    // A fresh service with its own live session: the expired disk cache is
    // discarded and the corpus is scanned for the new session's usage.
    const second = await harness({ freshMs: 0, diskFreshMs: 1, cacheDir })
    const secondSession = second.ctx.sessions.create()
    usageStep(secondSession, Date.UTC(2026, 2, 11, 12), 'mock', 'beta', { inputTokens: 7, outputTokens: 1 })
    const cold = await second.usage.report()
    expect(cold.days[0]!.models[0]!.model).toBe('beta')
    expect(cold.days[0]!.models[0]!.calls).toBe(1)
    expect(second.query.listCalls).toBe(1)
  })

  it('ignores a corrupt durable cache and falls back to a scan', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'usage-report-durable-corrupt-'))
    const first = await harness({ freshMs: 0, cacheDir })
    const session = first.ctx.sessions.create()
    usageStep(session, Date.UTC(2026, 2, 10, 12), 'mock', 'alpha', { inputTokens: 1, outputTokens: 1 })
    await first.usage.report()
    await vi.waitFor(() => {
      expect(existsSync(join(cacheDir, 'usage-report-0.json'))).toBe(true)
    }, { timeout: 2_000 })
    writeFileSync(join(cacheDir, 'usage-report-0.json'), '{not-json')

    // A fresh service: the unreadable cache falls back to a full scan.
    const second = await harness({ freshMs: 0, cacheDir })
    const secondSession = second.ctx.sessions.create()
    usageStep(secondSession, Date.UTC(2026, 2, 11, 12), 'mock', 'beta', { inputTokens: 7, outputTokens: 1 })
    const cold = await second.usage.report()
    expect(cold.days[0]!.models[0]!.model).toBe('beta')
    expect(second.query.listCalls).toBe(1)
  })
})

describe('SessionUsageReport day shape', () => {
  it('sorts models by billed total descending within a day', async () => {
    const { ctx, usage } = await harness()
    const session = ctx.sessions.create()
    const noon = Date.UTC(2026, 2, 10, 12)
    usageStep(session, noon, 'mock', 'small', { inputTokens: 1, outputTokens: 1 })
    usageStep(session, noon + 1000, 'mock', 'big', { inputTokens: 90, outputTokens: 10 }, 1, 2)

    const report = await usage.report()
    expect(report.days[0]!.models.map(model => model.model)).toEqual(['big', 'small'])
  })

  it('uses a fixed day length of 86400000ms regardless of offset', () => {
    expect(DAY_MS).toBe(86_400_000)
  })
})
