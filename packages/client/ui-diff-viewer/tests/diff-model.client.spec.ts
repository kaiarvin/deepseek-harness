// diff-model: pure hunks derivation from the frozen call slice. The settled
// result view's applied hunks win over the call-time view; running calls show
// the intended change; malformed or absent diff views route to null (empty).

import { describe, expect, it } from 'vitest'
import type { RunningToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { diffHunks } from '../src/client/diff-model.ts'

function result(over: Partial<ToolResultNode> = {}): ToolResultNode {
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

describe('diffHunks', () => {
  it('uses the settled result view when present (applied hunks win)', () => {
    const block = result({
      resultView: {
        card: 'diff',
        title: 'Edit a.txt',
        diffs: [{ path: 'a.txt', oldText: 'hi\n', newText: 'hello\n', oldStart: 12, newStart: 12 }],
      },
    })
    expect(diffHunks(block)).toEqual([{ path: 'a.txt', oldText: 'hi\n', newText: 'hello\n', oldStart: 12, newStart: 12 }])
  })

  it('passes hunks without start lines through as-is (call-time views)', () => {
    const block = result({
      resultView: {
        card: 'diff',
        title: 'Edit a.txt',
        diffs: [{ path: 'a.txt', oldText: 'hi\n', newText: 'hello\n' }],
      },
    })
    expect(diffHunks(block)).toEqual([{ path: 'a.txt', oldText: 'hi\n', newText: 'hello\n' }])
  })

  it('ignores a generic settled result view (error path → null)', () => {
    expect(diffHunks(result({ resultView: null }))).toBeNull()
    expect(diffHunks(result({ isError: true, content: [{ type: 'text', text: 'boom' }] }))).toBeNull()
  })

  it('uses the call-time view while running', () => {
    const block = running({
      callView: {
        card: 'diff',
        title: 'Write a.txt',
        diffs: [{ path: 'a.txt', oldText: null, newText: 'new file\n' }],
      },
    })
    expect(diffHunks(block)).toEqual([{ path: 'a.txt', oldText: null, newText: 'new file\n' }])
  })

  it('returns null for a running call with no diff view', () => {
    expect(diffHunks(running())).toBeNull()
  })

  it('narrows malformed hunks to null instead of throwing', () => {
    // Wire-corrupted views arrive as `unknown`; the model must narrow them
    // without throwing (the tool contract validates only the `card` string).
    const fromView = (resultView: unknown) => result({
      resultView: resultView as ToolResultNode['resultView'],
    })
    expect(diffHunks(fromView({ card: 'diff', title: 'Edit', diffs: [{ path: 'a.txt', oldText: 42, newText: 'x' }] }))).toBeNull()
    expect(diffHunks(fromView({ card: 'diff', title: 'Edit', diffs: 'oops' }))).toBeNull()
    expect(diffHunks(fromView({ card: 'diff', title: 'Edit', diffs: [] }))).toBeNull()
    expect(diffHunks(fromView({ card: 'diff', title: 'Edit', diffs: ['not-a-hunk'] }))).toBeNull()
    expect(diffHunks(fromView({ card: 'diff', title: 'Edit', diffs: [null] }))).toBeNull()
    expect(diffHunks(fromView({ card: 'diff', title: 'Edit', diffs: [{ path: 'a.txt', oldText: null, newText: 7 }] }))).toBeNull()
    expect(diffHunks(fromView({ card: 'diff', title: 'Edit', diffs: [{ path: 9, oldText: null, newText: 'x' }] }))).toBeNull()
    expect(diffHunks(fromView({ card: 'diff', title: 'Edit', diffs: [{ path: 'a', oldText: 'x', newText: 'y', oldStart: 'nope' }] }))).toBeNull()
    expect(diffHunks(fromView({ card: 'diff', title: 'Edit', diffs: [{ path: 'a', oldText: 'x', newText: 'y', newStart: true }] }))).toBeNull()
  })

  it('keeps the call-time hunks when the settled result has none', () => {
    const block = result({
      callView: {
        card: 'diff',
        title: 'Edit a.txt',
        diffs: [{ path: 'a.txt', oldText: 'x', newText: 'y' }],
      },
      resultView: null,
    })
    // Settled: the result side is authoritative, so no call-time fallback.
    expect(diffHunks(block)).toBeNull()
  })
})
