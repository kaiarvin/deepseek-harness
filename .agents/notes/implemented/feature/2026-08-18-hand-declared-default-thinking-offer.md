# Agent Note: Hand-declared models default to the off / high / max thinking offer

Status: implemented

English | [中文](2026-08-18-hand-declared-default-thinking-offer.zh.md)

## Problem

A model a pi-ai profile declares by hand — one the installed catalog does not describe, which is every model added through the web Models page's "add a custom provider" card — materialized with `reasoning: false` unless its entry declared `reasoningEfforts` ([per-model reasoning declarations](../feature/2026-08-08-pi-ai-per-model-reasoning-declarations.md)). The composer's thinking-level selector renders only levels the current model's reasoning metadata offers, so a custom model showed no thinking control at all, while the shipped DeepSeek catalog models offered 关闭 / 高 / 最高. A user whose deployment is mostly custom gateways had no way to pick a thinking strength for them, and the fix was not discoverable: it required hand-editing `settings.yaml` to add a `reasoningEfforts` block per model, a field no configuration surface edits.

## Decision

A hand-declared model whose entry declares no `reasoningEfforts` now defaults to the same off / high / max offer the shipped DeepSeek catalog models carry, instead of "does not reason". `resolveModelReasoning` in `packages/llm/llm-pi-ai/src/catalog.ts` returns `reasoning: true` with the DeepSeek-level map `{ minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' }` (a fresh copy per model) when the entry declares nothing and the installed catalog has no entry of that id. `off` stays absent from the map — supported, send nothing — and the remaining levels are pinned `null` exactly as a declaration would pin them, so `getSupportedThinkingLevels` reports `['off', 'high', 'max']` and the composer's thinking selector appears for every custom model with the three fixed levels.

The wire behavior follows from the existing dispatch: pi-ai's OpenAI-style `reasoning_effort` path sends `high` / `max` verbatim and omits the parameter for `off`, and the other protocols map the level through their own dispatch (anthropic budget/adaptive thinking, google level/budget, and so on). Selecting a level records it with the model choice through the same `session.selectModel` path as a catalog model, and the agent loop folds it into every request.

Catalog models are untouched: an entry naming a catalog id with no `reasoningEfforts` still inherits that entry's capability (a catalog model pi-ai marks as non-reasoning stays non-reasoning), `reasoningEfforts: false` still declares a non-reasoning model, and a declared dict still wins over the default. The change is the `base === undefined` branch only, so every new custom model created later gets the offer automatically; there is no per-route or per-model opt-in to remember.

## Alternatives considered

- **Report the offer in the description only** (`resolveModelInfo` returning `off`/`high`/`max` while the materialized model stays `reasoning: false`). Rejected: the request path validates the effort against the model's real capability and would refuse every selected level with `UNSUPPORTED_REASONING_EFFORT` before network I/O — a selector that shows levels it cannot send is the exact misrepresentation the old "no control it could not honour" posture existed to prevent.
- **Default only on the `openai-completions` protocol.** Rejected: the level map is protocol-neutral — each pi-ai dispatch maps levels through its own wire shape — and a hand-declared anthropic or responses model benefits from the same selector. The default map spells exactly the three levels the selector shows, so no protocol advertises a level it cannot dispatch.
- **Teach the Models page to write a default `reasoningEfforts` block per model.** Rejected: a configuration surface writing what resolution can default is a second source of truth, and models created by any other route (a hand-edited `settings.yaml`, a composition patch) would still lack the offer.
- **Keep the old posture and document the `reasoningEfforts` escape.** Rejected: it leaves the reported problem — a user-facing capability absent for every custom model — unsolved, and the field remains uneditable from any surface.

## Consequences

- Every hand-declared model — existing and future — offers 关闭 / 高 / 最高 in the composer, and each level reaches the wire. Users of custom gateways get the same thinking control as the shipped DeepSeek models.
- `reasoningEfforts: false` remains the spelling for a hand-declared model whose gateway cannot take the parameter, and a declared dict still shapes the offer per model.
- A custom endpoint that rejects the `reasoning_effort` parameter fails loud on the request (provider error) rather than being hidden; the profile's `compat.supportsReasoningEffort: false` remains the operator's escape for such an endpoint, and the route-level `reasoning` default still wins for deployments that configure one.
- The selector's fixed three levels are the DeepSeek vocabulary ([thinking-level select](../feature/2026-08-16-thinking-level-select.md)); a hand-declared model with a different native effort vocabulary still declares `reasoningEfforts` to rename the wire spellings.
