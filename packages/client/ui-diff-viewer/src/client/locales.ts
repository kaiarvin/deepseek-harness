/** `diff-viewer` namespace dictionaries for the expanded diff tool cards. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'diff-viewer'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'row.running': '正在应用修改',
  'row.failed': '修改失败',
  'row.stopped': '修改已中止',
  'row.expand': '展开',
  'row.collapse': '收起',
  'row.empty': '暂无 diff',
  'row.inspect': '查看详情',
} satisfies Record<string, string>

/** The diff-viewer namespace key union. */
export type DiffViewerKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'row.running': 'Applying change',
  'row.failed': 'Change failed',
  'row.stopped': 'Change stopped',
  'row.expand': 'Expand',
  'row.collapse': 'Collapse',
  'row.empty': 'No diff',
  'row.inspect': 'Inspect',
} satisfies Record<DiffViewerKey, string>
