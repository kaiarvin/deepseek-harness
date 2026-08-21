# Agent Note: Incremental session usage ledger

Status: implemented

English | [中文](2026-08-20-incremental-session-usage-ledger.zh.md)

> Refines the aggregation mechanism introduced in [Cross-session token usage report and Web usage dialog](../feature/2026-08-15-cross-session-usage-report.md): the report shape, the apiproxy `usage.report` wire face, and the client dialog are unchanged; only the host-side aggregation changes.

## Problem

The Web token usage dialog hung for tens of seconds. `@deepseek-ai/dsh-session-usage-report` folded the whole session corpus on demand: `report()` served a stale-while-revalidate cache, but once a cache was dirty past the 30s window it rescanned SYNCHRONOUSLY on the next open. The fold reads every session's full log through `ctx.sessionQuery` exact reads; as the corpus grew (one working session alone reached ~570k events / ~29 MB), a single scan crossed 30–45s, so with an actively writing session the dialog opened to "loading" for that long on every visit. The design assumed scans were cheap; that assumption stopped holding.

## Decision

Replace the scan-on-demand fold with an incremental, persisted usage ledger in the same service:

- Every `assistant/message` carrying provider `usage` lands as one sample (time, provider, model, sessionId, billed tokens) the moment it is appended to a live session; `request/header` events update per-session attribution. `report()` buckets the in-memory samples by the requested local day and returns instantly — no corpus reads, no staleness window.
- Samples persist to one durable file (`usage-report-samples.json`, atomic temp-file replace, debounced, flushed on fiber disposal). A restart loads the file; the corpus is never scanned again after the first start.
- A first start with no sample file backfills once: fold the complete corpus into samples through `ctx.sessionQuery` exact reads (same per-session skip-on-failure tolerance as before). The backfill and the live firehose are reconciled by sequence — `session/event` fires only for live appends (constructor seeds never publish, so replays/forks/resumes cannot double-count), and a live event whose `seq` is within its session's backfill-read boundary was already counted by that read and is dropped.
- Samples older than `retentionDays` (default 40) are pruned on load and write; the dialog shows at most 30 days, so the ledger stays bounded.
- The query seam stays optional (`ctx.get('sessionQuery')`, active-fiber read): without it the service is firehose-only and the backfill is skipped.

The old `freshMs`/`diskFreshMs` config and the per-timezone durable files are gone. The report shape, the apiproxy `usage.report` wire face, and the client dialog are untouched.

## Alternatives considered

**Faster scans (incremental fold checkpoints, cheaper reads).** Rejected: for a scan-on-demand design the corpus read cost is irreducible — any open can still pay a full fold, and the fold itself is already a single pass with bounded concurrency. The problem is architectural, not a constant factor.

**Longer stale-while-revalidate windows.** Rejected: it only delays the hang; the synchronous rescan on a dirty, stale cache still blocks the open, and a busy session keeps the cache dirty indefinitely.

**Client-side aggregation over `session.list` + `session.history`.** Rejected in the original note ([Cross-session token usage report](../feature/2026-08-15-cross-session-usage-report.md)) and still: every open would re-pull history through the paged wire API, and the aggregation belongs with the log, not the browser.

The chosen design moves the cost to write time (one sample per usage-bearing message) and makes open time O(samples in memory) — effectively free. The event stream is the right source: the repo already trusts `session/event` as the authoritative append channel (token-meter's projections ride the same firehose), and constructor seeds never emit, which is exactly the no-double-count guarantee an incremental counter needs.

## Consequences

- The dialog opens instantly after the first start; a report call never reads the corpus again.
- The first start after this change pays one full-corpus backfill (the same 30–45s cost the old design paid on every open), then writes the sample file.
- The ledger counts usage as it happened: compacting or deleting a session does not retroactively remove its counted usage (a scan-on-demand fold would lose compacted history anyway; the ledger at least keeps it).
- The config surface changed: `freshMs`/`diskFreshMs` are removed; `retentionDays` (default 40) and `persistDelayMs` (default 1000) are added. Old per-timezone durable files are ignored (different file and format); the backfill regenerates everything.
- The `usage.report` wire contract, the dialog's 7/30-day range, and the per-timezone day bucketing are unchanged.

## Tests

The suite was rewritten around the new contract: live-path aggregation driven by real `session.append` (immediate, no corpus reads), backfill-path seeding (one cold pass, seq reconciliation with concurrent live appends), persistence round-trip without a corpus read, corrupt/version-mismatched/non-object/malformed sample files, retention pruning, disposal flush, failing directory, failing reads/listing, and the no-query-seam mode. Per-file src coverage stays 100%.
