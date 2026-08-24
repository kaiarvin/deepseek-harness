/**
 * ui-diff-viewer browser half: keyed toolview registration under both
 * mutation tool names + locale dictionaries + fiber-teardown removal (HMR
 * safety), against the real SlotRegistry.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import { DiffViewerRow } from '../src/client/DiffViewerRow.tsx'

interface PresentationCapture {
  slots: SlotRegistry
  dictionaries: Array<{ namespace: string; dictionaries: unknown }>
  localeDisposed: boolean
}

/** Provide the presentation registries and capture the plugin's registrations. */
function providePresentation(ctx: Context): PresentationCapture {
  const slots = new SlotRegistry(ctx)
  slots.register({
    name: 'root',
    children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } },
  } as never, () => null)
  const capture: PresentationCapture = {
    slots,
    dictionaries: [],
    localeDisposed: false,
  }
  ctx.provide('locale', {
    register(namespace: string, dictionaries: unknown) {
      capture.dictionaries.push({ namespace, dictionaries })
      return () => { capture.localeDisposed = true }
    },
  })
  return capture
}

describe('ui-diff-viewer apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('node-half apply tolerates a Host without services', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('registers both mutation rows and the locale dictionaries', async () => {
    const ctx = new Context()
    const presentation = providePresentation(ctx)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entries = presentation.slots.entries('tool.call.toolview')
    expect(entries.map(e => e.options.key).sort()).toEqual(['edit', 'write'])
    // The rows shadow the shipped file-mutation rows via a lower priority.
    expect(entries.every(e => e.options.priority === -1)).toBe(true)
    expect(entries.every(e => e.component === DiffViewerRow)).toBe(true)
    expect(entries.every(e => e.locale === 'diff-viewer')).toBe(true)
    expect(presentation.dictionaries).toEqual([{
      namespace: 'diff-viewer',
      dictionaries: {
        zh: {
          'row.running': '正在应用修改',
          'row.failed': '修改失败',
          'row.stopped': '修改已中止',
          'row.expand': '展开',
          'row.collapse': '收起',
          'row.empty': '暂无 diff',
          'row.inspect': '查看详情',
        },
        en: {
          'row.running': 'Applying change',
          'row.failed': 'Change failed',
          'row.stopped': 'Change stopped',
          'row.expand': 'Expand',
          'row.collapse': 'Collapse',
          'row.empty': 'No diff',
          'row.inspect': 'Inspect',
        },
      },
    }])
  })

  it('fiber teardown releases both keys and the dictionaries (HMR safety)', async () => {
    const ctx = new Context()
    const presentation = providePresentation(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(presentation.slots.entries('tool.call.toolview')).toHaveLength(2)
    await fiber.dispose()
    expect(presentation.slots.entries('tool.call.toolview')).toHaveLength(0)
    expect(presentation.localeDisposed).toBe(true)
  })
})
