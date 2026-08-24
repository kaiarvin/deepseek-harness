// @vitest-environment jsdom
// QuestionMap behavior: projection, packed-cluster placement, active marker,
// hover tooltips, click-to-jump, and the visibility gates — mounted directly
// with synthetic flow rows and a scripted scrollport, so no wire or view
// composition is involved.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { QuestionMap, questionSnippet, type QuestionMapEntry } from '../src/client/chat/QuestionMap.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

interface MapHarnessOptions {
  entries?: readonly QuestionMapEntry[]
  /** Flow content height (the list's scrollHeight). */
  contentHeight?: number
  /** Scrollport viewport height. */
  clientHeight?: number
  /** Per-entry row top in viewport coordinates (defaults: 100 + 300 * i). */
  rowTops?: readonly number[]
  /** The flow list's own top (its rect top). */
  listTop?: number
  /** The scrollport's rect top (the reading edge anchor). */
  scrollerTop?: number
  /** Inline --dsh-composer-height on the scrollport (defaults to unset). */
  composerHeight?: string
  /** Share one element as both list and scrollport (the standalone-chat case). */
  alone?: boolean
}

const TWO_ENTRIES = [
  { key: 'q1', snippet: 'first question' },
  { key: 'q2', snippet: 'second question' },
] satisfies readonly QuestionMapEntry[]

function rect(over: Partial<DOMRect> = {}): DOMRect {
  return {
    x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0,
    toJSON: () => ({}),
    ...over,
  }
}

/** Build a flow list with one `[data-chat-anchor-key]` row per entry. */
function buildFlow(entries: readonly QuestionMapEntry[], rowTops: readonly number[], listTop: number): HTMLElement {
  const list = document.createElement('div')
  list.setAttribute('data-chat-flow', '')
  entries.forEach((entry, index) => {
    const row = document.createElement('div')
    row.dataset.chatAnchorKey = entry.key
    const top = rowTops[index] ?? 0
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(rect({ top, bottom: top + 20 }))
    list.appendChild(row)
  })
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(rect({ top: listTop, bottom: listTop + 100 }))
  return list
}

function makeHarness(options: MapHarnessOptions = {}) {
  const {
    entries = TWO_ENTRIES,
    contentHeight = 1_000,
    clientHeight = 400,
    rowTops = [100, 400],
    listTop = 0,
    scrollerTop = 0,
    composerHeight = '',
    alone = false,
  } = options
  const scroller = document.createElement('div')
  if (!alone) scroller.setAttribute('data-conversation-scroll', '')
  if (composerHeight !== '') scroller.style.setProperty('--dsh-composer-height', composerHeight)
  let scrollTop = 0
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => contentHeight })
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => { scrollTop = Math.max(0, value) },
  })
  vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(
    rect({ top: scrollerTop, bottom: scrollerTop + clientHeight, left: 40, right: 540, width: 500 }),
  )
  const list = alone ? scroller : buildFlow(entries, rowTops, listTop)
  if (!alone) {
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => contentHeight })
    scroller.appendChild(list)
  }
  const listRef = { current: list as HTMLElement | null }
  const view = render(
    <QuestionMap entries={entries} listRef={listRef} />,
  )
  return {
    view, scroller, list, listRef,
    setScrollTop: (value: number) => { scrollTop = value },
  }
}

describe('questionSnippet', () => {
  it('joins text blocks, collapses whitespace, and trims', () => {
    expect(questionSnippet([
      { type: 'text', text: '  hello\n  world ' },
      { type: 'text', text: '  second\tline  ' },
      { type: 'image', attachment: {} },
    ], '[Image message]')).toBe('hello world second line')
  })

  it('falls back to the image-only label when no text block exists', () => {
    expect(questionSnippet([{ type: 'image', attachment: {} }], '[图片消息]')).toBe('[图片消息]')
    expect(questionSnippet([], '[图片消息]')).toBe('[图片消息]')
  })

  it('truncates long questions with an ellipsis', () => {
    const snippet = questionSnippet([{ type: 'text', text: 'x'.repeat(400) }], '[图片消息]')
    expect(snippet).toHaveLength(181)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet.startsWith('x'.repeat(180))).toBe(true)
  })
})

describe('QuestionMap rail', () => {
  it('renders one bar per question, packed into a top-down cluster', () => {
    const { view } = makeHarness({ contentHeight: 1_000, clientHeight: 400, rowTops: [100, 400] })
    const bars = view.getAllByRole('button')
    // Packed: first bar at the cluster top, second 9px below (7 + 2 gap).
    expect(bars).toHaveLength(2)
    expect(bars[0]!.style.top).toBe('0px')
    expect(bars[1]!.style.top).toBe('9px')
    expect(bars[0]!.getAttribute('aria-label')).toBe('first question')
  })

  it('centers the packed cluster in the reading area, off the scrollport rect', () => {
    const { view } = makeHarness({ contentHeight: 1_000, clientHeight: 400 })
    const rail = view.container.querySelector('[class*="rail"]') as HTMLElement
    expect(rail.style.left).toBe('48px') // scrollport left 40 + 8
    // Usable 400 - 16 = 384; cluster 2*7 + 2 = 16; top 16 + (384-16)/2 = 200.
    expect(rail.style.top).toBe('200px')
    expect(rail.style.height).toBe('16px')
  })

  it('clears the composer height from the reading area before centering', () => {
    const { view } = makeHarness({
      contentHeight: 1_000, clientHeight: 400, composerHeight: '100px', scrollerTop: 25,
    })
    const rail = view.container.querySelector('[class*="rail"]') as HTMLElement
    expect(rail.style.left).toBe('48px') // scrollport left 40 + 8
    // Usable 400 - 100 - 16 = 284; cluster 2*7 + 2 = 16; top 25 + 16 + (284-16)/2 = 175.
    expect(rail.style.top).toBe('175px')
    expect(rail.style.height).toBe('16px')
  })

  it('stays hidden with fewer than two questions', () => {
    const { view } = makeHarness({ entries: [{ key: 'q1', snippet: 'only one' }] })
    expect(view.container.querySelector('[class*="rail"]')).toBeNull()
  })

  it('stays hidden while the transcript fits the scrollport', () => {
    const { view } = makeHarness({ contentHeight: 300, clientHeight: 400 })
    expect(view.container.querySelector('[class*="rail"]')).toBeNull()
  })

  it('stays hidden when the composer occupies the whole scrollport', () => {
    const { view } = makeHarness({ composerHeight: '500px', clientHeight: 400 })
    expect(view.container.querySelector('[class*="rail"]')).toBeNull()
  })

  it('hides when no question row is mounted yet', () => {
    const { view, scroller, list } = makeHarness()
    for (const row of [...list.querySelectorAll('[data-chat-anchor-key]')]) row.remove()
    fireEvent.scroll(scroller)
    expect(view.container.querySelector('[class*="rail"]')).toBeNull()
  })

  it('skips rows that are not questions (assistant/tool rows)', () => {
    const { view, scroller, list } = makeHarness({ rowTops: [100, 400] })
    const filler = document.createElement('div')
    filler.dataset.chatAnchorKey = 'fixture:assistant:5'
    vi.spyOn(filler, 'getBoundingClientRect').mockReturnValue(rect({ top: 250 }))
    list.insertBefore(filler, list.children[1] ?? null)
    fireEvent.scroll(scroller)
    expect(view.getAllByRole('button')).toHaveLength(2)
  })

  it('highlights the question at the reading edge and updates on scroll', () => {
    const { view, scroller, list, setScrollTop } = makeHarness({ rowTops: [100, 400] })
    expect(view.container.querySelectorAll('[class*="barActive"]')).toHaveLength(0)
    // Scroll so the first question sits at the reading edge (top <= 16).
    setScrollTop(84)
    vi.spyOn(list.children[0] as HTMLElement, 'getBoundingClientRect').mockReturnValue(rect({ top: 16 }))
    fireEvent.scroll(scroller)
    const active = view.container.querySelectorAll('[class*="barActive"]')
    expect(active).toHaveLength(1)
    expect((active[0] as HTMLElement).getAttribute('aria-label')).toBe('first question')
  })

  it('clicking a bar jumps the transcript to the question row', () => {
    const { view, scroller, setScrollTop } = makeHarness({ rowTops: [100, 400] })
    fireEvent.click(view.getByRole('button', { name: 'second question' }))
    expect(scroller.scrollTop).toBe(384) // flowTop 400 - 16
    setScrollTop(0)
    fireEvent.click(view.getByRole('button', { name: 'first question' }))
    expect(scroller.scrollTop).toBe(84) // flowTop 100 - 16
  })

  it('jumps correctly from a scrolled (bottom-follow) position', () => {
    // Regression: the jump used to add a flow-relative offset to the current
    // scrollTop, so from the floor (e.g. 600) it overshot, clamped back to the
    // floor, and the click looked like a no-op. The viewport-relative increment
    // lands the row 16px below the top from any scroll position.
    const { view, scroller, list, setScrollTop } = makeHarness({ listTop: 16, rowTops: [100, 400] })
    setScrollTop(600)
    // The first row's content sits at 100; scrolled to 600 with scrollerTop 0
    // its viewport top is -500.
    vi.spyOn(list.children[0] as HTMLElement, 'getBoundingClientRect').mockReturnValue(rect({ top: -500 }))
    fireEvent.click(view.getByRole('button', { name: 'first question' }))
    expect(scroller.scrollTop).toBe(84) // 600 + (-500 - 0 - 16)
  })

  it('a click with no matching row, or no flow list, is a no-op', () => {
    const { view, scroller, list, listRef, setScrollTop } = makeHarness({ rowTops: [100, 400] })
    const second = view.getByRole('button', { name: 'second question' })
    list.querySelectorAll('[data-chat-anchor-key]')[1]?.remove()
    fireEvent.click(second)
    expect(scroller.scrollTop).toBe(0)
    // The flow list disappears mid-session: the guard keeps the click inert.
    setScrollTop(10)
    listRef.current = null
    fireEvent.click(view.getByRole('button', { name: 'first question' }))
    expect(scroller.scrollTop).toBe(10)
  })

  it('shows the question text in a hover tooltip', () => {
    vi.useFakeTimers()
    const { view } = makeHarness({ rowTops: [100, 400] })
    const bar = view.getByRole('button', { name: 'second question' })
    fireEvent.mouseEnter(bar)
    act(() => { vi.advanceTimersByTime(200) })
    const tooltip = view.getByRole('tooltip')
    expect(tooltip.textContent).toBe('second question')
    fireEvent.mouseLeave(bar)
    expect(view.queryByRole('tooltip')).toBeNull()
  })

  it('keeps the cluster geometry when the flow grows (prepend or stream)', () => {
    const { view, scroller, list } = makeHarness({ rowTops: [100, 400] })
    expect(view.getAllByRole('button')[0]!.style.top).toBe('0px')
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 2_000 })
    fireEvent.scroll(scroller)
    const bars = view.getAllByRole('button')
    expect(bars[0]!.style.top).toBe('0px')
    expect(bars[1]!.style.top).toBe('9px')
  })

  it('caps the rail at a fixed bar count when the cluster outgrows the reading area', () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({ key: `q${i}`, snippet: `question ${i}` }))
    const rowTops = Array.from({ length: 50 }, (_, i) => 100 + i * 30)
    const { view } = makeHarness({ entries, rowTops, contentHeight: 5_000, clientHeight: 400 })
    const rail = view.container.querySelector('[class*="rail"]') as HTMLElement
    expect(view.getAllByRole('button')).toHaveLength(50)
    // 50*7 + 49*2 = 448 > usable 384, but the rail never shows more than 10
    // bars (10*7 + 9*2 = 88): it caps there and stays centered (16 + (384-88)/2
    // = 164).
    expect(rail.style.height).toBe('88px')
    expect(rail.style.top).toBe('164px')
  })

  it('keeps the rail at the fixed bar count even inside a tall reading area', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ key: `q${i}`, snippet: `question ${i}` }))
    const rowTops = Array.from({ length: 40 }, (_, i) => 100 + i * 30)
    const { view } = makeHarness({ entries, rowTops, contentHeight: 5_000, clientHeight: 1_000 })
    const rail = view.container.querySelector('[class*="rail"]') as HTMLElement
    // 40*7 + 39*2 = 358 < usable 984 — the fixed bar cap (not the reading
    // area) bounds the rail, so a full conversation never grows it to screen
    // height.
    expect(rail.style.height).toBe('88px')
    expect(rail.style.top).toBe('464px') // 16 + (984-88)/2
  })

  it('scrolls the internal cluster to keep the active question visible', () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({ key: `q${i}`, snippet: `question ${i}` }))
    const rowTops = Array.from({ length: 50 }, () => 100)
    const { view, scroller, list } = makeHarness({ entries, rowTops, contentHeight: 5_000, clientHeight: 400 })
    const rail = view.container.querySelector('[class*="rail"]') as HTMLElement
    Object.defineProperty(rail, 'scrollHeight', { configurable: true, value: 448 })
    Object.defineProperty(rail, 'clientHeight', { configurable: true, value: 384 })
    // The last question moves to the reading edge and becomes the active marker.
    const last = list.querySelectorAll('[data-chat-anchor-key]')[49] as HTMLElement
    vi.spyOn(last, 'getBoundingClientRect').mockReturnValue(rect({ top: 16 }))
    fireEvent.scroll(scroller)
    // Bar 49 sits at 441px; the 384px window centers it at 64 (capped at 448-384).
    expect(rail.scrollTop).toBe(64)
  })

  it('removes its scroll listener on unmount', () => {
    const { view, scroller } = makeHarness()
    expect(view.container.querySelector('[class*="rail"]')).toBeTruthy()
    const spy = vi.spyOn(scroller, 'removeEventListener')
    view.unmount()
    expect(spy).toHaveBeenCalledWith('scroll', expect.any(Function))
  })

  it('observes the flow list and scrollport for geometry, and disconnects on unmount', () => {
    const observed: unknown[] = []
    const disconnected = vi.fn()
    class ResizeObserverStub {
      observe = vi.fn((target: unknown) => { observed.push(target) })
      disconnect = disconnected
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    const { view } = makeHarness()
    // Both the scrollport and (as distinct elements) the flow list are observed.
    expect(observed).toHaveLength(2)
    view.unmount()
    expect(disconnected).toHaveBeenCalled()
  })

  it('observes a single element when the list IS the scrollport (standalone chat)', () => {
    const observed: unknown[] = []
    class ResizeObserverStub {
      observe = vi.fn((target: unknown) => { observed.push(target) })
      disconnect = vi.fn()
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    makeHarness({ alone: true, contentHeight: 1_000, clientHeight: 400 })
    expect(observed).toHaveLength(1)
  })

  it('stays hidden while the flow list is unresolved and measures once it appears', () => {
    const listRef = { current: null as HTMLElement | null }
    const view = render(<QuestionMap entries={TWO_ENTRIES} listRef={listRef} />)
    expect(view.container.querySelector('[class*="rail"]')).toBeNull()

    // The flow list resolves later, mounted inside a real scrollport; a
    // re-measure (entries change) picks it up.
    const scroller = document.createElement('div')
    scroller.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 1_000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 400 })
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(rect({ top: 0, left: 40 }))
    const list2 = buildFlow(TWO_ENTRIES, [100, 400], 0)
    Object.defineProperty(list2, 'scrollHeight', { configurable: true, get: () => 1_000 })
    scroller.appendChild(list2)
    listRef.current = list2
    view.rerender(
      <QuestionMap entries={[...TWO_ENTRIES, { key: 'q3', snippet: 'third' }]} listRef={listRef} />,
    )
    expect(view.container.querySelector('[class*="rail"]')).not.toBeNull()
  })

  it('hides with no entries at all', () => {
    const { view } = makeHarness({ entries: [] })
    expect(view.container.querySelector('[class*="rail"]')).toBeNull()
  })
})
