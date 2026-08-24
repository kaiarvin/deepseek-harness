# Agent Note: Cross-session token usage report and Web usage dialog

Status: implemented

English | [中文](2026-08-15-cross-session-usage-report.zh.md)

> Superseded in part by [Incremental session usage ledger](../architecture/2026-08-20-incremental-session-usage-ledger.md): the aggregation mechanism changed from scan-on-demand folding to an incremental persisted ledger. The report shape, the `usage.report` wire face, the client dialog, and the rejected alternatives below remain current.

## Problem

Token accounting (`dsh-token-meter`) was per-session only: three session projections serve the current session's billing and occupancy, and nothing aggregated across the logical corpus. There was no answer to "how many tokens did I use each day, and which models dominate?" — a natural product question the Web GUI could not answer.

## Decision

Two new packages plus a gateway RPC:

- **`@deepseek-ai/dsh-session-usage-report`** — the aggregation service (`ctx.sessionUsage.report({ timezoneOffsetMinutes? })`). It lists the corpus through `ctx.sessionQuery` exact reads (live-preferred, persisted through the mounted backend; never the search index) and folds each session's raw log once: attribution follows the latest preceding `request/header` (provider/model), only `assistant/message` events carrying provider `usage` count, and events land in the viewer's local-day bucket (the caller passes `Date.getTimezoneOffset()`; `dayStartMs` is the local zero hour as a UTC epoch ms, rendered with the caller's locale). Tokens are the disjoint provider buckets (uncached input, output, cache read, cache write). Reports are cached per requested timezone and invalidated by any `session/event`; individually failing sessions are skipped with a warning so one corrupt log never blocks the rest.
- **`usage.report`** in the apiproxy gateway — one unary RPC: `api/usage.ts` (contract), `api/usage.schema.ts` (zod), `rpc-map` row, `fetch/handler.ts` route, `IApiClient` method, and the fixture/dispatch faces. The host handler delegates to the optional `ctx.get('sessionUsage')` service and answers `usage-unavailable` when absent.
- **`@deepseek-ai/dsh-client-ui-usage-report`** — the Web surface: a `sidebar.footer.action` icon beside Settings opens a dialog with a summary strip (total billed tokens, days, sessions), a model-share breakdown (each model's billed total with a proportional bar, sorted descending), and per-day rows (local date, day total, per-model input/output/calls/sessions). A range selector cuts the report to the last 7 or 30 local days (30 default) — days outside the window are never counted, shown, or heatmapped, so an old conversation's usage cannot skew the totals. The dialog is a one-shot RPC read with its own load/empty/error seats; copy is localized (zh/en).

Both packages ship in the default composition: `session-usage-report` in the base bundle (beside token-meter), `ui-usage-report` in the web-app bundle (beside ui-settings-general). Client types derive from the wire contract (`ResponseValue<'usage.report'>`) through `dsh-api-remotes/client` — no host dependency in the client bundle.

## Alternatives considered

**Client-side aggregation over `session.list` + `session.history`.** Rejected: every open would re-pull all session history through the paged wire API, and the corpus fold belongs with the log, not the browser.

**A session projection key.** Rejected: projections are per-session; a root-scoped cross-corpus key would need new projection infrastructure and would still need the corpus enumeration the service already owns.

**Exact tokenizer repricing instead of provider usage.** Rejected: provider usage is already in the log; heuristics only apply where no usage exists, and the report deliberately never bills twice (reasoning is an output subdivision, not a separate bucket).

## Consequences

A deployment gains the Web usage dialog with no configuration; without `session-usage-report` mounted, the dialog answers an error seat and every other RPC is unaffected. The report is a snapshot over the durable corpus: it reflects committed events only, updates after `session/event` invalidates the cache, and a crash between events can only stale the cached report, never corrupt it. Day bucketing is viewer-timezone-dependent by design (the UI passes its local offset), so two viewers in different zones see their own days; UTC callers pass `0`. The client range selector (7/30 days) narrows what is aggregated and rendered, so the wire still carries the full report but the dialog only surfaces the recent window — keeping old activity out of the totals without a host-side retention policy.
