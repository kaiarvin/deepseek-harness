// @vitest-environment jsdom
// Usage report surface: the sidebar-foot entry icon and the dialog's
// load/empty/ready/error states plus the donut + heatmap interaction,
// driven through props with a stubbed API face.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
// Package entry: pulls the `usage` LocaleNamespaceMap augmentation into the test program.
import { UsageReportDialog, UsageReportEntry } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'

// The framework-injected t seat, stubbed over the zh dictionaries (the default locale).
const t = makeTranslate(zh, commonZh)

const DAY_MS = 86_400_000

/** The zero hour (UTC epoch ms) of the local day `daysAgo` days before today. */
function dayStart(daysAgo: number, timezoneOffsetMinutes = -480): number {
  const now = Date.now()
  const shifted = now - timezoneOffsetMinutes * 60_000
  const todayStart = Math.floor(shifted / DAY_MS) * DAY_MS + timezoneOffsetMinutes * 60_000
  return todayStart - daysAgo * DAY_MS
}

/** One day bucket: a recent local day (UTC+8) with one model. */
function dayBucket(over: {
  daysAgo?: number
  model?: string
  input?: number
  output?: number
  cacheRead?: number
} = {}) {
  const input = over.input ?? 150
  const output = over.output ?? 30
  const cacheRead = over.cacheRead ?? 5
  return {
    dayStartMs: dayStart(over.daysAgo ?? 1),
    sessions: 1,
    tokens: { input, output, cacheRead, cacheWrite: 0 },
    models: [
      {
        provider: 'mock',
        model: over.model ?? 'alpha',
        tokens: { input, output, cacheRead, cacheWrite: 0 },
        calls: 2,
        sessions: 1,
      },
    ],
  }
}

function okApi(report: unknown): { api: IApiClient; reportMock: ReturnType<typeof vi.fn> } {
  const reportMock = vi.fn(() => Promise.resolve({ rpcId: 'r', result: { ok: true, value: report } }))
  const api = { usage: { report: reportMock } } as unknown as IApiClient
  return { api, reportMock }
}

afterEach(cleanup)

describe('UsageReportEntry', () => {
  it('renders the trigger icon and opens the dialog on click', () => {
    const { api } = okApi({ timezoneOffsetMinutes: -480, days: [] })
    // The global object-layer seat is only a type here; the entry never reads it.
    const unusedHook = (() => undefined) as never
    render(<UsageReportEntry wide useSessions={unusedHook} useWorkspaces={unusedHook} t={t} api={api} />)
    const trigger = screen.getByRole('button', { name: 'Token 用量统计' })
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Token 用量统计' })).toBeTruthy()
  })
})

describe('UsageReportDialog', () => {
  it('shows the loading seat while the report is in flight', () => {
    const reportMock = vi.fn(() => new Promise(() => {}))
    const api = { usage: { report: reportMock } } as unknown as IApiClient
    render(<UsageReportDialog t={t} api={api} onClose={() => {}} />)
    expect(screen.getByText('统计加载中…')).toBeTruthy()
  })

  it('shows the empty seat for a report without days', async () => {
    const { api } = okApi({ timezoneOffsetMinutes: -480, days: [] })
    render(<UsageReportDialog t={t} api={api} onClose={() => {}} />)
    expect(await screen.findByText('还没有记录到 token 用量。')).toBeTruthy()
  })

  it('renders summary, the model-share donut legend, and calendar cells for a populated report', async () => {
    const { api, reportMock } = okApi({ timezoneOffsetMinutes: -480, days: [dayBucket()] })
    render(<UsageReportDialog t={t} api={api} onClose={() => {}} />)
    expect(await screen.findByText('模型占比')).toBeTruthy()
    expect(screen.getAllByText('alpha').length).toBeGreaterThan(0)
    expect(reportMock).toHaveBeenCalledWith({ timezoneOffsetMinutes: expect.any(Number) as number })
    // Day totals: 150+5+30 = 185 billed tokens → "185".
    expect(screen.getAllByText('185').length).toBeGreaterThan(0)
    // The daily heatmap renders one complete month grid (with its month title).
    expect(screen.getAllByRole('grid').length).toBeGreaterThan(0)
    const cells = screen.getAllByRole('button', { pressed: false })
    expect(cells.length).toBeGreaterThan(0)
  })

  it('shows exact figures on hover and switches the donut when a day is selected', async () => {
    const { api } = okApi({
      timezoneOffsetMinutes: -480,
      days: [
        dayBucket({ daysAgo: 1 }),
        dayBucket({
          daysAgo: 0,
          model: 'beta',
          input: 60,
          output: 10,
          cacheRead: 0,
        }),
      ],
    })
    render(<UsageReportDialog t={t} api={api} onClose={() => {}} />)
    await screen.findByText('模型占比')

    // The most recent day (today, beta) is selected by default.
    expect(screen.getAllByText('beta').length).toBeGreaterThan(0)
    // Hover figures ride the native title: day date + exact token count (150+5+30 = 185).
    const cells = screen.getAllByRole('button', { pressed: false })
    const cell = cells.find(candidate => (candidate.getAttribute('title') ?? '').includes('185'))
    expect(cell).toBeTruthy()
    fireEvent.click(cell!)
    // After switching to yesterday, the donut legend now shows alpha with its 185 tokens.
    expect(screen.getAllByText('alpha').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/185/).length).toBeGreaterThan(0)
  })

  it('defaults to the 30-day range and counts only days inside it', async () => {
    const { api } = okApi({
      timezoneOffsetMinutes: -480,
      days: [
        dayBucket({ daysAgo: 0, model: 'today', input: 150 }),
        dayBucket({ daysAgo: 10, model: 'ten-days', input: 100 }),
        dayBucket({ daysAgo: 40, model: 'forty-days', input: 50 }),
      ],
    })
    render(<UsageReportDialog t={t} api={api} onClose={() => {}} />)
    await screen.findByText('模型占比')
    // The default range is 30 days: today (185) + 10 days ago (135) count;
    // 40 days ago (85) is outside the window and never appears.
    expect(screen.queryByText('forty-days')).toBeNull()
    expect(screen.getByText('Token 总量').parentElement!.textContent).toContain('320')
    expect(screen.getByText('天数').parentElement!.textContent).toContain('2')
    // Selecting the 10-days-ago calendar cell brings its model into the legend.
    const ten = screen.getAllByRole('button', { pressed: false })
      .find(candidate => (candidate.getAttribute('title') ?? '').includes('135'))
    expect(ten).toBeTruthy()
    fireEvent.click(ten!)
    expect(screen.getByText('ten-days')).toBeTruthy()
  })

  it('narrows the window to 7 days when that option is selected', async () => {
    const { api } = okApi({
      timezoneOffsetMinutes: -480,
      days: [
        dayBucket({ daysAgo: 0, model: 'today', input: 150 }),
        dayBucket({ daysAgo: 10, model: 'ten-days', input: 100 }),
        dayBucket({ daysAgo: 40, model: 'forty-days', input: 50 }),
      ],
    })
    render(<UsageReportDialog t={t} api={api} onClose={() => {}} />)
    await screen.findByText('模型占比')
    fireEvent.click(screen.getByRole('button', { name: '最近7天' }))
    // Both 40- and 10-days-ago fall outside the 7-day window; only today counts.
    expect(screen.getByText('Token 总量').parentElement!.textContent).toContain('185')
    expect(screen.getByText('天数').parentElement!.textContent).toContain('1')
    // No calendar cell for the 10-days-ago day (its 135-token title is gone).
    expect(screen.getAllByRole('button', { pressed: false })
      .some(candidate => (candidate.getAttribute('title') ?? '').includes('135'))).toBe(false)
  })

  it('shows the empty seat when the window filters every day out', async () => {
    const { api } = okApi({
      timezoneOffsetMinutes: -480,
      days: [dayBucket({ daysAgo: 40, model: 'forty-days' })],
    })
    render(<UsageReportDialog t={t} api={api} onClose={() => {}} />)
    // The default 30-day range keeps nothing; the empty seat replaces the body.
    expect(await screen.findByText('还没有记录到 token 用量。')).toBeTruthy()
  })

  it('shows the error seat when the host rejects the report', async () => {
    const reportMock = vi.fn(() => Promise.resolve({
      rpcId: 'r',
      result: { ok: false, error: { code: 'internal', message: 'boom', details: {} } },
    }))
    const api = { usage: { report: reportMock } } as unknown as IApiClient
    render(<UsageReportDialog t={t} api={api} onClose={() => {}} />)
    expect(await screen.findByText('加载用量统计失败。')).toBeTruthy()
  })

  it('closes on the close button and on Escape', async () => {
    const { api } = okApi({ timezoneOffsetMinutes: -480, days: [dayBucket()] })
    const onClose = vi.fn()

    render(<UsageReportDialog t={t} api={api} onClose={onClose} />)
    await screen.findByText('模型占比')
    fireEvent.click(screen.getByRole('button', { name: '关闭统计' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    cleanup()

    render(<UsageReportDialog t={t} api={api} onClose={onClose} />)
    await screen.findByText('模型占比')
    fireEvent.keyDown(document, { key: 'Escape' })
    await act(async () => {})
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
