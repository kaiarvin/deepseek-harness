// @vitest-environment jsdom
// DiffViewerRow: the expanded diff card renders the applied hunks through
// DiffBlock, names the tool and clickable path, reflects lifecycle states,
// and collapses the whole card on demand.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunningToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { DiffViewerRow } from '../src/client/DiffViewerRow.tsx'
import { zh } from '../src/client/locales.ts'

type RowProps = Parameters<typeof DiffViewerRow>[0]

const t: RowProps['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

function settled(over: Partial<ToolResultNode> = {}): ToolResultNode {
  return {
    kind: 'tool-result', seq: 3, time: 3_000, callId: 'call-edit',
    call: { name: 'edit', argsRaw: '{"file_path":"a.txt"}' },
    callTime: 2_000, content: [], isError: false, callView: null, resultView: null, subCalls: [],
    ...over,
  }
}

function running(over: Partial<RunningToolCall> = {}): RunningToolCall {
  return {
    callId: 'call-edit', name: 'edit', argsRaw: '{"file_path":"a.txt"}', turn: 1, step: 1, time: 2_000,
    callView: null, subCalls: [], ...over,
  }
}

function props(block: RowProps['block'], toolName = 'edit', over: Partial<RowProps> = {}): RowProps {
  return {
    callId: block.callId, toolName, block, cwd: '/ws', openFile: vi.fn(), t,
    ...over,
  } as unknown as RowProps
}

describe('DiffViewerRow', () => {
  it('renders an expanded diff card with the applied hunks and a clickable path', () => {
    const openFile = vi.fn()
    const view = render(<DiffViewerRow {...props(settled({
      resultView: {
        card: 'diff',
        title: 'Edit a.txt',
        diffs: [{ path: 'a.txt', oldText: 'hi\n', newText: 'hello\n', oldStart: 12, newStart: 12 }],
      },
    }), 'edit', { openFile })} />)
    expect(view.container.querySelector('[data-tool="edit"]')?.getAttribute('data-state')).toBe('ok')
    // Title names the mutation and the path is an openable link.
    expect(view.container.textContent).toContain('Edit')
    const path = screen.getByRole('button', { name: 'a.txt' })
    fireEvent.click(path)
    expect(openFile).toHaveBeenCalledWith('a.txt')
    // The diff body renders the removed and added sides…
    expect(view.container.textContent).toContain('hi')
    expect(view.container.textContent).toContain('hello')
    // …with the per-file line numbers rebased onto the hunk start.
    const rows = view.container.querySelectorAll('[data-diff-kind]')
    expect(rows.length).toBeGreaterThan(0)
    expect(view.container.textContent).toContain('12')
  })

  it('collapses and re-expands the card via the toggle', () => {
    const view = render(<DiffViewerRow {...props(settled({
      resultView: {
        card: 'diff', title: 'Edit a.txt',
        diffs: [{ path: 'a.txt', oldText: 'one\ntwo\n', newText: 'one\nTWO\n' }],
      },
    }))} />)
    expect(view.container.textContent).toContain('one')
    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(view.container.textContent).not.toContain('one')
    fireEvent.click(screen.getByRole('button', { name: '展开' }))
    expect(view.container.textContent).toContain('one')
  })

  it('names the write tool and relativizes the workspace-rooted path display', () => {
    const openFile = vi.fn()
    const view = render(<DiffViewerRow {...props(settled({
      call: { name: 'write', argsRaw: '{"file_path":"/ws/out/new.txt"}' },
      resultView: {
        card: 'diff', title: 'Write new.txt',
        diffs: [{ path: 'new.txt', oldText: null, newText: 'content\n' }],
      },
    }), 'write', { openFile })} />)
    expect(view.container.textContent).toContain('Write')
    // The link displays the workspace-relative path…
    fireEvent.click(screen.getByRole('button', { name: 'out/new.txt' }))
    // …but openFile receives the raw argument (the chat view resolves it).
    expect(openFile).toHaveBeenCalledWith('/ws/out/new.txt')
  })

  it('shows the error text on a failed mutation instead of a diff', () => {
    const view = render(<DiffViewerRow {...props(settled({
      isError: true,
      content: [{ type: 'text', text: 'file not observed' }],
    }))} />)
    expect(view.container.querySelector('[data-tool="edit"]')?.getAttribute('data-state')).toBe('error')
    expect(view.container.textContent).toContain('file not observed')
    expect(view.container.textContent).toContain('修改失败')
  })

  it('collapses a multiline error to its first line in the error surface', () => {
    const view = render(<DiffViewerRow {...props(settled({
      isError: true,
      content: [{ type: 'text', text: 'first line\nsecond line' }],
    }))} />)
    expect(view.container.querySelector('[data-tool="edit"]')?.getAttribute('data-state')).toBe('error')
    expect(view.container.textContent).toContain('first line')
    expect(view.container.textContent).toContain('second line')
  })

  it('announces the stopped state for an interrupted mutation', () => {
    const view = render(<DiffViewerRow {...props(settled({
      isError: true,
      error: { name: 'AbortError', code: 'interrupted' },
      content: [],
    }))} />)
    expect(view.container.querySelector('[data-tool="edit"]')?.getAttribute('data-state')).toBe('stopped')
    expect(view.container.textContent).toContain('修改已中止')
  })

  it('renders non-text result blocks as JSON fallback text', () => {
    const view = render(<DiffViewerRow {...props(settled({
      isError: true,
      content: [{ type: 'image', data: 'x' } as never],
    }))} />)
    expect(view.container.querySelector('[data-tool="edit"]')?.getAttribute('data-state')).toBe('error')
    expect(view.container.textContent).toContain('"image"')
  })

  it('keeps a relative path display as-is under a workspace cwd', () => {
    const openFile = vi.fn()
    render(<DiffViewerRow {...props(settled({
      call: { name: 'edit', argsRaw: '{"file_path":"a.txt"}' },
      resultView: {
        card: 'diff', title: 'Edit a.txt',
        diffs: [{ path: 'a.txt', oldText: 'x', newText: 'y' }],
      },
    }), 'edit', { openFile })} />)
    fireEvent.click(screen.getByRole('button', { name: 'a.txt' }))
    expect(openFile).toHaveBeenCalledWith('a.txt')
  })

  it('renders without a path when the args are not valid JSON', () => {
    const view = render(<DiffViewerRow {...props(settled({
      call: { name: 'edit', argsRaw: '{"file_path":' },
      resultView: {
        card: 'diff', title: 'Edit', diffs: [{ path: 'a.txt', oldText: 'x', newText: 'y' }],
      },
    }))} />)
    expect(view.container.querySelector('.path')).toBeNull()
    expect(view.container.textContent).toContain('Edit')
  })

  it('renders without a path when file_path is not a string', () => {
    const view = render(<DiffViewerRow {...props(settled({
      call: { name: 'edit', argsRaw: '{"file_path":123}' },
      resultView: {
        card: 'diff', title: 'Edit', diffs: [{ path: 'a.txt', oldText: 'x', newText: 'y' }],
      },
    }))} />)
    expect(view.container.querySelector('.path')).toBeNull()
  })

  it('renders without a path when the call head is outside the window', () => {
    const view = render(<DiffViewerRow {...props(settled({
      call: null,
      resultView: {
        card: 'diff', title: 'Edit', diffs: [{ path: 'a.txt', oldText: 'x', newText: 'y' }],
      },
    }))} />)
    expect(view.container.querySelector('.path')).toBeNull()
  })

  it('falls back to the failure copy when an errored call has no output', () => {
    const view = render(<DiffViewerRow {...props(settled({
      isError: true,
      content: [],
      error: { name: 'Error', code: 'internal' },
    }))} />)
    expect(view.container.querySelector('[data-tool="edit"]')?.getAttribute('data-state')).toBe('error')
    expect(view.container.textContent).toContain('修改失败')
  })

  it('falls back to the failure copy when an errored call carries neither output nor error', () => {
    const view = render(<DiffViewerRow {...props(settled({
      isError: true,
      content: [],
    }))} />)
    expect(view.container.textContent).toContain('修改失败')
  })

  it('keeps the absolute path display when no cwd is supplied', () => {
    const openFile = vi.fn()
    render(<DiffViewerRow {...props(settled({
      call: { name: 'edit', argsRaw: '{"file_path":"/ws/a.txt"}' },
      resultView: {
        card: 'diff', title: 'Edit a.txt',
        diffs: [{ path: 'a.txt', oldText: 'x', newText: 'y' }],
      },
    }), 'edit', { cwd: undefined, openFile })} />)
    fireEvent.click(screen.getByRole('button', { name: '/ws/a.txt' }))
    expect(openFile).toHaveBeenCalledWith('/ws/a.txt')
  })

  it('announces the running state and shows the intended change', () => {
    const view = render(<DiffViewerRow {...props(running({
      callView: {
        card: 'diff', title: 'Edit a.txt',
        diffs: [{ path: 'a.txt', oldText: 'x', newText: 'y' }],
      },
    }))} />)
    expect(view.container.textContent).toContain('正在应用修改')
    expect(view.container.textContent).toContain('x')
    expect(view.container.textContent).toContain('y')
  })

  it('renders the empty state when the call carries no diff view', () => {
    const view = render(<DiffViewerRow {...props(settled())} />)
    expect(view.container.textContent).toContain('暂无 diff')
  })

  it('offers the trajectory inspect handoff when available', () => {
    const inspect = vi.fn()
    render(<DiffViewerRow {...props(settled({
      resultView: {
        card: 'diff', title: 'Edit a.txt',
        diffs: [{ path: 'a.txt', oldText: 'x', newText: 'y' }],
      },
    }), 'edit', { inspect })} />)
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
    expect(inspect).toHaveBeenCalledTimes(1)
  })
})
