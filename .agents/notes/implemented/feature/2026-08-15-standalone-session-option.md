# Agent Note: Standalone (no Workspace) session option in the New Session flow

Status: implemented

English | [中文](2026-08-15-standalone-session-option.zh.md)

## Problem

Every New Session started from the Web GUI landed in a Workspace: the hero's Workspace picker listed real Workspaces plus **Add workspace…**, and with nothing listed the anchor gesture jumped straight into the add flow. Some work needs no folder at all — a standalone conversation with no project account — but the UI had no way to start one. The backend already supported it (`session.create` accepts neither `workspaceId` nor `cwd` and falls back to the Host default cwd, leaving the session unaccounted, shown under Ungrouped), yet the client had no affordance and, worse, treated any blank ungrouped session as an unfinished pick: the hero rendered a "Choose workspace" chip and a read-only composer.

## Decision

One owner action, one runtime verb, and one menu entry:

- **`WorkspaceRuntime.connectStandalone()`** (widening `IWorkspaces` and the `SessionsPort.create` face to an optional `workspaceId`): reuse the first blank session not accounted to any Workspace — the loose blank is by definition a standalone stub — else `sessions.create({})` (no Workspace, no cwd, Host default cwd). Archived blanks are never reused (no grouping surface can show them), and concurrent calls coalesce into one in-flight create because the menu has no busy arm for this path. The `TestWorkspaces` double implements the widened face (recorded + stubbable).
- **`ConversationInjected.startStandalone()`** (ui-conversation): `connectStandalone()` then open the session, carrying the current blank session's draft/images exactly like a Workspace switch (the draft-carry body extracted into a shared `carryDraft` helper). Failures are non-fatal console diagnostics, matching `startSession`'s posture. ConversationRoot passes it to the hero slot as `EmptyWorkspaceOwnerProps.onStandalone`.
- **Workspace picker menu entry** (ui-workspace): the hero flow pins **不在项目中工作 / Work without a project** beside **添加工作区…** in the menu footer (and in the item list when no Workspaces exist). The entry is owner-supplied (`onStandalone?` on the shared `WorkspacePickFlow`), so the sidebar's add-only flow omits it and keeps its auto-open-add behavior; with the standalone option present, the menu is a real choice and never auto-opens the add flow, and the hero menu is never empty (the "no popover at all" case now only exists for surfaces without the option).
- **Hero chip**: a session with no owning Workspace (standalone, or one whose Workspace was deleted) now labels its chip **未分组 / Ungrouped** instead of the "Choose workspace" placeholder, and a blank ungrouped session is usable — the inert read-only posture now exists only while no session is chosen at all, so a raised composer block applies to ungrouped sessions like any other.

## Alternatives considered

**Making the ungrouped bucket's sidebar ＋ functional.** Rejected: the row's ＋ is documented-inert by an explicit test (the ungrouped bucket has no backing Workspace card); the feature belongs at the New Session choice point, not in the browsing list.

**Distinguishing "standalone by choice" from "workspace deleted".** Rejected: both are the same durable fact (no Workspace account), and the client has no field to tell them apart; treating every ungrouped session as usable is the coherent rule and also fixes the deleted-workspace dead-composer case.

## Consequences

The New Session flow offers a project-free escape hatch on every hero surface; `connectStandalone` is one more method on the workspaces face (the `TestWorkspaces` double breaks at compile time if the face widens again). The chip label for ungrouped sessions changed from the placeholder to a real label, which alters the no-workspace-posture tests in `skeleton.client.spec.tsx`. No host changes were needed — the backend already accepted the empty create payload.
