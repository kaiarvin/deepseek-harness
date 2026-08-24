// @vitest-environment jsdom
// DiffLines: the line-aligned diff body. Renders per-file line numbers, the
// +/- colors and prefixes, the height-cap expand/collapse, the copy handoff,
// and the footer totals; multi-hunk cards keep a path header per file.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiffLines, DEFAULT_DIFF_LINES_MAX_LINES } from '../src/client/DiffLines.tsx'
import type { DiffHunkWithLines } from '../src/client/diff-model.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function hunk(over: Partial<DiffHunkWithLines> = {}): DiffHunkWithLines {
  return {
    path: 'a.txt', oldText: 'hi\n', newText: 'hello\n', oldStart: 1, newStart: 1, ...over,
  }
}

describe('DiffLines', () => {
  it('renders aligned rows with old/new line numbers and the +/- prefixes', () => {
    // A change in the middle: one ctx row, one del, one add, one ctx.
    const view = render(<DiffLines hunks={[hunk({ oldText: 'a\nx\nc\n', newText: 'a\ny\nc\n' })]} />)
    const rows = view.container.querySelectorAll('[data-diff-kind]')
    expect(rows).toHaveLength(4)
    expect(rows[0]?.getAttribute('data-diff-kind')).toBe('ctx')
    expect(rows[1]?.getAttribute('data-diff-kind')).toBe('del')
    expect(rows[2]?.getAttribute('data-diff-kind')).toBe('add')
    expect(rows[3]?.getAttribute('data-diff-kind')).toBe('ctx')
    // Context rows carry both numbers; del only old; add only new.
    expect(rows[0]?.textContent).toContain('a')
    expect(rows[1]?.textContent).toContain('x')
    expect(rows[2]?.textContent).toContain('y')
    expect(rows[3]?.textContent).toContain('c')
    // The +/- prefixes draw through CSS ::before (visual), so the content
    // cells carry the bare text; the copy text adds the prefixes instead.
    expect(view.container.textContent).not.toContain('- x')
    // Footer totals: 1 added, 1 removed.
    expect(view.container.textContent).toContain('+1 -1 · 1 file')
  })

  it('renders a path header per file and aggregates the file count', () => {
    const view = render(<DiffLines hunks={[hunk(), { ...hunk(), path: 'b.txt' }]} />)
    expect(view.container.textContent).toContain('a.txt')
    expect(view.container.textContent).toContain('b.txt')
    expect(view.container.textContent).toContain('· 2 files')
  })

  it('collapses the middle at the height cap and expands on demand', () => {
    const oldLines = Array.from({ length: DEFAULT_DIFF_LINES_MAX_LINES + 4 }, (_, i) => `old${i}`).join('\n')
    const newLines = Array.from({ length: DEFAULT_DIFF_LINES_MAX_LINES + 4 }, (_, i) => `new${i}`).join('\n')
    render(<DiffLines hunks={[hunk({ oldText: oldLines, newText: newLines })]} />)
    // The expand affordance appears once the body exceeds the cap.
    const toggle = screen.getByRole('button', { name: /展开其余/ })
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: '收起差异' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '收起差异' }))
    expect(screen.getByRole('button', { name: /展开其余/ })).toBeTruthy()
  })

  it('copies the diff text through the clipboard helper', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    // A mid-change hunk exercises the context-line copy arm too.
    render(<DiffLines hunks={[hunk({ oldText: 'a\nx\nc\n', newText: 'a\ny\nc\n' })]} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制' })) })
    // The copy text carries the path header and the prefixed lines (context
    // lines with a two-space prefix, del with -, add with +).
    const text = writeText.mock.calls[0]?.[0] as string
    expect(text).toContain('a.txt')
    expect(text).toContain('  a')
    expect(text).toContain('- x')
    expect(text).toContain('+ y')
    expect(text).toContain('  c')
    expect(screen.getByRole('button', { name: '复制成功' })).toBeTruthy()
    // A second click while copied short-circuits (no second write).
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制成功' })) })
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('keeps the copy label when the host refuses the write', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    render(<DiffLines hunks={[hunk()]} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制' })) })
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('renders nothing for an empty hunk list', () => {
    const { container } = render(<DiffLines hunks={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
