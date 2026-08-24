// QuestionMap: a minimap rail at the left edge of the transcript scrollport.
// One bar per user question (user or steering node), the bars packed into a
// tight cluster centered on that edge; hover reveals the question text, click
// jumps the transcript to it. The rail is position:fixed (same escape hatch
// as Tooltip — no portal, no ancestor-transform requirement) and re-anchors
// off the scrollport's rect on every measure, so it stays put while the
// transcript scrolls beneath it and survives composer-overlay view modes
// where a sticky rail would lose its scrollport. The rail shows a fixed
// number of bars (RAIL_MAX_BARS); a taller cluster becomes its own scroll
// container, browsable by wheel and keeping the question at the reading edge
// in view.
//
// Cost: one scroll listener (the rail position itself never changes during
// scroll — only the active marker does) plus a ResizeObserver on the
// scrollport and the flow list. All DOM reads are rect probes over question
// rows only; the transcript is never virtualized today.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './QuestionMap.module.css'

/** One user question projected for the map rail. */
export interface QuestionMapEntry {
  /** The chat node key; matches the row's `data-chat-anchor-key`. */
  key: string
  /** Pre-localized question text for the hover tooltip and bar label. */
  snippet: string
}

interface PlacedBar {
  entry: QuestionMapEntry
  /** The bar's top edge as a pixel offset from the cluster's top edge. */
  top: number
}

interface RailFrame {
  left: number
  top: number
  height: number
}

/** Bar hit-area height and the gap between adjacent bars in the cluster. */
const BAR_HEIGHT = 7
const BAR_GAP = 2

/** Fixed cap on the rail: how many bars stay visible at once. */
const RAIL_MAX_BARS = 10

/** Snapshot of the question text for one bar: collapsed, trimmed, capped. */
const SNIPPET_MAX = 180

/**
 * Project one user message's text blocks into the map's tooltip label.
 * @param content - the user/steering node content blocks.
 * @param imageOnlyLabel - locale label used when the message carries no text.
 * @returns a single-line, truncated question preview.
 */
export function questionSnippet(content: readonly unknown[], imageOnlyLabel: string): string {
  let text = ''
  for (const block of content) {
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') text += candidate.text
  }
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized === '') return imageOnlyLabel
  return normalized.length > SNIPPET_MAX
    ? `${normalized.slice(0, SNIPPET_MAX)}…`
    : normalized
}

/**
 * The chat minimap rail. Owns its geometry and interactions; the parent view
 * supplies the flow rows, and the rail resolves the transcript scrollport from
 * them (the same rule as ChatView's `scrollerOf`: the `[data-conversation-scroll]`
 * host when present, else the flow list itself).
 * @param props.entries - one entry per user question, in flow order.
 * @param props.listRef - the flow list element holding `[data-chat-anchor-key]` rows.
 * @returns the rail, or null while the transcript fits the viewport or has fewer than two questions.
 */
export function QuestionMap({ entries, listRef }: {
  entries: readonly QuestionMapEntry[]
  listRef: { readonly current: HTMLElement | null }
}) {
  const [frame, setFrame] = useState<RailFrame | null>(null)
  const [bars, setBars] = useState<readonly PlacedBar[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const railRef = useRef<HTMLDivElement | null>(null)
  // ChatView scrolls the same element; the map's own passive listener only
  // refreshes the active marker, never writes scroll geometry.
  const measure = useCallback(() => {
    const list = listRef.current
    if (list === null || entries.length === 0) {
      setFrame(null)
      setBars([])
      setActiveKey(null)
      return
    }
    // Resolved per measure so a remount under a different scrollport (view
    // switch) re-anchors without extra plumbing; listRef is attached by the
    // time layout effects run, unlike a parent-owned scrollport ref.
    const scroller = list.closest('[data-conversation-scroll]') ?? list
    const scrollerRect = scroller.getBoundingClientRect()
    const contentHeight = list.scrollHeight
    const style = getComputedStyle(scroller)
    const composerHeight = Number.parseFloat(style.getPropertyValue('--dsh-composer-height')) || 0
    const height = Math.max(0, scroller.clientHeight - composerHeight - 16)
    // A map is only useful when the transcript actually scrolls and there is
    // something to navigate between; both gates keep the rail off short chats.
    if (entries.length < 2 || contentHeight <= scroller.clientHeight + 8 || height <= 0) {
      setFrame(null)
      setBars([])
      setActiveKey(null)
      return
    }
    // The cluster: one 14px bar per question, 6px apart, centered in the
    // reading area. The rail never shows more than a fixed number of bars; a
    // taller cluster scrolls inside the rail (wheel input), browsable in place.
    const stackHeight = entries.length * BAR_HEIGHT + (entries.length - 1) * BAR_GAP
    const railHeight = Math.min(
      stackHeight,
      RAIL_MAX_BARS * BAR_HEIGHT + (RAIL_MAX_BARS - 1) * BAR_GAP,
      height,
    )
    const placed: PlacedBar[] = []
    let active: string | null = null
    let entryIndex = 0
    const readingEdge = scrollerRect.top + 16
    for (const row of list.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')) {
      const entry = entries[entryIndex]
      if (entry === undefined) break
      if (row.dataset.chatAnchorKey !== entry.key) continue
      const rowTop = row.getBoundingClientRect().top
      placed.push({ entry, top: entryIndex * (BAR_HEIGHT + BAR_GAP) })
      if (rowTop <= readingEdge) active = entry.key
      entryIndex += 1
    }
    setFrame({
      left: scrollerRect.left + 8,
      top: scrollerRect.top + 16 + Math.max(0, (height - railHeight) / 2),
      height: railHeight,
    })
    setBars(placed)
    setActiveKey(active)
  }, [entries, listRef])

  // Keep the rail anchored and the active marker current: the scrollport's
  // box moves on layout changes (resize, header collapse, composer overlay),
  // and question rows move relative to the viewport on every scroll. No rail,
  // no listeners — both effects re-run when an entries change revives them.
  useEffect(() => {
    if (entries.length < 2) return
    const list = listRef.current
    if (list === null) return
    const scroller = list.closest('[data-conversation-scroll]') ?? list
    const onScroll = (): void => { measure() }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => { scroller.removeEventListener('scroll', onScroll) }
  }, [entries.length, listRef, measure])

  // Flow growth (streaming, paging) and scrollport resizes both re-measure.
  useEffect(() => {
    if (entries.length < 2) return
    const list = listRef.current
    if (list === null || typeof ResizeObserver === 'undefined') return
    const scroller = list.closest('[data-conversation-scroll]') ?? list
    const observer = new ResizeObserver(() => { measure() })
    observer.observe(scroller)
    if (list !== scroller) observer.observe(list)
    return () => { observer.disconnect() }
  }, [entries.length, listRef, measure])

  // First paint and every entries change (a prepend shifts question rows).
  useLayoutEffect(() => {
    measure()
  }, [measure])

  // When the cluster outgrows the rail, follow the active question so the
  // "you are here" mark stays visible; otherwise keep the cluster pinned to
  // its top. Only scrolls when the active bar is actually out of view, so a
  // conversation scroll never fights a manual read of the cluster.
  useLayoutEffect(() => {
    const rail = railRef.current
    if (rail === null || activeKey === null) return
    const overflow = rail.scrollHeight > rail.clientHeight + 1
    if (!overflow) {
      rail.scrollTop = 0
      return
    }
    const index = entries.findIndex(entry => entry.key === activeKey)
    if (index < 0) return
    const barTop = index * (BAR_HEIGHT + BAR_GAP)
    const viewBottom = rail.scrollTop + rail.clientHeight
    if (barTop < rail.scrollTop || barTop + BAR_HEIGHT > viewBottom) {
      rail.scrollTop = Math.min(
        Math.max(barTop - rail.clientHeight / 2 + BAR_HEIGHT / 2, 0),
        rail.scrollHeight - rail.clientHeight,
      )
    }
  }, [activeKey, entries, frame])

  const jumpTo = (key: string): void => {
    const list = listRef.current
    if (list === null) return
    const scroller = list.closest('[data-conversation-scroll]') ?? list
    let row: HTMLElement | null = null
    for (const candidate of list.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')) {
      if (candidate.dataset.chatAnchorKey === key) {
        row = candidate
        break
      }
    }
    if (row === null) return
    // Viewport-relative increment: the row lands 16px below the scrollport's
    // top edge from any scroll position. A flow-relative offset added to the
    // current scrollTop would overshoot — from the bottom-follow position it
    // clamps back to the floor and the click looks like a no-op. ChatView's
    // own scroll listener re-derives follow ownership and the saved position.
    scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16
  }

  if (frame === null || bars.length === 0) return null
  return (
    <div ref={railRef} className={css.rail} style={{ left: frame.left, top: frame.top, height: frame.height }}>
      {bars.map(({ entry, top }) => (
        <Tooltip key={entry.key} label={entry.snippet} side="right" delayMs={150} maxWidth={320}>
          <button
            type="button"
            className={clsx(css.bar, entry.key === activeKey && css.barActive)}
            style={{ top: `${top}px` }}
            aria-label={entry.snippet}
            onClick={() => { jumpTo(entry.key) }}
          >
            <span className={css.barMark} aria-hidden />
          </button>
        </Tooltip>
      ))}
    </div>
  )
}
