/**
 * ThinkingSelect: the composer's quick thinking-level dropdown, sitting right
 * next to the model chip. It offers the three DeepSeek thinking levels — off /
 * high / max — under fixed, localized labels (关闭 / 高 / 最高), so the
 * thinking strength is one click away. The model chip itself only lists
 * models; this control is the reasoning effort surface.
 *
 * It is a model selection like the model chip itself: picking a level submits
 * `session.selectModel` with that reasoningEffort through the same shared
 * per-session directory, so the Host persists it with the model choice and
 * every subsequent request carries it (the agent loop folds the persisted
 * selection into each LLM call). The control renders only while the current
 * model actually offers at least one of the three levels; a non-reasoning
 * model or one with a different effort vocabulary stays clean.
 */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { IconCheckOutline16, IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ModelSelect.module.css'

/** The fixed thinking levels in DeepSeek escalation order. */
const THINKING_LEVELS = [
  { id: 'off', labelKey: 'thinking.off' },
  { id: 'high', labelKey: 'thinking.high' },
  { id: 'max', labelKey: 'thinking.max' },
] as const

/**
 * Render the composer's quick thinking-level dropdown.
 * @param props.locked - composer state that locks the model seat (no session, removed).
 * @param props.current - the session's current model selection; null hides the control.
 * @param props.reasoning - the current model's reasoning metadata; undefined hides the control.
 * @param props.effectiveEffort - the effective effort (selection ?? adapter default).
 * @param props.select - submits a full model selection through the shared directory.
 * @param props.onRejected - surfaces a rejected selection on the seat's transient toast.
 * @param props.t - the `model` locale seat.
 * @returns the trigger and, while open, the three-level menu, or null when the current model offers none of the levels.
 */
export function ThinkingSelect(
  { locked, current, reasoning, effectiveEffort, select, onRejected, t }:
  {
    locked: boolean
    current: ModelSelection | null
    reasoning: { efforts: readonly ModelReasoningEffort[]; defaultEffort?: string } | undefined
    effectiveEffort: string | undefined
    select: (selection: ModelSelection) => Promise<boolean>
    onRejected: () => void
    t: PropsLocale<'model'>['t']
  },
) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()

  // Only levels the current model actually offers, always in fixed order.
  const offered = useMemo(() => reasoning === undefined
    ? []
    : THINKING_LEVELS.filter(level => reasoning.efforts.some(effort => effort.id === level.id)),
  [reasoning])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  if (current === null || reasoning === undefined || offered.length === 0) return null
  // Narrowed for type flow: the guard above proves the cluster is non-empty.
  const firstOffered = offered[0]
  if (firstOffered === undefined) return null

  const active = offered.find(level => level.id === effectiveEffort) ?? firstOffered
  const label = t(active.labelKey)

  const close = (restoreFocus = false): void => {
    setOpen(false)
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const currentFocus = items.findIndex(item => item === document.activeElement)
    const next = (Math.max(currentFocus, 0) + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
      return
    }
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const choose = (levelId: string): void => {
    if (effectiveEffort === levelId) {
      close(true)
      return
    }
    void select({ provider: current.provider, model: current.model, reasoningEffort: levelId })
      .then((accepted) => {
        if (accepted) close(true)
        else onRejected()
      })
  }

  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  return (
    <div ref={rootRef} className={css.thinking} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={t('thinking.aria', { level: label })}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={label}
        disabled={locked}
        onClick={() => { setOpen(prev => !prev) }}
      >
        <span className={css.triggerLabel}>{label}</span>
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>
      {open && (
        <div
          id={`${id}-menu`}
          className={css.menu}
          role="menu"
          aria-label={t('thinking.menu')}
        >
          {offered.map(level => (
            <button
              ref={itemRef()}
              type="button"
              role="menuitemradio"
              aria-checked={effectiveEffort === level.id}
              className={clsx(css.option, effectiveEffort === level.id && css.selected)}
              key={level.id}
              onClick={() => { choose(level.id) }}
            >
              <span className={css.optionCopy}>
                <span className={css.modelName}>{t(level.labelKey)}</span>
              </span>
              <span className={css.check}>
                {effectiveEffort === level.id ? <IconCheckOutline16 /> : null}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
