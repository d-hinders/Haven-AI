---
owner: "@d-hinders"
status: current
covers: []  # narrative — process playbook
last-verified: "2026-06-30"
---

# Frontend playbook

Loaded by `ship-next` for `area:frontend` issues. The goal: a UI issue is shipped on Haven's UX standards without the contributor having to name them. This playbook **links** the standards; it does not restate them.

## 1. Required reading (before implementing)

Read, in order — these are `AGENTS.md` → "Required Reading For UI Work":

1. [`product/README.md`](../../product/README.md) — product doctrine, IA, money-movement clarity, accessibility, and closeout checks.
2. [`product/design-system.md`](../../product/design-system.md) — tokens, typography, cards, buttons, motion, surface hierarchy.
3. [`product/copy-guidelines.md`](../../product/copy-guidelines.md) — user-facing wording and banned technical terms.
4. [`product/screen-recipes.md`](../../product/screen-recipes.md) — repeatable screen structures.
5. [`product/design-review.md`](../../product/design-review.md) — the finishing checklist (also used in §5).

If a `/design-system` route exists, inspect it before editing UX.

## 2. Reuse first

Inspect `packages/frontend/src/components/ui` (primitives) and `packages/frontend/src/components/haven` (domain components) before adding UI. Prefer composition; do **not** invent new card styles, spacing, shadows, radius, or typography unless the existing system genuinely can't express the need. Use the v2 tokens in `globals.css` and the Tailwind aliases.

## 3. Captain Self-Check Preflight

Run the matching items from the **Captain Self-Check Preflight** in [`../ai-agent-workflow.md`](../ai-agent-workflow.md) for the traps the diff touches — e.g. numeric formatters, counter/summary buckets, conditional copy predicates, async hook generations, signer-readiness gates, animation discipline, inline-gate placement, cross-surface display drift, loading-state inference. Each is one grep or one quick read. Do this **before** review so the reviewer finds fewer issues.

## 4. Verification

Verify the change in the **browser**, or — when the browser path is unavailable/flaky — add a **named headless equivalent** (vitest) that covers the skipped animation, layout, routing, loading, or interaction risk. Include empty, loading, error, and success states when the screen can enter them; check mobile and desktop.

## 5. Review (advisory design pass)

Run `haven-reviewer` with UI context, checking the diff against [`product/design-review.md`](../../product/design-review.md) and [`copy-guidelines.md`](../../product/copy-guidelines.md). Two automated aids back this up: the Vale terminology rule (`.vale.ini`, scoped to `docs/product`) for docs copy, and **`npm run lint:copy`** (`scripts/frontend-copy-lint.mjs`, also an advisory CI job) which flags banned multi-word terms in user-facing frontend copy (`app/` + `components/`). Both are advisory — for anything they miss, check changed strings against `copy-guidelines.md` by hand. Use `// copy-lint-ignore` for a legitimate advanced/developer-facing surface.

## 6. Merge policy (UI)

A non-money frontend PR **auto-merges** on green CI + verification **unless** the design-review / `haven-reviewer` UI pass flags a UX, copy, or design-system issue (**even a nit-level one**) — then **pause and ask the user** (UX is subjective; a flagged finding is a human call). This is the `area:frontend` case of the canonical skill's [Merge Gate](../../../.agents/skills/ship-next/SKILL.md#merge-gate). Money-path UI still follows the `money.md` human gate.
