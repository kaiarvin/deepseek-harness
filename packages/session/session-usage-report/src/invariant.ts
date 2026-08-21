/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-session-usage-report`.
 * @module @deepseek-ai/dsh-session-usage-report/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-usage-report'

/** Cordis companion plugin name. */
export const name = 'session-usage-report-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package owns an incremental usage ledger whose
 * event relations (attribution to the latest preceding `request/header`,
 * usage riding `assistant/message`) are owned by the session surface and
 * dsh-agent-loop; the durable sample file is validated on load (fail-soft to
 * a one-time backfill), and the wire payload is zod-validated by the
 * apiproxy `usage` domain at every call. The backfill/live reconciliation by
 * seq is asserted by the package's own tests.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
