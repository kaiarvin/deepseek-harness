# @deepseek-ai/dsh-client-ui-usage-report

English | [中文](README.zh.md)

Cross-session token usage dialog for the Web GUI: a sidebar-foot icon beside Settings (the `sidebar.footer.action` seat) opens a modal folding the host's `usage.report` into a model-share donut and a daily calendar heatmap.

## What it shows

- **Range selector** — the report is cut to the last 7 or 30 local days (30 by default); anything older is not counted, not shown, and never reaches the calendar.
- **Summary strip** — total billed tokens, day count, and distinct-session count across the selected range.
- **Model-share donut** — the selected day's model breakdown as an SVG donut with a legend (model, billed total, percent); hovering a segment or legend row shows exact figures. The most recent usage day in the range is selected by default, and a selection that falls outside a narrowed range falls back to the range's most recent day.
- **Daily calendar heatmap** — one complete calendar month per block within the selected range (empty months skipped), each day a square whose fill depth scales with the day's billed tokens; hovering a square shows its date and exact token count, and clicking one switches the donut to that day.

The dialog fetches `usage.report` once on open with the browser's local timezone offset, so day boundaries match the viewer's wall clock. It owns its load/empty/error seats and renders nothing until the report arrives. Copy is localized (zh/en).

## Composition

```yaml
- name: '@deepseek-ai/dsh-client-ui-usage-report'
- name: '@deepseek-ai/dsh-session-usage-report'
```

The host plugin provides `usage.report` (through the apiproxy gateway); without it the dialog answers an error seat.

## Model Experience

None, as the dialog is a read-only RPC consumer over the host's usage.report and adds no prompt, message, schema, tool, or model call.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The report is cut to the last 30 local days** — the range selector offers 7 or 30 days, and the host's session-usage-report service prunes samples older than its retention window, so older usage is not counted.
- **Usage is counted as it happened, not as a projection of the current logs** — compaction and session deletion do not retroactively remove counted usage; the ledger is event-driven, not a replay of the present corpus.
