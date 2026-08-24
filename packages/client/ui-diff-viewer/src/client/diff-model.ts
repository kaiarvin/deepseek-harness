/**
 * Pure derivation of the diff-card material from a frozen call slice. The
 * `edit`/`write` tools declare the `card:'diff'` render intent; it arrives on
 * the snapshot as `callView`/`resultView`, and this package turns that pair
 * into the hunks the line-diff renderer draws. The result side is
 * authoritative once the call settles (the tools return the applied
 * contextual hunks there, carrying each hunk's first file line), while a
 * running call shows the intended change derived from the arguments alone
 * (whose file coordinates are unknown).
 * @module
 */
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'

/** One validated hunk the renderer consumes, with optional file coordinates. */
export interface DiffHunkWithLines {
  path: string
  /** Prior content, or `null` for a new file / an overwrite (no prior content). */
  oldText: string | null
  /** Content after the change. */
  newText: string
  /** 1-based first line of this hunk in the pre-change file, when known. */
  oldStart?: number
  /** 1-based first line of this hunk in the post-change file, when known. */
  newStart?: number
}

/**
 * Narrow a wire `card:'diff'` view's `diffs` to well-formed hunks. The view
 * crosses the wire and the tool contract validates only the `card` string, so
 * a version mismatch or an anomalous plugin can deliver a `diff` card whose
 * `diffs` is absent, not an array, or carries malformed hunks. Returning null
 * for any of those routes the block to the empty state instead of letting the
 * renderer's alignment throw and crash the row.
 * @param diffs - the view's `diffs` field, unverified.
 * @returns the validated hunks, or null when the payload is not usable.
 */
function narrowDiffs(diffs: unknown): DiffHunkWithLines[] | null {
  if (!Array.isArray(diffs) || diffs.length === 0) return null
  const out: DiffHunkWithLines[] = []
  for (const hunk of diffs) {
    if (typeof hunk !== 'object' || hunk === null) return null
    const { path, oldText, newText, oldStart, newStart } = hunk as Record<string, unknown>
    if (typeof path !== 'string') return null
    if (oldText !== null && typeof oldText !== 'string') return null
    if (typeof newText !== 'string') return null
    if (oldStart !== undefined && typeof oldStart !== 'number') return null
    if (newStart !== undefined && typeof newStart !== 'number') return null
    const outHunk: DiffHunkWithLines = { path, oldText, newText }
    if (typeof oldStart === 'number') outHunk.oldStart = oldStart
    if (typeof newStart === 'number') outHunk.newStart = newStart
    out.push(outHunk)
  }
  return out
}

/**
 * Derive the diff hunks for a tool call, or null when this call is not a diff
 * card (an errored mutation keeps its error text on the generic output path).
 * @param block - RunningToolCall or ToolResultNode off the snapshot caches.
 * @returns the validated hunks, or null for the empty state.
 */
export function diffHunks(block: ToolCallViewProps['block']): DiffHunkWithLines[] | null {
  if (!('kind' in block)) {
    // Running: the call view may carry the intended diff; the result is absent.
    const call = block.callView?.card === 'diff' ? block.callView : null
    return call === null ? null : narrowDiffs(call.diffs)
  }
  // Settled: the result view's applied hunks replace the call-time diff. A
  // window that dropped the call head leaves only the result, which still
  // renders — the result view carries the whole change.
  const result = block.resultView?.card === 'diff' ? block.resultView : null
  return result === null ? null : narrowDiffs(result.diffs)
}
