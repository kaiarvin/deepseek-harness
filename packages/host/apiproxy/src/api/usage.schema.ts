/**
 * usage domain zod schemas (names derived from map keys: usageReportRequestSchema /
 * usageReportValueSchema).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

/** Disjoint billed token buckets. */
export const usageTokenTotalsSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
}) satisfies z.ZodType<Wire<{
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}>>

/** One model's totals inside one day bucket. */
export const usageModelTotalsSchema = z.object({
  provider: z.string(),
  model: z.string(),
  tokens: usageTokenTotalsSchema,
  calls: z.number(),
  sessions: z.number(),
}) satisfies z.ZodType<Wire<{
  provider: string
  model: string
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  calls: number
  sessions: number
}>>

/** One local-day bucket of the report. */
export const usageDaySchema = z.object({
  dayStartMs: z.number(),
  sessions: z.number(),
  tokens: usageTokenTotalsSchema,
  models: z.array(usageModelTotalsSchema),
}) satisfies z.ZodType<Wire<{
  dayStartMs: number
  sessions: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  models: unknown[]
}>>

/** usage.report request payload. */
export const usageReportRequestSchema = z.object({
  timezoneOffsetMinutes: z.number().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'usage.report'>>>

/** usage.report response value. */
export const usageReportValueSchema = z.object({
  timezoneOffsetMinutes: z.number(),
  days: z.array(usageDaySchema),
}) satisfies z.ZodType<Wire<ResponseValue<'usage.report'>>>
