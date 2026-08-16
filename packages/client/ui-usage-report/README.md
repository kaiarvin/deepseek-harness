# @deepseek-ai/dsh-client-ui-usage-report

English | [中文](README.zh.md)

Cross-session token usage dialog for the Web GUI: a sidebar-foot icon beside Settings (the `sidebar.footer.action` seat) opens a modal folding the host's `usage.report` into a model-share donut and a daily calendar heatmap.

## What it shows

- **Summary strip** — total billed tokens, day count, and distinct-session count across the whole report.
- **Model-share donut** — the selected day's model breakdown as an SVG donut with a legend (model, billed total, percent); hovering a segment or legend row shows exact figures. The most recent usage day is selected by default.
- **Daily calendar heatmap** — one complete calendar month per block (from the earliest month with usage through the current month, empty months skipped), each day a square whose fill depth scales with the day's billed tokens; hovering a square shows its date and exact token count, and clicking one switches the donut to that day.

The dialog fetches `usage.report` once on open with the browser's local timezone offset, so day boundaries match the viewer's wall clock. It owns its load/empty/error seats and renders nothing until the report arrives. Copy is localized (zh/en).

## Model Experience

None directly: the dialog is a read-only RPC consumer and adds no prompt, message, schema, tool, or model call.

## Composition

```yaml
- name: '@deepseek-ai/dsh-client-ui-usage-report'
- name: '@deepseek-ai/dsh-session-usage-report'
```

The host plugin provides `usage.report` (through the apiproxy gateway); without it the dialog answers an error seat.
