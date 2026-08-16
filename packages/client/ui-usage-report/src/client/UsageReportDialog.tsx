/**
 * Sidebar-foot usage entry and its report dialog: the icon sits beside the
 * settings trigger (`sidebar.footer.action`) and opens a modal folding the
 * host's cross-session `usage.report` into a model-share donut (for the
 * selected day) and a daily calendar heatmap. The dialog is a local read: it
 * fetches once on open, owns its own load/error states, and renders nothing
 * until the report arrives. Clicking a calendar cell selects that day's
 * donut; hovering a cell shows its exact figures.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import { IconCloseOutline16, IconDataOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { UsageKey } from './locales.ts'
import css from './UsageReport.module.css'

/** The host's usage.report success value, derived from the wire contract. */
type UsageReport = Extract<Awaited<ReturnType<IApiClient['usage']['report']>>['result'], { ok: true }>['value']
/** One local-day bucket. */
type UsageDay = UsageReport['days'][number]
/** One model's totals inside a day bucket. */
type UsageModelTotals = UsageDay['models'][number]
/** Disjoint billed token buckets. */
type TokenTotals = UsageDay['tokens']

/** The sidebar-foot entry's composed props: column state + locale + injected API face. */
export type UsageReportEntryProps =
  PropsRuntime<'sidebar.footer.action'> & PropsLocale<'usage'> & { api: IApiClient }

/** Load state of the one-shot report read. */
type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; report: UsageReport }
  | { status: 'error' }

/** Donut geometry: radius 42 in a 100-unit viewBox with a 16-unit stroke. */
const DONUT_RADIUS = 42
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS

/** Fixed model palette; a model beyond the palette cycles back to the first color. */
const MODEL_COLORS = ['#5b7cf8', '#22b8cf', '#51cf66', '#fcc419', '#ff6b6b', '#cc5de8', '#ff922b', '#20c997'] as const

/** Heatmap cell fill for one day: brand blue scaled by share of the busiest day. */
function cellColor(share: number): string {
  const alpha = 0.12 + 0.88 * Math.max(0, Math.min(1, share))
  return `rgba(91, 124, 248, ${alpha.toFixed(3)})`
}

/** Compact token count: 517 / 12.2K / 517K / 1.2M (one decimal under three digits). */
function formatTokens(n: number): string {
  const scaled = (v: number): string => v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** Billed total of one token bucket (disjoint input buckets plus output). */
function billedTotal(tokens: TokenTotals): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output
}

/** The model color for one palette index; the non-empty palette guarantees a value. */
function modelColor(index: number): string {
  return MODEL_COLORS[index % MODEL_COLORS.length] ?? MODEL_COLORS[0]
}

/**
 * The model-share donut for one day, with a legend. Each segment is an SVG
 * circle arc; hovering a segment or legend row shows the model's exact
 * figures through the native title tooltip.
 */
function DonutChart({ models, dayStartMs, t }: {
  models: UsageModelTotals[]
  dayStartMs: number
  t: (key: UsageKey) => string
}) {
  const total = models.reduce((sum, model) => sum + billedTotal(model.tokens), 0)
  let offset = 0
  return (
    <div className={css.donutLayout}>
      <svg className={css.donut} viewBox="0 0 100 100" width="120" height="120" role="img" aria-label={t('share.title')}>
        {models.map((model, index) => {
          const length = total === 0 ? 0 : billedTotal(model.tokens) / total * DONUT_CIRCUMFERENCE
          const segment = (
            <circle
              key={`${model.provider}:${model.model}`}
              cx="50"
              cy="50"
              r={DONUT_RADIUS}
              fill="none"
              stroke={modelColor(index)}
              strokeWidth="16"
              strokeDasharray={`${Math.max(0, length - 2)} ${DONUT_CIRCUMFERENCE}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 50 50)"
              className={css.donutSegment}
            >
              <title>
                {`${model.model} · ${formatTokens(billedTotal(model.tokens))} · ${total === 0 ? 0 : Math.round(billedTotal(model.tokens) / total * 100)}%`}
              </title>
            </circle>
          )
          offset += length
          return segment
        })}
        {total === 0 && (
          <circle cx="50" cy="50" r={DONUT_RADIUS} fill="none" stroke="var(--dsw-alias-border-l2)" strokeWidth="16" />
        )}
      </svg>
      <div className={css.donutLegend}>
        <div className={css.donutDay}>
          {new Date(dayStartMs).toLocaleDateString()} · {formatTokens(total)}
        </div>
        {models.map((model, index) => {
          const share = total === 0 ? 0 : billedTotal(model.tokens) / total * 100
          return (
            <div key={`${model.provider}:${model.model}`} className={css.legendRow}>
              <span className={css.legendSwatch} style={{ background: modelColor(index) }} />
              <span className={css.legendName} title={`${model.provider}: ${model.model}`}>{model.model}</span>
              <span className={css.legendValue}>
                {formatTokens(billedTotal(model.tokens))} · {Math.round(share)}%
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** One heatmap cell: a day square whose fill depth tracks its usage share. */
function CalendarCell({ dayStartMs, total, maxTotal, selected, onSelect, t }: {
  dayStartMs: number
  total: number
  maxTotal: number
  selected: boolean
  onSelect: (dayStartMs: number) => void
  t: (key: UsageKey) => string
}) {
  const label = `${new Date(dayStartMs).toLocaleDateString()} · ${
    total === 0 ? t('calendar.noUsage') : formatTokens(total)
  }`
  return (
    <button
      type="button"
      className={clsx(css.calendarCell, selected && css.calendarCellSelected)}
      style={{ background: total === 0 ? 'var(--dsw-alias-bg-layer-1)' : cellColor(total / maxTotal) }}
      aria-label={label}
      aria-pressed={selected}
      onClick={() => { onSelect(dayStartMs) }}
      title={label}
    />
  )
}

/** One weekday label (Monday-first), localized narrow form. */
const WEEKDAY_LABELS = Array.from({ length: 7 }, (_, index) =>
  new Date(2026, 0, 5 + index).toLocaleDateString(undefined, { weekday: 'narrow' }))

/** Local month identity (year * 12 + month) for one day's zero hour. */
function monthKeyOf(dayStartMs: number): number {
  const date = new Date(dayStartMs)
  return date.getFullYear() * 12 + date.getMonth()
}

/** One calendar month block: a complete 7-column grid of the month's days. */
function MonthBlock({ year, month, byDay, maxTotal, selected, onSelect, t }: {
  year: number
  month: number
  byDay: Map<number, number>
  maxTotal: number
  selected: number
  onSelect: (dayStartMs: number) => void
  t: (key: UsageKey) => string
}) {
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const lead = (new Date(year, month, 1).getDay() + 6) % 7 // Monday-first
  const rows = Math.ceil((lead + daysInMonth) / 7)
  const title = new Date(year, month, 15).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
  return (
    <div className={css.calendarMonth}>
      <div className={css.calendarMonthTitle}>{title}</div>
      <div className={css.calendar} role="grid" aria-label={title}>
        <div className={css.calendarRow} role="row">
          {WEEKDAY_LABELS.map((label, index) => (
            <span key={index} className={css.calendarWeekday}>{label}</span>
          ))}
        </div>
        {Array.from({ length: rows }, (_, row) => (
          <div key={row} className={css.calendarRow} role="row">
            {Array.from({ length: 7 }, (_, col) => {
              const dayNumber = row * 7 + col - lead + 1
              if (dayNumber < 1 || dayNumber > daysInMonth) {
                return <span key={col} className={css.calendarCellEmpty} aria-hidden="true" />
              }
              const dayStartMs = new Date(year, month, dayNumber).getTime()
              const total = byDay.get(dayStartMs) ?? 0
              return (
                <CalendarCell
                  key={col}
                  dayStartMs={dayStartMs}
                  total={total}
                  maxTotal={maxTotal}
                  selected={selected === dayStartMs}
                  onSelect={onSelect}
                  t={t}
                />
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * The daily heatmap: one complete calendar month per block, from the earliest
 * month with usage through the current month. Months with no usage at all are
 * skipped so the grid stays dense; within a month every day renders, empty
 * days as a neutral square.
 */
function UsageCalendar({ days, dayTotals, selected, onSelect, t }: {
  days: UsageDay[]
  dayTotals: Map<UsageDay, number>
  selected: number
  onSelect: (dayStartMs: number) => void
  t: (key: UsageKey) => string
}) {
  const byDay = new Map(days.map(day => [day.dayStartMs, dayTotals.get(day) ?? 0] as const))
  if (byDay.size === 0) return null
  const maxTotal = Math.max(1, ...byDay.values())
  const months = new Set<number>()
  for (const day of days) months.add(monthKeyOf(day.dayStartMs))
  const today = new Date()
  months.add(today.getFullYear() * 12 + today.getMonth())
  const blocks = [...months].sort((a, b) => a - b)
  return (
    <div className={css.calendarMonths}>
      {blocks.map(key => (
        <MonthBlock
          key={key}
          year={Math.floor(key / 12)}
          month={key % 12}
          byDay={byDay}
          maxTotal={maxTotal}
          selected={selected}
          onSelect={onSelect}
          t={t}
        />
      ))}
    </div>
  )
}

/**
 * The report dialog: centered modal over a full-viewport mask, closed by the
 * header button, a mask click, or Escape. Fetches the report once on mount.
 * @param props - locale seat, API face, close callback.
 * @returns the dialog element tree.
 */
export function UsageReportDialog({ t, api, onClose }: { t: (key: UsageKey) => string; api: IApiClient; onClose: () => void }) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const titleId = useId()

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    api.usage.report({ timezoneOffsetMinutes: new Date().getTimezoneOffset() })
      .then(({ result }) => {
        if (cancelled) return
        setState(result.ok ? { status: 'ready', report: result.value } : { status: 'error' })
      })
      .catch(() => { if (!cancelled) setState({ status: 'error' }) })
    return () => { cancelled = true }
  }, [api])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  const closeButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { closeButton.current?.focus() }, [])

  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div className={css.panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className={css.header}>
          <span className={css.title} id={titleId}>{t('dialog.title')}</span>
          <button ref={closeButton} type="button" className={css.close} aria-label={t('dialog.close')} onClick={onClose}>
            <IconCloseOutline16 size={14} />
          </button>
        </header>
        {state.status === 'loading' && <div className={css.status}>{t('state.loading')}</div>}
        {state.status === 'error' && <div className={css.status}>{t('state.error')}</div>}
        {state.status === 'ready' && <ReportBody report={state.report} t={t} />}
      </div>
    </div>
  )
}

/** The ready-state body: summary, selected-day model-share donut, and the daily heatmap. */
function ReportBody({ report, t }: { report: UsageReport; t: (key: UsageKey) => string }) {
  const days = [...report.days].sort((a, b) => a.dayStartMs - b.dayStartMs)
  const dayTotals = new Map(days.map(day => [day, billedTotal(day.tokens)] as const))
  const shares = days.reduce((byModel, day) => {
    for (const model of day.models) {
      const key = `${model.provider}\u0000${model.model}`
      const existing = byModel.get(key)
      if (existing === undefined) byModel.set(key, { ...model, tokens: { ...model.tokens } })
      else {
        existing.calls += model.calls
        existing.sessions += model.sessions
        existing.tokens.input += model.tokens.input
        existing.tokens.output += model.tokens.output
        existing.tokens.cacheRead += model.tokens.cacheRead
        existing.tokens.cacheWrite += model.tokens.cacheWrite
      }
    }
    return byModel
  }, new Map<string, UsageModelTotals>())
  const shareList = [...shares.values()].sort((a, b) => billedTotal(b.tokens) - billedTotal(a.tokens))
  const grandTotal = shareList.reduce((sum, model) => sum + billedTotal(model.tokens), 0)
  const sessionCount = report.days.reduce((sum, day) => sum + day.sessions, 0)
  // The donut follows the selected calendar day; the default is the most recent day with usage.
  const [selected, setSelected] = useState<number>(() => days.at(-1)?.dayStartMs ?? 0)
  const selectedDay = days.find(day => day.dayStartMs === selected)
  const selectedModels = selectedDay?.models ?? []

  if (report.days.length === 0) return <div className={css.status}>{t('state.empty')}</div>

  return (
    <div className={css.body}>
      <div className={css.summary}>
        <span className={css.summaryItem}>{t('summary.total')} <strong>{formatTokens(grandTotal)}</strong></span>
        <span className={css.summaryItem}>{t('summary.days')} <strong>{report.days.length}</strong></span>
        <span className={css.summaryItem}>{t('summary.sessions')} <strong>{sessionCount}</strong></span>
      </div>
      <section className={css.share}>
        <h2 className={css.sectionTitle}>{t('share.title')}</h2>
        <DonutChart
          models={selectedModels}
          dayStartMs={selected}
          t={t}
        />
      </section>
      <section className={css.calendarSection}>
        <h2 className={css.sectionTitle}>{t('calendar.title')}</h2>
        <UsageCalendar
          days={days}
          dayTotals={dayTotals}
          selected={selected}
          onSelect={setSelected}
          t={t}
        />
      </section>
    </div>
  )
}

/**
 * The sidebar-foot entry: one icon button beside Settings opening the report
 * dialog, plus the dialog while open. Rail and wide columns share the icon.
 * @param props - composed slot props (column state, locale, API face).
 * @returns the entry element tree.
 */
export function UsageReportEntry({ wide, t, api }: UsageReportEntryProps) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => { setOpen(false) }, [])
  return (
    <>
      <Tooltip label={t('trigger.aria')} delayMs={500}>
        <button
          type="button"
          className={clsx(css.trigger, !wide && css.rail)}
          aria-label={t('trigger.aria')}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(true) }}
        >
          <IconDataOutline16 size={wide ? 16 : 18} />
        </button>
      </Tooltip>
      {open && <UsageReportDialog t={t} api={api} onClose={close} />}
    </>
  )
}
