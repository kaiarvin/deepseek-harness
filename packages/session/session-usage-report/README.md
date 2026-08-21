# @deepseek-ai/dsh-session-usage-report

English | [中文](README.zh.md)

Cross-session token usage report service (`ctx.sessionUsage`): an incremental usage ledger. Each `assistant/message` carrying provider `usage` lands as one sample (wall-clock time, provider, model, session, billed tokens) the moment it is appended to a live session — nothing is folded on open. Samples are persisted durably (debounced, atomic temp-file replace) and loaded at service start, so a report call buckets in-memory samples by the viewer's local day and answers instantly, with no corpus reads.

A first start with no persisted samples backfills once from the session corpus through `ctx.sessionQuery` exact reads (never the search index); afterwards the aggregate is purely event-driven.

## What it serves

`ctx.sessionUsage.report({ timezoneOffsetMinutes? })` returns a detached report:

- `days` — local-day buckets, oldest first, each with `dayStartMs` (the local day's zero hour as a UTC epoch ms), a distinct-session count, the day's token totals, and per-model rows (`provider`, `model`, `calls`, `sessions`, `tokens`).
- `timezoneOffsetMinutes` — the viewer offset the caller requested, echoed back.

`dayStartMs` is rendered with the caller's locale to display that viewer's calendar date. The caller passes the browser's `Date.getTimezoneOffset()` so day boundaries match the viewer's wall clock.

Token buckets are the disjoint provider fields: uncached `input`, `output`, `cacheRead`, and `cacheWrite`. Only `assistant/message` events carrying provider `usage` count; each sample is attributed to the latest preceding `request/header` (provider/model), so mid-session model switches split correctly.

## Behavior

- Live aggregation: a `session/event` carrying `assistant/message` usage updates the ledger immediately, and `request/header` events update the per-session attribution. The report reflects the latest sample on every call — no staleness window, no rescan.
- Persistence: samples are written to `~/.dsh/usage-report/usage-report-samples.json` (atomic temp-file replace, fail-soft) after a short debounce and flushed on disposal. A restart loads the file and never scans the corpus.
- One-time backfill: when no sample file exists, the service folds the complete corpus once (reads each session through `ctx.sessionQuery`) to seed the ledger; sessions or reads that fail individually are skipped with a warning. The backfill and the live stream are reconciled by sequence, so events the backfill already counted are never double-counted by the live firehose.
- Retention: samples older than `retentionDays` (default 40) are pruned on load and write; the Web dialog shows at most 30 days.
- Replay-safe: `session/event` fires only for live appends (constructor seeds — replay, fork, resume — never publish), so a restart never double-counts.
- A composition without `ctx.sessionQuery` (or without any sessions) yields an empty `days` list until live samples arrive.

## Composition

```yaml
- name: '@deepseek-ai/dsh-session-query-sqlite'
- name: '@deepseek-ai/dsh-session-usage-report'
```

Configuration is optional: `cacheDir` (defaults to the DSH home's `usage-report` directory), `retentionDays` (default 40), and `persistDelayMs` (default 1000). The Web usage dialog (`@deepseek-ai/dsh-client-ui-usage-report`) consumes the same report through the apiproxy `usage.report` RPC.

## Model Experience

Indirectly, through the Web usage dialog; the service itself adds no prompt, message, schema, tool, or model call.

#### KV Cache effect

None; the service reads the session log and writes one local sample file per usage-bearing message, with no prompt-side or KV-cache token effect.

## Known Limitations and Deferred Work

- The ledger counts usage as it happened: compacting or deleting a session does not retroactively remove its counted usage (a usage report is a ledger, not a projection of the current log).
- Samples older than the retention window are pruned, so only the most recent `retentionDays` (default 40) are kept — matching the dialog's 30-day range.
- The one-time backfill reads the full corpus once on the first start after an upgrade; on a large corpus that single scan can take tens of seconds (the pre-upgrade report paid the same cost on every open).
