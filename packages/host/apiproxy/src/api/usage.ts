/**
 * usage domain contract. Method signatures are the source of truth:
 * unary methods take the RpcRequest<P> narrow form and the impl echoes rpcId.
 *
 * Read-only: the report is a corpus fold served from `ctx.sessionUsage`; the
 * wire view is the service's own detached report shape.
 */

import type { UsageReport, UsageReportRequest } from '@deepseek-ai/dsh-session-usage-report/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/**
 * Usage-domain unary methods. The report is derived from the complete logical
 * corpus, so it needs no session id and no write path.
 */
export interface UsageApi {
  /** Cross-session per-local-day, per-model billed token totals. */
  report(request: RpcRequest<UsageReportRequest>, signal: AbortSignal): Promise<RpcResponse<UsageReport>>
}
