// Diff-viewer toolview registrant: the keyed toolview hole for the `edit` and
// `write` tools. Each mutation renders as an expanded color-coded diff card —
// a header naming the change and its path, then the applied hunks through the
// line-aligned DiffLines surface with per-file line numbers. The change stays
// visible in the conversation flow (unlike the collapsed-by-default shipped
// row) while long diffs keep DiffLines' own height cap.

import { useState, type ReactNode } from 'react'
import {
  IconChevronDownOutline14, IconEditOutline16, IconInspectOutline12, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { diffHunks } from './diff-model.ts'
import { DiffLines } from './DiffLines.tsx'
import css from './DiffViewerRow.module.css'

/** Diff-viewer row lifecycle derived solely from the durable call slice. */
type DiffRowState = 'running' | 'ok' | 'error' | 'stopped'

/** Full row props: the toolview runtime share plus this package's locale seat. */
export type DiffViewerRowProps = ToolCallViewProps & PropsLocale<'diff-viewer'>

/** Compact, replay-stable view model for the diff row. */
interface DiffRowModel {
  readonly title: string
  /** Raw `file_path` argument, passed verbatim to `openFile` (the chat view resolves it against the session cwd). */
  readonly path: string | undefined
  /** Workspace-rooted paths display relative to the session cwd. */
  readonly displayPath: string | undefined
  readonly output: string | null
  readonly errorSummary: string | null
  readonly state: DiffRowState
}

/** First physical line for the collapsed error summary and malformed-args fallback. */
function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/** Strip the workspace root from a workspace-rooted absolute path (display only). */
function relativizeToCwd(text: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return text
  const root = cwd.replace(/[/\\]+$/, '')
  if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`)) return text.slice(root.length + 1)
  return text
}

/** The mutation tool's path argument (`file_path` on the wire). */
function filePath(argsRaw: string): string | undefined {
  try {
    const parsed = JSON.parse(argsRaw) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const path = (parsed as Record<string, unknown>).file_path
      if (typeof path === 'string' && path !== '') return firstLine(path)
    }
  } catch {
    // Streaming can expose a truncated JSON prefix; the row then shows no path.
  }
  return undefined
}

/** Flatten durable result blocks under the generic Tool-row text contract. */
function resultText(block: ToolCallViewProps['block']): string | null {
  if (!('kind' in block)) return null
  const parts: string[] = []
  for (const item of block.content) {
    parts.push(item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
  }
  if (parts.length === 0 && block.error !== undefined) {
    parts.push(`${block.error.name}: ${block.error.code}`)
  }
  return parts.join('\n') || null
}

/** Derive display state without consulting any live state beyond the slice. */
function diffRowModel(toolName: string, block: ToolCallViewProps['block'], cwd: string | undefined): DiffRowModel {
  const settled = 'kind' in block
  const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? ''
  const state: DiffRowState = !settled
    ? 'running'
    : block.error?.code === 'interrupted'
      ? 'stopped'
      : block.isError ? 'error' : 'ok'
  const output = resultText(block)
  const path = filePath(argsRaw)
  return {
    title: toolName === 'write' ? 'Write' : 'Edit',
    path,
    displayPath: path === undefined ? undefined : relativizeToCwd(path, cwd),
    output,
    errorSummary: state === 'error' && output !== null ? firstLine(output) : null,
    state,
  }
}

/** Visually hidden state copy for the colour-only lifecycle cues. */
function stateStatus(state: DiffRowState, t: DiffViewerRowProps['t']): string | null {
  switch (state) {
    case 'running': return t('row.running')
    case 'error': return t('row.failed')
    case 'stopped': return t('row.stopped')
    default: return null
  }
}

/** Leading icon for the row chrome: state dot on failure, the edit glyph at rest. */
function leadingFor(state: DiffRowState): ReactNode {
  switch (state) {
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    default: return <IconEditOutline16 size={14} />
  }
}

/**
 * Render one `edit`/`write` tool call as an expanded diff card.
 * @param props - keyed toolview payload plus the diff-viewer locale seat.
 * @returns the diff-viewer card.
 */
export function DiffViewerRow({ toolName, block, cwd, openFile, inspect, t }: DiffViewerRowProps) {
  const model = diffRowModel(toolName, block, cwd)
  const hunks = diffHunks(block)
  const status = stateStatus(model.state, t)
  const [collapsed, setCollapsed] = useState(false)
  // The display path is always present when the raw path is (relativizeToCwd
  // returns its input when there is no workspace root to strip).
  const shownPath = model.path === undefined ? undefined : model.displayPath

  let body
  if (collapsed) {
    body = null
  } else if (model.state === 'error') {
    body = (
      <div className={css.error}>{model.output ?? t('row.failed')}</div>
    )
  } else if (hunks === null || hunks.length === 0) {
    body = <div className={css.empty}>{t('row.empty')}</div>
  } else {
    body = <DiffLines hunks={hunks} />
  }

  return (
    <div className={css.card} data-tool={toolName} data-state={model.state}>
      <div className={css.head}>
        <span className={css.leading}>{leadingFor(model.state)}</span>
        <span className={css.title}>{model.title}</span>
        {model.path !== undefined && (
          <button
            type="button"
            className={css.path}
            onClick={() => {
              // Narrowed by the enclosing guard; v8 counts the branch at the guard.
              /* v8 ignore next 2 -- the raw path is non-null here (see the guard above) */
              openFile(model.path as string)
            }}
          >
            {shownPath}
          </button>
        )}
        {status !== null && <span className={css.status}>{status}</span>}
        <span className={css.spacer} />
        {inspect !== undefined && (
          <button type="button" className={css.action} onClick={inspect} aria-label={t('row.inspect')}>
            <IconInspectOutline12 size={14} />
            {t('row.inspect')}
          </button>
        )}
        {hunks !== null && hunks.length > 0 && (
          <button
            type="button"
            className={css.action}
            onClick={() => {
              setCollapsed(value => !value)
            }}
            aria-expanded={!collapsed}
          >
            <IconChevronDownOutline14 className={collapsed ? css.chevronCollapsed : undefined} size={14} />
            {collapsed ? t('row.expand') : t('row.collapse')}
          </button>
        )}
      </div>
      {body}
    </div>
  )
}
