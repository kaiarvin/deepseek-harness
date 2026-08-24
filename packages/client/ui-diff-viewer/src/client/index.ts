/**
 * Expanded diff tool cards, browser half: registers the `edit` and `write`
 * keyed toolview rows so file mutations render as expanded color-coded diffs
 * directly in the conversation flow. The rows derive their hunks and lifecycle
 * only from the frozen call/result slice supplied by ui-tool (the tools'
 * `card:'diff'` render intent), never from the filesystem, so replay stays
 * stable across windows and sessions.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: declares the keyed toolview hole's locale seat wiring.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { DiffViewerRow } from './DiffViewerRow.tsx'
import { en, NS, zh, type DiffViewerKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The expanded diff tool cards' copy. */
    'diff-viewer': DiffViewerKey
  }
}

/** Required services: the slot and locale registries. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the two mutation rows.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-diff-viewer: dictionaries')
  ctx.slots.inject('tool.call.toolview', function* () {
    // Lower priority shadows the shipped file-mutation rows (same key at the
    // same priority would throw — see SlotCore.register's keyed shadowing).
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'edit', locale: NS, priority: -1 }, DiffViewerRow)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'write', locale: NS, priority: -1 }, DiffViewerRow)
  })
}
