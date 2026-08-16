// line-diff: pure per-line alignment with file-coordinate rebasing. Pins the
// LCS walk (ctx/del/add), the hunk start-line rebase, the create-side (oldText
// null) numbering, and the DP-cap degradation to a delete-then-add.

import { describe, expect, it } from 'vitest'
import { alignHunk, alignLines } from '../src/client/line-diff.ts'

describe('alignLines', () => {
  it('aligns an in-line edit into one ctx row, one del, one add, one ctx', () => {
    const oldLines = ['a', 'x', 'c']
    const newLines = ['a', 'y', 'c']
    expect(alignLines(oldLines, newLines)).toEqual([
      { kind: 'ctx', oldNo: 1, newNo: 1, text: 'a' },
      { kind: 'del', oldNo: 2, text: 'x' },
      { kind: 'add', newNo: 2, text: 'y' },
      { kind: 'ctx', oldNo: 3, newNo: 3, text: 'c' },
    ])
  })

  it('keeps untouched lines aligned when a change appears at the head', () => {
    const oldLines = ['x', 'b', 'c']
    const newLines = ['y', 'b', 'c']
    expect(alignLines(oldLines, newLines)).toEqual([
      { kind: 'del', oldNo: 1, text: 'x' },
      { kind: 'add', newNo: 1, text: 'y' },
      { kind: 'ctx', oldNo: 2, newNo: 2, text: 'b' },
      { kind: 'ctx', oldNo: 3, newNo: 3, text: 'c' },
    ])
  })

  it('treats a pure insertion as adds with no old numbers', () => {
    const oldLines = ['a', 'c']
    const newLines = ['a', 'b', 'c']
    expect(alignLines(oldLines, newLines)).toEqual([
      { kind: 'ctx', oldNo: 1, newNo: 1, text: 'a' },
      { kind: 'add', newNo: 2, text: 'b' },
      { kind: 'ctx', oldNo: 2, newNo: 3, text: 'c' },
    ])
  })

  it('degrades beyond the DP cap to delete-all then add-all', () => {
    const oldLines = ['a', 'b']
    const newLines = ['c', 'd']
    // Cap below the 2×2 matrix forces the degrade path.
    expect(alignLines(oldLines, newLines, 1)).toEqual([
      { kind: 'del', oldNo: 1, text: 'a' },
      { kind: 'del', oldNo: 2, text: 'b' },
      { kind: 'add', newNo: 1, text: 'c' },
      { kind: 'add', newNo: 2, text: 'd' },
    ])
  })
})

describe('alignHunk', () => {
  it('rebases numbers onto the hunk start lines', () => {
    const oldText = 'line7\nline8\nline9\nline10\nline11\nline12\nline13\n'
    const newText = 'line7\nline8\nline9\nCHANGED\nline11\nline12\nline13\n'
    const aligned = alignHunk(oldText, newText, 7, 7)
    expect(aligned[0]).toEqual({ kind: 'ctx', oldNo: 7, newNo: 7, text: 'line7' })
    expect(aligned[3]).toEqual({ kind: 'del', oldNo: 10, text: 'line10' })
    expect(aligned[4]).toEqual({ kind: 'add', newNo: 10, text: 'CHANGED' })
    expect(aligned[5]).toEqual({ kind: 'ctx', oldNo: 11, newNo: 11, text: 'line11' })
  })

  it('numbers a create-style hunk (oldText null) from newStart', () => {
    const aligned = alignHunk(null, 'a\nb\n', undefined, 42)
    expect(aligned).toEqual([
      { kind: 'add', newNo: 42, text: 'a' },
      { kind: 'add', newNo: 43, text: 'b' },
    ])
  })

  it('numbers a create-style hunk from 1 when newStart is unknown', () => {
    const aligned = alignHunk(null, 'a\nb\n')
    expect(aligned).toEqual([
      { kind: 'add', newNo: 1, text: 'a' },
      { kind: 'add', newNo: 2, text: 'b' },
    ])
  })

  it('defaults missing starts to 1 for the old side too', () => {
    const aligned = alignHunk('x\n', 'y\n')
    expect(aligned).toEqual([
      { kind: 'del', oldNo: 1, text: 'x' },
      { kind: 'add', newNo: 1, text: 'y' },
    ])
  })

  it('drops a single trailing terminator (a file ending in newline has no phantom line)', () => {
    const aligned = alignHunk('a\n', 'a\nb\n')
    expect(aligned).toEqual([
      { kind: 'ctx', oldNo: 1, newNo: 1, text: 'a' },
      { kind: 'add', newNo: 2, text: 'b' },
    ])
  })

  it('returns no rows for an empty new side', () => {
    expect(alignHunk('a\n', '')).toEqual([
      { kind: 'del', oldNo: 1, text: 'a' },
    ])
  })

  it('handles sides without a trailing newline (no phantom terminator)', () => {
    expect(alignHunk('x', 'y')).toEqual([
      { kind: 'del', oldNo: 1, text: 'x' },
      { kind: 'add', newNo: 1, text: 'y' },
    ])
    expect(alignHunk('x\n', 'y')).toEqual([
      { kind: 'del', oldNo: 1, text: 'x' },
      { kind: 'add', newNo: 1, text: 'y' },
    ])
  })
})
