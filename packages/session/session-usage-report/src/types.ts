/**
 * Pure types of the session-usage-report domain: the ONE home of the report
 * shape, free of this package's host-side value imports (cordis context, the
 * corpus reads). Host and wire faces both name these types.
 *
 * @module @deepseek-ai/dsh-session-usage-report/types
 */

// Marks this file a module so the declaration below augments the projection
// table instead of declaring an ambient module.
export {}

/** Disjoint billed token buckets for one bucket. Input is uncached input; cache reads/writes are the cached prompt-side buckets. */
export interface TokenTotals {
  /** Summed uncached input tokens (provider `inputTokens`). */
  input: number
  /** Summed output tokens. */
  output: number
  /** Summed cache-read tokens (cached input served from cache). */
  cacheRead: number
  /** Summed cache-write tokens. */
  cacheWrite: number
}

/** One model's totals inside one day bucket. */
export interface UsageModelTotals {
  /** Provider route key of the request header that owned the usage sample. */
  provider: string
  /** Provider-owned model id of the request header that owned the usage sample. */
  model: string
  /** Billed token totals. */
  tokens: TokenTotals
  /** `assistant/message` events carrying provider usage, summed into this bucket. */
  calls: number
  /** Distinct sessions contributing to this model's bucket. */
  sessions: number
}

/** One local-day bucket of the report. */
export interface UsageDay {
  /** UTC epoch ms of the local day's start (zero hour in the caller's timezone). */
  dayStartMs: number
  /** Distinct sessions contributing any usage to this day. */
  sessions: number
  /** Day totals across all models. */
  tokens: TokenTotals
  /** Per-model totals within the day, sorted by billed total descending. */
  models: UsageModelTotals[]
}

/** Cross-session usage report: the logical corpus folded by local day and model. */
export interface UsageReport {
  /**
   * Request-timezone used to place each event into a local day; the caller
   * passes the browser's `Date.getTimezoneOffset()` so day boundaries match
   * the viewer's wall clock.
   */
  timezoneOffsetMinutes: number
  /** Local-day buckets, oldest first. */
  days: UsageDay[]
}

/** Options for {@link SessionUsageReport.report}. */
export interface UsageReportRequest {
  /**
   * Minutes east of UTC of the viewer's local time (`Date.getTimezoneOffset()`
   * semantics: UTC-8 → 480). Omitted buckets by UTC day.
   */
  timezoneOffsetMinutes?: number
}
