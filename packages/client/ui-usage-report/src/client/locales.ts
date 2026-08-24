/** `usage` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger.aria': 'Token 用量统计',
  'dialog.title': 'Token 用量统计',
  'dialog.close': '关闭统计',
  'state.loading': '统计加载中…',
  'state.empty': '还没有记录到 token 用量。',
  'state.error': '加载用量统计失败。',
  'summary.days': '天数',
  'summary.sessions': '会话数',
  'summary.total': 'Token 总量',
  'range.title': '统计范围',
  'range.seven': '最近7天',
  'range.thirty': '最近30天',
  'share.title': '模型占比',
  'share.day': '当天用量',
  'calendar.title': '每日用量',
  'calendar.noUsage': '无用量',
  'day.calls': '调用',
  'day.sessions': '会话',
  'token.input': '输入',
  'token.output': '输出',
  'token.cacheRead': '缓存读',
  'token.cacheWrite': '缓存写',
} satisfies Record<string, string>

/** The usage namespace key union. */
export type UsageKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger.aria': 'Token usage report',
  'dialog.title': 'Token usage report',
  'dialog.close': 'Close usage report',
  'state.loading': 'Loading usage…',
  'state.empty': 'No token usage recorded yet.',
  'state.error': 'Failed to load the usage report.',
  'summary.days': 'Days',
  'summary.sessions': 'Sessions',
  'summary.total': 'Total tokens',
  'range.title': 'Report range',
  'range.seven': 'Last 7 days',
  'range.thirty': 'Last 30 days',
  'share.title': 'Model share',
  'share.day': 'Selected day',
  'calendar.title': 'Daily usage',
  'calendar.noUsage': 'No usage',
  'day.calls': 'calls',
  'day.sessions': 'sessions',
  'token.input': 'Input',
  'token.output': 'Output',
  'token.cacheRead': 'Cache read',
  'token.cacheWrite': 'Cache write',
} satisfies Record<UsageKey, string>
