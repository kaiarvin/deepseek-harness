# @deepseek-ai/dsh-client-ui-diff-viewer

English | [中文](README.zh.md)

Expanded color-coded diff tool cards, browser half: registers the `edit` and `write` wire names in `ui-tool`'s keyed `tool.call.toolview` slot. Each file mutation renders as an expanded diff card directly in the conversation flow — a header naming the mutation (`Edit` / `Write`) and its path, then the applied hunks through the package's line-aligned `DiffLines` surface, which draws the removed and added sides with the error/success colors, shows the **old and new file line numbers** per row (rebased onto each hunk's start line, so numbers are true file coordinates), collapses a long body at a height cap, and carries a copy affordance and a `└ +A -R · N file(s)` footer.

The old and new sides are aligned per line via a bounded LCS, so each row shows both its old-file and new-file line where the sides agree, the old line for a removal, and the new line for an insertion — the same reading a GitHub-style diff gives. The tools' result views carry each hunk's first file line (`oldStart`/`newStart` on the `FileDiff` contract); call-time views and older data without those fields fall back to numbering from line 1 within the hunk.

The default shipped `file-mutation-toolview` row also renders the same hunks, but inside a collapsed-by-default expanded body with an 8-line cap in the conversation flow. This package takes over the two keys so the change is visible at a glance: the card renders expanded, and the whole card can be collapsed with a header toggle. Registering a key the shipped composition already covers replaces that occupant — the rows register at priority `-1`, shadowing the shipped cells (same key at the same priority would throw); removing this bundle restores the shipped row.

## Data source

The row derives its hunks and lifecycle only from the frozen call/result slice supplied by `ui-tool`, never from the filesystem:

- **Settled** — `block.resultView` when its `card` is `'diff'` carries the applied contextual hunks the `edit`/`write` tools return (an edit's real before/after, a create's whole-file diff). This is authoritative and replaces the call-time view.
- **Running** — `block.callView` when its `card` is `'diff'` carries the intended change derived from the arguments alone (an overwrite's `oldText` is `null`).
- **Malformed or absent** — a `card: 'diff'` view whose `diffs` is not a well-formed hunk array routes the card to the empty state; an errored mutation keeps its model-facing error text on the output surface instead of a diff.

Replay stays stable: the hunks live on the persisted call/result views, so a window or session reload redraws the same change.

## Install

The bundle is a normal `dsh.client` package. Add a row to the web surface's `cordis.patch.yml` (or any later patch layer) and a workspace dependency to the owning bundle:

```yaml
- id: ui-diff-viewer
  name: '@deepseek-ai/dsh-client-ui-diff-viewer'
```

The node half is an empty `apply` so the plugin appears in the host composition; the browser half ships via `exports["./client"]`, discovered through the `dsh.client` declaration. Removing the row turns the surface off and restores the shipped file-mutation rows.

## Behavior

- **State** — running calls announce "Applying change"; failures show the first error line and the error state; interrupted calls use the warning state. Colour-only cues carry a visually hidden state label.
- **Path** — the mutation's `file_path` renders as an openable link (workspace-rooted paths display relative to the session `cwd`).
- **Collapse** — the whole card collapses to its header with a toggle; `DiffLines` keeps its own height cap for very long diffs.
- **Inspect** — the standard trajectory `Inspect` affordance is offered when available.

## Model Experience

None, as the expanded diff cards render already-logged tool results in the browser and register no prompt, message, schema, or tool.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Result-only history pages use the generic row** — keyed dispatch needs the paired call in the runtime window; pagination that leaves the call outside has no tool identity, and this presentation feature does not extend the history wire contract to recover it.
- **Line numbers are hunk-relative when the data lacks file coordinates** — call-time views and older persisted results carry no `oldStart`/`newStart`, so those hunks number from line 1 within the hunk rather than the file; result views produced by current tools carry true file lines.
- **Takeover, not additive** — occupying `edit`/`write` replaces the shipped `file-mutation-toolview` for those names. The rows intentionally restore the shipped behavior when the bundle is removed; there is no coexistence mode.
