# @deepseek-ai/dsh-session-usage-report

English | [中文](README.zh.md)

Cross-session token usage report service (`ctx.sessionUsage`): folds every logical session's durable log — live sessions first, persisted sessions through the mounted persistence backend — into per-local-day, per-model billed token totals. The fold reads each session once through `ctx.sessionQuery` exact reads (never the search index), so the report works in every profile that mounts the query seam.

## What it serves

`ctx.sessionUsage.report({ timezoneOffsetMinutes? })` returns a detached report:

- `days` — local-day buckets, oldest first, each with `dayStartMs` (the local day's zero hour as a UTC epoch ms), a distinct-session count, the day's token totals, and per-model rows (`provider`, `model`, `calls`, `sessions`, `tokens`).
- `timezoneOffsetMinutes` — the viewer offset the caller requested, echoed back.

`dayStartMs` is rendered with the caller's locale to display that viewer's calendar date. The caller passes the browser's `Date.getTimezoneOffset()` so day boundaries match the viewer's wall clock.

Token buckets are the disjoint provider fields: uncached `input`, `output`, `cacheRead`, and `cacheWrite`. Only `assistant/message` events carrying provider `usage` count; each sample is attributed to the latest preceding `request/header` (provider/model), so mid-session model switches split correctly.

## Behavior

- The report is cached per requested timezone with a stale-while-revalidate window: a `session/event` marks it dirty, but a dirty cache keeps serving for 30 seconds while a background rescan refreshes it, so rapid dialog opens do not pay a full corpus fold each time. A report call rescans synchronously only when its cache is cold or has been dirty past the window (the plugin's `freshMs` config tunes the window).
- Fresh scans are persisted to disk (`~/.dsh/usage-report/usage-report-<tz>.json`, atomic temp-file replace, fail-soft): a process restart reuses the last scan within the disk fresh window (1 hour, `diskFreshMs` config) instead of paying a full corpus fold on the first cold open. A version-mismatched or unreadable cache file is discarded and costs one scan.
- Sessions or reads that fail individually are skipped with a warning — one corrupt log never blocks the rest of the report.
- A composition without `ctx.sessionQuery` (or without any persisted/live sessions) yields an empty `days` list.

## Composition

```yaml
- name: '@deepseek-ai/dsh-session-query-sqlite'
- name: '@deepseek-ai/dsh-session-usage-report'
```

The service has no configuration. The Web usage dialog (`@deepseek-ai/dsh-client-ui-usage-report`) consumes the same fold through the apiproxy `usage.report` RPC.

## Model Experience

Indirectly, through the Web usage dialog; the service itself adds no prompt, message, schema, tool, or model call.
