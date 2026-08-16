/**
 * Line-level diff alignment for the expanded diff cards. The tools deliver one
 * hunk per applied change with `oldText`/`newText` (plus the hunk's first line
 * in each file when known). This module aligns the two sides line by line via
 * a bounded LCS so the card can draw true per-line numbers — the old file's
 * line for a removed/context line, the new file's line for an added/context
 * line — instead of rendering the two sides as unaligned blocks.
 * @module
 */

/** One aligned diff line, ready to render. */
export interface AlignedLine {
  /** 'ctx' unchanged on both sides, 'del' present only in the old file, 'add' only in the new. */
  kind: 'ctx' | 'del' | 'add'
  /** 1-based line in the old file; undefined for a pure addition. */
  oldNo?: number
  /** 1-based line in the new file; undefined for a pure deletion. */
  newNo?: number
  /** The line's content (without its terminator). */
  text: string
}

/** Split text into content lines, dropping a single trailing terminator. */
function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/**
 * Align two line arrays with a shortest-edit LCS. The DP matrix is bounded by
 * the product of the two lengths; hunks carry context so they stay small, and
 * a pathological pair beyond the cap degrades to a full delete + full add (the
 * sides remain visible, just unaligned).
 * @param oldLines - the old side's lines.
 * @param newLines - the new side's lines.
 * @param cap - maximum DP cells before degrading (default 400k, ~632×632 lines).
 * @returns aligned lines with per-side positions resolved.
 */
export function alignLines(oldLines: string[], newLines: string[], cap = 400_000): AlignedLine[] {
  const n = oldLines.length
  const m = newLines.length
  if (n * m > cap) {
    // Degrade: everything on the old side is removed, everything new added.
    const out: AlignedLine[] = []
    for (let i = 0; i < n; i++) {
      // split never produces holes; the guard satisfies noUncheckedIndexedAccess.
      const text = oldLines[i]
      /* v8 ignore next -- text is defined for every index of a split array */
      if (text !== undefined) out.push({ kind: 'del', oldNo: i + 1, text })
    }
    for (let j = 0; j < m; j++) {
      const text = newLines[j]
      /* v8 ignore next -- text is defined for every index of a split array */
      if (text !== undefined) out.push({ kind: 'add', newNo: j + 1, text })
    }
    return out
  }
  // Longest common subsequence, iterated row by row.
  const dp: number[][] = []
  for (let i = 0; i <= n; i++) {
    dp.push(Array.from({ length: m + 1 }, () => 0))
  }
  for (let i = n - 1; i >= 0; i--) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the DP table is fully allocated
    const rowI = dp[i]!
    // oxlint-disable-next-line typescript/no-non-null-assertion -- i+1 <= n, a row exists
    const rowNext = dp[i + 1]!
    for (let j = m - 1; j >= 0; j--) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- within the allocated column count
      const down = rowNext[j]!
      // oxlint-disable-next-line typescript/no-non-null-assertion -- within the allocated column count
      const right = rowI[j + 1]!
      // oxlint-disable-next-line typescript/no-non-null-assertion -- within the allocated column count
      const diag = rowNext[j + 1]! + 1
      rowI[j] = oldLines[i] === newLines[j] ? diag : Math.max(down, right)
    }
  }
  const out: AlignedLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const oldLine = oldLines[i]
    const newLine = newLines[j]
    if (oldLine === newLine && oldLine !== undefined) {
      out.push({ kind: 'ctx', oldNo: i + 1, newNo: j + 1, text: oldLine })
      i++
      j++
    } else if (
      // oxlint-disable-next-line typescript/no-non-null-assertion -- within the allocated table
      (dp[i + 1]![j]!) >= (dp[i]![j + 1]!)
    ) {
      // Equal lines were consumed above; the del side is a defined line.
      /* v8 ignore next -- oldLine is defined at every index of a split array */
      if (oldLine !== undefined) out.push({ kind: 'del', oldNo: i + 1, text: oldLine })
      i++
    } else {
      /* v8 ignore next -- newLine is defined at every index of a split array */
      if (newLine !== undefined) out.push({ kind: 'add', newNo: j + 1, text: newLine })
      j++
    }
  }
  while (i < n) {
    const oldLine = oldLines[i]
    /* v8 ignore next -- oldLine is defined at every index of a split array */
    if (oldLine !== undefined) out.push({ kind: 'del', oldNo: i + 1, text: oldLine })
    i++
  }
  while (j < m) {
    const newLine = newLines[j]
    /* v8 ignore next -- newLine is defined at every index of a split array */
    if (newLine !== undefined) out.push({ kind: 'add', newNo: j + 1, text: newLine })
    j++
  }
  return out
}

/**
 * Align one hunk's two sides and rebase the per-line numbers onto the file
 * coordinates the hunk carries. A pure create (oldText null) numbers the new
 * side from the hunk's newStart (or 1 when unknown); the old side is absent.
 * @param oldText - the old side, or null for a create-style hunk.
 * @param newText - the new side.
 * @param oldStart - 1-based first old line of the hunk, when known.
 * @param newStart - 1-based first new line of the hunk, when known.
 * @returns aligned lines with file coordinates.
 */
export function alignHunk(
  oldText: string | null,
  newText: string,
  oldStart?: number,
  newStart?: number,
): AlignedLine[] {
  if (oldText === null) {
    const lines = contentLines(newText)
    const base = newStart ?? 1
    return lines.map((text, index) => ({ kind: 'add' as const, newNo: base + index, text }))
  }
  const oldLines = contentLines(oldText)
  const newLines = contentLines(newText)
  const aligned = alignLines(oldLines, newLines)
  const oldBase = oldStart ?? 1
  const newBase = newStart ?? 1
  let oldCursor = 0
  let newCursor = 0
  return aligned.map((line) => {
    if (line.kind === 'del') {
      const no = oldBase + oldCursor
      oldCursor++
      return { kind: 'del' as const, oldNo: no, text: line.text }
    }
    if (line.kind === 'add') {
      const no = newBase + newCursor
      newCursor++
      return { kind: 'add' as const, newNo: no, text: line.text }
    }
    const oldNo = oldBase + oldCursor
    const newNo = newBase + newCursor
    oldCursor++
    newCursor++
    return { kind: 'ctx' as const, oldNo, newNo, text: line.text }
  })
}
