# Agent Note: Expanded diff tool cards for edit/write

Status: implemented

English | [中文](2026-08-15-expanded-diff-tool-cards.zh.md)

## Problem

The web conversation flow rendered `edit`/`write` tool calls through the shipped `file-mutation-toolview`, which draws the applied diff inside a collapsed-by-default expanded body with an 8-line cap in the chat (`CHAT_DIFF_MAX_LINES`). The change a mutation made was therefore hidden behind a disclosure and truncated in the flow, so a reader could not see at a glance what the agent just modified.

## Decision

Add a client-only package, `@deepseek-ai/dsh-client-ui-diff-viewer` (`packages/client/ui-diff-viewer`), that takes over the `edit` and `write` keys of `ui-tool`'s keyed `tool.call.toolview` slot and renders each mutation as a default-expanded color-coded diff card. The card is a header (mutation title, openable path, lifecycle state, inspect affordance, whole-card collapse toggle) over the product's `DiffBlock` primitive, which draws the removed/added sides with the error/success colors, collapses a long body at its own height cap, and carries a copy affordance and `+A -R · N file(s)` footer.

Hunks and lifecycle derive only from the frozen call/result slice (`block.resultView` when settled, `block.callView` while running — the tools' `card: 'diff'` render intent), never from the filesystem, so replay stays stable across windows and sessions. Registering a key the shipped composition already covers replaces that occupant (the keyed hole's documented takeover semantics); removing the bundle restores the shipped rows.

The card body aligns the old and new sides per line (a bounded LCS) and draws **per-file line numbers** on every row: the old line for a removal, the new line for an insertion, both for a context row. True file coordinates ride the `FileDiff` contract as optional `oldStart`/`newStart` (1-based hunk start lines) that `computeHunkDiffs` now fills from `structuredPatch`'s hunk metadata; call-time views and older persisted results without them number within the hunk from line 1. The fields are optional and validated in both `diffsFromMeta` (tool-fs) and the client `narrowDiffs`, so older data degrades to hunk-relative numbers instead of failing.

The row is wired into the web surface by one insert in `packages/bundle/web-app/cordis.patch.yml` plus a workspace dependency, mirroring every other `dsh.client` browser row. The node half is an empty `apply`; the browser half ships via `exports["./client"]`, discovered through the `dsh.client` declaration.

## Alternatives considered

- **Keep the shipped row, only raise the line cap** — does not change the collapsed-by-default presentation the request targets; the takeover is the point.
- **Hand-roll a line-aligned LCS diff renderer** — duplicates the product's unified `DiffBlock` surface (shared with the details panel and TUI); reuse keeps visuals and interaction consistent.
- **Emit a new session event with the diff** — unnecessary: the hunks already ride the persisted call/result views; a new model-visible input would also need a session event under the model-visible ⟺ logged rule.

## Consequences

- The default web composition now shows expanded diffs for file mutations; the shipped collapsed rows remain the fallback when the bundle is removed.
- No tool, event, or model-visible context is added; this is a pure client presentation surface.
- Result-only history pages (call head outside the runtime window) still fall back to the generic row, since keyed dispatch needs the paired call.
- The standalone source is mirrored at `https://codeup.aliyun.com/5f27f6eddb0493ecef90b94a/ywy_sky/dsh-show-diff.git`.
