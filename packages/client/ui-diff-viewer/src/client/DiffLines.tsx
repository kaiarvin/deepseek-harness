// DiffLines: the expanded diff card's line-level body. Each hunk renders as a
// path header followed by aligned rows with two line-number columns — the old
// file's line for removed/context rows, the new file's line for added/context
// rows — so a reader sees exactly where in each file a change lands. The old
// and new sides are aligned per line (LCS), not drawn as unaligned blocks.

import { useCallback, useMemo, useState } from 'react'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { alignHunk, type AlignedLine } from './line-diff.ts'
import type { DiffHunkWithLines } from './diff-model.ts'
import css from './DiffLines.module.css'

/** Body rows shown before the height cap collapses the middle. */
export const DEFAULT_DIFF_LINES_MAX_LINES = 16

/** One flattened row of the whole card body. */
interface BodyRow {
  kind: 'path' | 'line'
  path?: string
  line?: AlignedLine
}

/** Copy text: each row's `-`/`+`/context prefix and its content, path headers kept. */
function copyText(rows: BodyRow[]): string {
  return rows.map((row) => {
    if (row.kind === 'path') {
      // Every path row sets its path; the fallback satisfies the optional field.
      /* v8 ignore next -- path rows always carry a path */
      return row.path ?? ''
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- a non-path row always carries its line
    const line = row.line!
    switch (line.kind) {
      case 'del': return `- ${line.text}`
      case 'add': return `+ ${line.text}`
      default: return `  ${line.text}`
    }
  }).join('\n')
}

/**
 * Flatten the hunks into body rows plus the +/- totals and distinct-file count,
 * keeping the alignment and per-line coordinates each hunk computed.
 * @param hunks - the validated hunks to render.
 * @returns the body rows, the +/- totals, and the distinct-file count.
 */
function buildRows(hunks: DiffHunkWithLines[]): { rows: BodyRow[]; added: number; removed: number; files: number } {
  const rows: BodyRow[] = []
  const paths = new Set<string>()
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    paths.add(hunk.path)
    rows.push({ kind: 'path', path: hunk.path })
    for (const line of alignHunk(hunk.oldText, hunk.newText, hunk.oldStart, hunk.newStart)) {
      rows.push({ kind: 'line', line })
      if (line.kind === 'add') added++
      else if (line.kind === 'del') removed++
    }
  }
  return { rows, added, removed, files: paths.size }
}

/**
 * Render the applied change as line-aligned diff rows with file line numbers.
 * @param props - the hunks and an optional height cap.
 * @returns the diff lines element.
 */
export function DiffLines({ hunks, maxLines = DEFAULT_DIFF_LINES_MAX_LINES }: {
  hunks: DiffHunkWithLines[]
  maxLines?: number
}) {
  const { rows, added, removed, files } = useMemo(() => buildRows(hunks), [hunks])
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const onCopy = useCallback(() => {
    if (copied) return
    void writeClipboard(copyText(rows)).then((ok) => {
      if (!ok) return
      setCopied(true)
      // Reset the label after a beat; the timer is a UX detail not asserted.
      /* v8 ignore next -- the 1s label reset is timing, covered by the copy tests' state */
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [copied, rows])

  const onToggle = useCallback(() => { setExpanded(value => !value) }, [])

  if (rows.length === 0) return null

  const hidden = rows.length - maxLines
  const capped = hidden > 0 && !expanded
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = maxLines - headLines
  const head = capped ? rows.slice(0, headLines) : rows
  const tail = capped ? rows.slice(rows.length - tailLines) : []

  const renderLine = (row: BodyRow, index: number) => {
    if (row.kind === 'path') {
      return <div key={index} className={css.path}>{row.path}</div>
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- a non-path row always carries its line
    const line = row.line!
    return (
      <div key={index} className={`${css.line} ${css[line.kind]}`} data-diff-kind={line.kind}>
        <span className={css.oldNo}>{line.oldNo ?? ''}</span>
        <span className={css.newNo}>{line.newNo ?? ''}</span>
        <span className={css.text}>{line.text}</span>
      </div>
    )
  }

  return (
    <div className={css.block} data-diff="">
      <button type="button" className={css.copyButton} onClick={onCopy}>
        {copied ? '复制成功' : '复制'}
      </button>
      <div className={css.body}>
        {head.map(renderLine)}
        {hidden > 0 && (
          <button
            type="button"
            className={css.expand}
            aria-expanded={expanded}
            aria-label={expanded ? '收起差异' : `展开其余 ${hidden} 行差异`}
            onClick={onToggle}
          >
            {expanded ? '收起' : `… 其余 ${hidden} 行`}
          </button>
        )}
        {tail.map(renderLine)}
      </div>
      <div className={css.footer}>└ +{added} -{removed} · {files} file{files === 1 ? '' : 's'}</div>
    </div>
  )
}
