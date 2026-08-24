# Agent Note: ThinkingSelect — quick three-level thinking dropdown beside the model chip

Status: implemented

English | [中文](2026-08-16-thinking-level-select.zh.md)

## Problem

The model menu already exposes reasoning effort, but it is buried one drill-down deep and labels every level with the adapter's raw catalog name (Off / High / Max). The user wanted a one-click thinking-strength control right next to the model selector in the composer, with exactly three fixed Chinese levels — 关闭 / 高 / 最高 — mapping to DeepSeek's thinking levels.

## Decision

A client-only quick dropdown (`ThinkingSelect`) inside `ui-model-selection`'s composer seat, rendered beside the existing model trigger:

- **Levels**: the three DeepSeek thinking levels in escalation order — `off` → 关闭, `high` → 高, `max` → 最高 — under fixed, localized labels (`thinking.off/high/max` in the plugin's `model` namespace). The control shows only the levels the current model actually offers (so a deployment locked to thinking-disabled shows just 关闭, and a non-reasoning model or one with a different effort vocabulary shows no control at all).
- **The model chip is a pure model picker**: the old two-level Model/Effort menu is gone — opening the seat expands straight into the provider-grouped model list, and the trigger shows only the model name. The thinking chip is the single reasoning-effort surface in the composer, so the two controls cannot disagree or duplicate.
- **Submission**: picking a level is a model selection like the model chip itself — it calls `session.selectModel` with `reasoningEffort` through the same shared per-session `ModelDirectory`, so the Host persists the effort with the model choice and the agent loop folds it into every subsequent LLM request. No host or LLM-package changes: the whole wire contract (`ModelSelection.reasoningEffort`, request-header config, `llm-deepseek`'s `thinking`/`reasoning_effort` serialization) already existed.
- **State and copy**: the trigger shows the effective level (selection ?? adapter default), the menu reuses the seat's chip/menu/option styles, failures ride the seat's existing transient toast, and `locked` (no session / removed) disables the trigger exactly as it disables the model chip. The dropdown is inside the model seat, so it inherits the seat's slot registration, locale seat, and session scoping with zero new plumbing.

## Alternatives considered

**Extend the model menu's existing effort pane.** Rejected: the user asked for a control next to the model selector, not another drill-down; the pane also showed adapter-raw names and a provider-default row that the three fixed levels deliberately omit. The pane was later removed outright once the thinking chip became the single effort surface.

**A new `conversation.input.*` composer slot.** Rejected: it would duplicate the seat's per-session directory, block policy, and locale wiring for one chip; embedding in the model seat keeps one state, one submission path, and one locked policy.

## Consequences

DeepSeek users can switch thinking strength in one click next to the model chip; the choice persists per session with the model selection and reaches the provider on the next request. The model menu no longer duplicates that surface. New coverage: `model-select.client.spec.tsx` (fixed three-level menu, offered-subset, hidden states, locked, Escape close, rejected toast; model list opens directly with no effort pane). No host changes; the feature is pure client composition over the existing selection contract.
