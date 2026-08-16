/**
 * Usage report plugin, browser half: the sidebar-foot icon beside Settings
 * (`sidebar.footer.action`) opening the cross-session token usage dialog. The
 * entry owns one read — `usage.report` through the connection API — and no
 * store, no projection, and no event listener: the report is a corpus fold
 * served fresh by the host on every open.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls ctx.locale into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the sidebar slot declarations (sidebar.footer.action) into this program.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { UsageReportEntry } from './UsageReportDialog.tsx'
import { en, zh, type UsageKey } from './locales.ts'

export { UsageReportDialog, UsageReportEntry } from './UsageReportDialog.tsx'
export type { UsageReportEntryProps } from './UsageReportDialog.tsx'
export type { UsageKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The usage-report entry and dialog copy. */
    usage: UsageKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'usage'

/** Required services: slots (registration), locale (copy), connection (API face). */
export const inject = ['slots', 'locale', 'connection']

/**
 * Register the usage-report entry beside Settings at the sidebar foot.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-usage-report: dictionaries')

  const injectUsage = (): { api: ConnectionHandle['api'] } => {
    const connection = ctx.get('connection') as ConnectionHandle
    return { api: connection.api }
  }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'usage-report',
    order: 0,
    locale: NS,
    inject: injectUsage,
  }, UsageReportEntry))
}
