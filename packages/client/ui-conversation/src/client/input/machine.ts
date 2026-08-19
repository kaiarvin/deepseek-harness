/**
 * InputMachine: the pure per-session input state machine.
 * Events in, effects out; zero React / DOM / cordis / ambient
 * clock. Package-private — the SessionInput shell is the only caller and the
 * sole executor of the returned effects.
 *
 * Draft truth: the draft string holds one U+FFFC placeholder CELL per 4em of
 * chip width — a chip occupies `length` consecutive placeholder chars, so
 * both text layers agree on the pill's advance by construction; the
 * occurrence table carries identity and the owner's cached projections. Every
 * draft mutation is one transaction — draft edit, occurrence reconciliation,
 * and undo-log push are atomic inside dispatch() — and bumps draftRev, which
 * is what lets span CAS reduce to a revision-equality check: equal rev ⟹
 * identical draft ⟹ identical span content. Callers observe mutation success
 * as a draftRev advance (begin-command / insert-ref / consume-token /
 * paste-upgrade all answer their bail events this way).
 */
import type { CommandClaim, ReferenceInsert, TokenSpan } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { InputSubmitMode } from '../contract/composer-submission.ts'
import type {
  ConsumeTokenGuard, EditRange, EditSelection, InputEffect, InputEvent, InputMachineOptions,
  InputState, Occurrence, PasteAttemptState, PasteComponent, SubmitAttempt,
} from './contract.ts'

/** The object-replacement character backing every chip cell in the draft. */
export const PLACEHOLDER = '￼'

/** DshChipCell's U+FFFC advance: one 4em blank cell per chip cell (both layers agree by construction). */
export const CELL_WIDTH_EM = 4

/** Defensive pill-width ceiling: a longer label clips at the cap; the full name rides the title tooltip. */
export const MAX_CELLS = 24

/** East-Asian-width matcher: CJK/full-width/emoji glyphs occupy a full em (2 narrow units). */
const WIDE_RE = new RegExp(
  '[\\u1100-\\u115F\\u2E80-\\u303F\\u3040-\\u30FF\\u31F0-\\u31FF\\u3400-\\u4DBF\\u4E00-\\u9FFF'
    + '\\uA000-\\uA48F\\uA960-\\uA97F\\uAC00-\\uD7A3\\uF900-\\uFAFF\\uFE10-\\uFE19\\uFE30-\\uFE6F\\uFF00-\\uFF60\\uFFE0-\\uFFE6'
    + '\\u{1F300}-\\u{1FAFF}\\u{20000}-\\u{2FA1F}]',
  'u',
)

/** Legacy marker characters rejected from pasted text (the placeholder plus the old icon glyphs). */
const REFERENCE_PLACEHOLDER_RE = /[\uE100-\uE11D\uFFFC]/gu

/**
 * Chip cell-count estimate for a label: narrow chars ≈ 0.5em each, wide
 * chars ≈ 1em, the label renders at the 0.72 pill scale with 10px of box
 * slack (scaled at a 14px font), divided by the 4em cell. A layout ESTIMATE
 * only — the composer measures the real label after paint and grows the run
 * when this under-shoots (grow-only; an over-estimate leaves a roomier pill).
 * @param label - the chip's display label.
 * @returns cell count in [1, MAX_CELLS].
 */
export function cellsForLabel(label: string): number {
  let units = 0
  for (const ch of label) units += WIDE_RE.test(ch) ? 2 : 1
  // ceil keeps every nonempty (and even empty) label at ≥ 1 cell: the
  // numerator floor is 0.514/4 = 0.13.
  const cells = Math.ceil((units * 0.5 * 0.72 + 10 * 0.72 / 14) / CELL_WIDTH_EM)
  return Math.min(MAX_CELLS, cells)
}

/** The machine never writes the queue; the wiring layer overlays the queue store's projection. */
const EMPTY_QUEUE: InputState['queue'] = []

/** Undo ring depth (bounded self-managed transaction log). */
const LOG_LIMIT = 100

/** Exhaustiveness backstop for the closed InputEvent / guard unions. */
function unreachable(value: never): never {
  throw new Error(`unreachable input event: ${JSON.stringify(value)}`)
}

/**
 * Strip the claim token off a draft to yield submit args. Leading whitespace
 * (incl. newlines — leading-trigger trim) is tolerated; a bare `/name`
 * missing the token's trailing separator yields empty args. Exactly one
 * separator char is consumed; the remainder — newlines included — stays
 * verbatim (`/goal x\ny` → `x\ny`).
 */
function argsAfter(draft: string, token: string): string {
  const s = draft.trimStart()
  if (s.startsWith(token)) return s.slice(token.length)
  const base = token.trimEnd()
  if (s.startsWith(base)) {
    const rest = s.slice(base.length)
    return /^\s/.test(rest) ? rest.slice(1) : rest
  }
  return ''
}

/**
 * Prefix/suffix common-scan recovering the edit range between two drafts
 * (used when the wiring layer cannot supply one from the DOM event).
 */
function diffEdit(prev: string, next: string): EditRange {
  let p = 0
  const maxCommon = Math.min(prev.length, next.length)
  while (p < maxCommon && prev[p] === next[p]) p += 1
  let s = 0
  const maxSuffix = maxCommon - p
  while (s < maxSuffix && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s += 1
  return { start: p, end: prev.length - s, insertedLength: next.length - s - p }
}

/**
 * Expand the draft's reference ranges into their occurrences' clipboard text
 * for persistence and clipboard projection. Table order is offset order, so
 * one linear walk pairs ranges with entries.
 * @param state - published input state.
 * @returns the plain-text projection of the draft.
 */
export function projectClipboard(state: Pick<InputState, 'draft' | 'occurrences'>): string {
  const { draft, occurrences } = state
  if (occurrences.length === 0) return draft
  let out = ''
  let cursor = 0
  for (const o of occurrences) {
    out += draft.slice(cursor, o.offset) + o.clipboardText
    cursor = o.offset + o.length
  }
  return out + draft.slice(cursor)
}

/** One undo unit: snapshots taken before the transaction applied. */
interface Transaction {
  readonly draftBefore: string
  readonly occurrencesBefore: readonly Occurrence[]
  /** Pre-edit selection when the triggering event carried one (shell caret restore on undo). */
  readonly selectionBefore?: EditSelection
}

/**
 * Pure input machine, one instance per session (per-session isolation is by
 * construction). The machine constructs one AbortController per SubmitAttempt
 * at enter time and aborts it itself on release; the shell never aborts, it
 * only observes attempt.signal on its adjudicate/submit promises. Stale
 * attempts (any adjudicated / adjudication-failed / submit-settled whose seq
 * is not the in-flight one) are dropped: same state, zero effects.
 */
export class InputMachine {
  private draft = ''
  private draftRev = 0
  private phase: InputState['phase'] = 'plain'
  private claim: CommandClaim | undefined
  private occurrences: readonly Occurrence[] = []
  private occurrenceSeq = 0
  private seq = 0
  private inflight: {
    readonly attempt: SubmitAttempt
    readonly controller: AbortController
  } | undefined
  private log: Transaction[] = []
  private redoStack: Transaction[] = []
  /** Open single-char typing run: the next contiguous char within the window coalesces. */
  private typingRun: { readonly end: number; readonly at: number } | undefined
  private paste: PasteAttemptState | undefined
  private pasteSeq = 0
  private readonly mergeWindowMs: number
  private readonly now: () => number

  constructor(options: InputMachineOptions = {}) {
    this.mergeWindowMs = options.mergeWindowMs ?? 1000
    this.now = options.now ?? (() => 0)
  }

  /** Read-only snapshot of the machine state (queue always empty at this tier). */
  get state(): InputState {
    const c = this.claim
    return {
      draft: this.draft,
      imageIds: [],
      draftRev: this.draftRev,
      phase: this.phase,
      ...(c
        ? {
          claim: {
            token: c.token,
            ...(c.hint !== undefined ? { hint: c.hint } : {}),
            ...(c.images === true ? { images: true } : {}),
          },
        }
        : {}),
      occurrences: this.occurrences,
      ...(this.paste !== undefined ? { paste: this.paste } : {}),
      queue: EMPTY_QUEUE,
    }
  }

  /**
   * Feed one event through the machine.
   * @param ev - Input event; the single write path for all input state.
   * @returns Effects for the shell to execute in order; empty on no-ops, locks, and dropped stale events.
   */
  dispatch(ev: InputEvent): readonly InputEffect[] {
    switch (ev.type) {
      case 'draft-changed': return this.onDraftChanged(ev.draft, ev.editRange)
      case 'begin-command': return this.onBeginCommand(ev.claim, ev.span)
      case 'insert-ref': return this.onInsertRef(ev.reference, ev.span)
      case 'resize-chip': return this.onResizeChip(ev.occurrenceId, ev.cells)
      case 'consume-token': return this.onConsumeToken(ev.guard)
      case 'set-invalid': return this.onSetInvalid(ev.invalidIds)
      case 'undo': return this.onUndo()
      case 'redo': return this.onRedo()
      case 'paste-begin': return this.onPasteBegin(ev.text, ev.selection, ev.components, ev.generation)
      case 'paste-upgrade': return this.onPasteUpgrade(ev.attemptId, ev.span, ev.reference)
      case 'invalidate-paste': {
        this.paste = undefined
        return []
      }
      case 'enter': return this.onEnter(ev.mode)
      case 'adjudicated': return this.onAdjudicated(ev.attempt, ev.outcome)
      case 'adjudication-failed': return this.onAdjudicationFailed(ev.attempt, ev.message)
      case 'submit-settled': return this.onSubmitSettled(ev)
      case 'send-committed': return this.onSendCommitted()
      case 'release': return this.onRelease()
      default: return unreachable(ev)
    }
  }

  // ---- transaction plumbing ----

  /** Adopt a new draft: bump the revision (the span-CAS invalidation point). */
  private adopt(draft: string): void {
    this.draft = draft
    this.draftRev += 1
  }

  /** Push one undo unit (before-state), trim the ring, and cut the redo chain. */
  private pushTxn(selectionBefore?: EditSelection): void {
    this.log.push({
      draftBefore: this.draft,
      occurrencesBefore: this.occurrences,
      ...(selectionBefore !== undefined ? { selectionBefore } : {}),
    })
    if (this.log.length > LOG_LIMIT) this.log.shift()
    this.redoStack = []
  }

  /**
   * Reconcile the occurrence table with one edit (old-draft coordinates):
   * entries past the range shift by the length delta; entries whose
   * placeholder RUN intersects the replaced range go away whole (a
   * deletion/replacement touching any cell acts on the whole chip).
   */
  private reconcile(range: EditRange): void {
    const delta = range.insertedLength - (range.end - range.start)
    const kept: Occurrence[] = []
    for (const o of this.occurrences) {
      if (o.offset + o.length <= range.start) kept.push(o)
      else if (o.offset >= range.end) kept.push(delta === 0 ? o : { ...o, offset: o.offset + delta })
    }
    this.occurrences = kept
  }

  /** Claimed integrity watch: any mutation that breaks the token prefix releases the claim. */
  private watchClaim(): void {
    if (this.phase === 'claimed' && this.claim !== undefined && !this.draft.startsWith(this.claim.token)) {
      this.phase = 'plain'
      this.claim = undefined
    }
  }

  /** Mint one occurrence at a draft offset. */
  private mint(reference: ReferenceInsert, offset: number, length = 1): Occurrence {
    this.occurrenceSeq += 1
    return {
      occurrenceId: this.occurrenceSeq,
      source: reference.source,
      ref: reference.ref,
      offset,
      length,
      label: reference.label,
      ...reference.appearance === undefined ? {} : { appearance: reference.appearance },
      clipboardText: reference.clipboardText,
    }
  }

  /** Splice minted entries into the offset-sorted table. */
  private withMinted(minted: readonly Occurrence[]): void {
    if (minted.length === 0) return
    this.occurrences = [...this.occurrences, ...minted].sort((a, b) => a.offset - b.offset)
  }

  // ---- draft transactions ----

  private onDraftChanged(draft: string, editRange?: EditRange): InputEffect[] {
    if (draft === this.draft) return []
    const range = editRange ?? diffEdit(this.draft, draft)
    // Single-char typing coalesces into the open run while contiguous and
    // inside the merge window; anything else opens its own transaction.
    const typing = range.start === range.end && range.insertedLength === 1
    const at = this.now()
    const run = this.typingRun
    const merges = typing && run !== undefined && run.end === range.start && at - run.at <= this.mergeWindowMs
    if (!merges) this.pushTxn({ start: range.start, end: range.end })
    this.typingRun = typing ? { end: range.start + 1, at } : undefined
    this.reconcile(range)
    this.adopt(draft)
    this.watchClaim()
    this.paste = undefined
    return []
  }

  /** Span CAS: revision equality (content identity follows) plus bounds sanity. */
  private casOk(span: TokenSpan): boolean {
    return span.draftRev === this.draftRev
      && span.start >= 0 && span.start <= span.end && span.end <= this.draft.length
  }

  private onBeginCommand(claim: CommandClaim, span: TokenSpan): InputEffect[] {
    if (this.phase !== 'plain' && this.phase !== 'claimed') return []
    // Leading-trigger contract: only whitespace may precede the span; the
    // whitespace prefix is dropped so the claimed watch (startsWith) holds.
    if (!this.casOk(span) || this.draft.slice(0, span.start).trim() !== '') return []
    this.pushTxn()
    this.typingRun = undefined
    this.reconcile({ start: 0, end: span.end, insertedLength: claim.token.length })
    this.adopt(claim.token + this.draft.slice(span.end))
    this.claim = claim
    this.phase = 'claimed'
    this.paste = undefined
    return []
  }

  private onInsertRef(reference: ReferenceInsert, span: TokenSpan): InputEffect[] {
    if (this.phase !== 'plain' && this.phase !== 'claimed') return []
    if (!this.casOk(span)) return []
    this.replaceSpanWithChip(reference, span)
    this.paste = undefined
    return []
  }

  /**
   * Shared chip-insertion transaction: replace [span) with a placeholder run
   * sized to the label's cell estimate (insert-ref and paste-upgrade both
   * land here; the composer's post-paint measurement may grow the run later).
   * A separating space follows the chip unless one is already next.
   * @returns the inserted length (placeholder run plus optional gap).
   */
  private replaceSpanWithChip(reference: ReferenceInsert, span: TokenSpan): number {
    this.pushTxn()
    this.typingRun = undefined
    const tail = this.draft.slice(span.end)
    const gap = tail.length === 0 || tail[0] !== ' ' ? ' ' : ''
    const cells = cellsForLabel(reference.label)
    const inserted = PLACEHOLDER.repeat(cells) + gap
    this.reconcile({ start: span.start, end: span.end, insertedLength: inserted.length })
    this.withMinted([this.mint(reference, span.start, cells)])
    this.adopt(this.draft.slice(0, span.start) + inserted + tail)
    this.watchClaim()
    return inserted.length
  }

  /**
   * Grow one chip's placeholder run to `cells` cells (the composer's
   * post-paint label measurement correcting the insert-time estimate). One
   * ordinary transaction (undo returns to the estimate). Run integrity needs
   * no check here: reconcile removes any occurrence whose run an edit touched,
   * so a live occurrence always still spans its placeholder run.
   */
  private onResizeChip(occurrenceId: number, cells: number): InputEffect[] {
    if (this.phase !== 'plain' && this.phase !== 'claimed') return []
    if (cells < 1 || cells > MAX_CELLS) return []
    const index = this.occurrences.findIndex(candidate => candidate.occurrenceId === occurrenceId)
    const o = index === -1 ? undefined : this.occurrences[index]
    if (o === undefined) return []
    if (o.length === cells) return []
    this.pushTxn()
    this.typingRun = undefined
    this.occurrences = [
      ...this.occurrences.slice(0, index),
      { ...o, length: cells },
      ...this.occurrences.slice(index + 1),
    ]
    this.adopt(this.draft.slice(0, o.offset) + PLACEHOLDER.repeat(cells) + this.draft.slice(o.offset + o.length))
    this.watchClaim()
    this.paste = undefined
    return []
  }

  /**
   * Guarded token deletion after business success (popup settle / menu-pick
   * execute). No effect signals success: the caller reads the draftRev
   * advance off the published state (same currency as the other bail verbs).
   */
  private onConsumeToken(guard: ConsumeTokenGuard): InputEffect[] {
    if (this.phase !== 'plain' && this.phase !== 'claimed') return []
    switch (guard.kind) {
      case 'span': {
        const span = guard.span
        if (!this.casOk(span) || span.start === span.end) return []
        this.pushTxn()
        this.typingRun = undefined
        this.reconcile({ start: span.start, end: span.end, insertedLength: 0 })
        this.adopt(this.draft.slice(0, span.start) + this.draft.slice(span.end))
        this.watchClaim()
        this.paste = undefined
        return []
      }
      case 'bare-token': {
        if (guard.token === '' || this.draft.trim() !== guard.token) return []
        this.pushTxn()
        this.typingRun = undefined
        this.occurrences = []
        this.adopt('')
        this.watchClaim()
        this.paste = undefined
        return []
      }
      default: return unreachable(guard)
    }
  }

  /**
   * Owner-resolution style bits: exactly the listed occurrences render
   * invalid. Not a transaction — the draft, revision, and undo log are
   * untouched (invalidation never deletes or rewrites chips).
   */
  private onSetInvalid(invalidIds: readonly number[]): InputEffect[] {
    const ids = new Set(invalidIds)
    if (!this.occurrences.some(o => (o.invalid === true) !== ids.has(o.occurrenceId))) return []
    this.occurrences = this.occurrences.map((o) => {
      const invalid = ids.has(o.occurrenceId)
      if ((o.invalid === true) === invalid) return o
      const { invalid: _drop, ...rest } = o
      return invalid ? { ...rest, invalid: true } : rest
    })
    return []
  }

  // ---- undo / redo ----

  private onUndo(): InputEffect[] {
    const entry = this.log.pop()
    if (entry === undefined) return []
    this.redoStack.push({ draftBefore: this.draft, occurrencesBefore: this.occurrences })
    this.occurrences = entry.occurrencesBefore
    this.adopt(entry.draftBefore)
    this.watchClaim()
    this.typingRun = undefined
    this.paste = undefined
    return []
  }

  private onRedo(): InputEffect[] {
    const entry = this.redoStack.pop()
    if (entry === undefined) return []
    // Manual log push: pushTxn would cut the redo chain being walked.
    this.log.push({ draftBefore: this.draft, occurrencesBefore: this.occurrences })
    if (this.log.length > LOG_LIMIT) this.log.shift()
    this.occurrences = entry.occurrencesBefore
    this.adopt(entry.draftBefore)
    this.watchClaim()
    this.typingRun = undefined
    this.paste = undefined
    return []
  }

  // ---- paste plane ----

  /**
   * Paste as one transaction: the text (reference-placeholder-sanitized) replaces the
   * selection; hot-snapshot sync matches componentize inside the SAME
   * transaction (one undo returns to pre-paste); a match attempt opens for
   * the async remainder while the phase still accepts reference mutations.
   */
  private onPasteBegin(
    rawText: string, selection: EditSelection,
    components: readonly PasteComponent[] = [], generation = 0,
  ): InputEffect[] {
    const { start, end } = selection
    if (start < 0 || start > end || end > this.draft.length) return []
    const text = rawText.replace(REFERENCE_PLACEHOLDER_RE, '')
    this.pushTxn(selection)
    this.typingRun = undefined
    // Componentize: replace each matched token range (paste-text coordinates,
    // disjoint by contract) with a label-sized placeholder run while
    // assembling the insert.
    const sorted = [...components].sort((a, b) => a.start - b.start)
    const minted: Occurrence[] = []
    let inserted = ''
    let cursor = 0
    for (const c of sorted) {
      inserted += text.slice(cursor, c.start)
      const cells = cellsForLabel(c.reference.label)
      minted.push(this.mint(c.reference, start + inserted.length, cells))
      inserted += PLACEHOLDER.repeat(cells)
      cursor = c.end
    }
    inserted += text.slice(cursor)
    this.reconcile({ start, end, insertedLength: inserted.length })
    this.withMinted(minted)
    this.adopt(this.draft.slice(0, start) + inserted + this.draft.slice(end))
    this.watchClaim()
    if (this.phase === 'plain' || this.phase === 'claimed') {
      this.pasteSeq += 1
      this.paste = {
        attemptId: this.pasteSeq,
        insertedRange: { start, end: start + inserted.length },
        generation,
      }
    } else {
      this.paste = undefined
    }
    return []
  }

  /**
   * Async match landed: upgrade one pasted token to a chip as an INDEPENDENT
   * transaction (undo #1 → the token text, undo #2 → pre-paste). The attempt
   * stays current — later tokens re-CAS against the advanced draftRev.
   */
  private onPasteUpgrade(attemptId: number, span: TokenSpan, reference: ReferenceInsert): InputEffect[] {
    const attempt = this.paste
    if (attempt === undefined || attempt.attemptId !== attemptId) return []
    if (this.phase !== 'plain' && this.phase !== 'claimed') return []
    if (!this.casOk(span) || span.start === span.end) return []
    const insertedLength = this.replaceSpanWithChip(reference, span)
    this.paste = {
      ...attempt,
      insertedRange: { start: attempt.insertedRange.start, end: attempt.insertedRange.end + insertedLength - (span.end - span.start) },
    }
    return []
  }

  // ---- submit plane ----

  /** Mint the next SubmitAttempt and take the in-flight slot. */
  private beginAttempt(mode: InputSubmitMode): SubmitAttempt {
    const controller = new AbortController()
    this.seq += 1
    const attempt: SubmitAttempt = { seq: this.seq, signal: controller.signal, draftSnapshot: this.draft, mode }
    this.inflight = { attempt, controller }
    return attempt
  }

  private onEnter(mode: InputSubmitMode): InputEffect[] {
    if (this.phase === 'adjudicating' || this.phase === 'submitting') return []
    if (this.phase === 'claimed' && this.claim !== undefined) {
      const attempt = this.beginAttempt(mode)
      this.phase = 'submitting'
      this.paste = undefined
      return [{ type: 'begin-submit', attempt, claim: this.claim, args: argsAfter(this.draft, this.claim.token) }]
    }
    const trimmed = this.draft.trim()
    if (trimmed === '') return []
    this.paste = undefined
    if (trimmed.startsWith('/')) {
      const attempt = this.beginAttempt(mode)
      this.phase = 'adjudicating'
      return [{ type: 'adjudicate', attempt, draft: this.draft }]
    }
    const attempt = this.beginAttempt(mode)
    this.phase = 'submitting'
    return [{ type: 'default-sink', attempt, draft: this.draft, mode }]
  }

  private onAdjudicated(attempt: SubmitAttempt, outcome: Extract<InputEvent, { type: 'adjudicated' }>['outcome']): InputEffect[] {
    const flight = this.inflight
    if (this.phase !== 'adjudicating' || flight === undefined || flight.attempt.seq !== attempt.seq) return []
    if (outcome !== undefined && outcome !== 'handled' && 'claim' in outcome) {
      this.claim = outcome.claim
      this.phase = 'submitting'
      return [{
        type: 'begin-submit',
        attempt,
        claim: outcome.claim,
        args: argsAfter(attempt.draftSnapshot, outcome.claim.token),
      }]
    }
    // 'handled' (source dealt internally), {insert} (no enter-time span
    // semantics), or a miss: all land plain; only the miss flows to the sink.
    if (outcome === undefined) {
      this.phase = 'submitting'
      return [{
        type: 'default-sink',
        attempt,
        draft: attempt.draftSnapshot,
        mode: attempt.mode,
      }]
    }
    this.inflight = undefined
    this.phase = 'plain'
    return []
  }

  private onAdjudicationFailed(attempt: SubmitAttempt, message: string): InputEffect[] {
    if (this.phase !== 'adjudicating' || this.inflight?.attempt.seq !== attempt.seq) return []
    this.inflight = undefined
    this.phase = 'plain'
    // Draft retained: warmup failure never silently downgrades to a prompt.
    return [{ type: 'notice', level: 'error', text: message }]
  }

  private onSubmitSettled(ev: Extract<InputEvent, { type: 'submit-settled' }>): InputEffect[] {
    const flight = this.inflight
    if (this.phase !== 'submitting' || flight === undefined || flight.attempt.seq !== ev.attempt.seq) return []
    this.inflight = undefined
    if (ev.ok) {
      this.phase = 'plain'
      this.claim = undefined
      this.occurrences = []
      // Text appended after the sent snapshot during the Host round-trip
      // survives the commit; edits interleaved with committed content cannot
      // be separated from it, so only a pure suffix is retained.
      const snapshot = flight.attempt.draftSnapshot
      this.adopt(this.draft !== snapshot && this.draft.startsWith(snapshot)
        ? this.draft.slice(snapshot.length)
        : '')
      // Committed content is gone for good: undo must not resurrect a sent draft.
      this.log = []
      this.redoStack = []
      this.typingRun = undefined
      this.paste = undefined
      return ev.outcome?.text !== undefined
        ? [{ type: 'notice', level: ev.outcome.kind === 'error' ? 'error' : 'info', text: ev.outcome.text }]
        : []
    }
    const text = ev.message ?? ev.outcome?.text
    // Keep the same command claim only while the live draft still equals the
    // enter-time draft; user input typed during flight wins.
    // Claimed re-entry additionally requires the watch to hold — an
    // enter-path snapshot may carry leading whitespace the token never had.
    if (this.draft === flight.attempt.draftSnapshot
      && this.claim !== undefined && this.draft.startsWith(this.claim.token)) {
      this.phase = 'claimed'
      return text === undefined ? [] : [{ type: 'notice', level: 'error', text }]
    }
    this.phase = 'plain'
    this.claim = undefined
    return text === undefined ? [] : [{ type: 'notice', level: 'error', text }]
  }

  /** Cut undo state after an accepted image-only send. */
  private onSendCommitted(): InputEffect[] {
    if (this.phase !== 'plain') return []
    this.claim = undefined
    this.occurrences = []
    this.adopt('')
    this.log = []
    this.redoStack = []
    this.typingRun = undefined
    this.paste = undefined
    return []
  }

  private onRelease(): InputEffect[] {
    if (this.inflight !== undefined) {
      this.inflight.controller.abort()
      this.inflight = undefined
    }
    this.phase = 'plain'
    this.claim = undefined
    this.typingRun = undefined
    this.paste = undefined
    return []
  }
}
