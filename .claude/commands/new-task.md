---
description: "Capture a freeform task as a well-formed GitHub backlog issue — drafts Scope + Acceptance + Surface + Money-path from a one-line description, asking clarifying questions when needed. Backlog-only by default (does NOT queue it for the loop). The capture half of the workflow; /ship-next is the execute half."
---

Turn a freeform task description into a **high-quality, loop-ready GitHub issue** — without shipping it. This is the **capture** step; `/ship-next` is the **execute** step. Both produce issues identical in shape to a hand-written [`.github/ISSUE_TEMPLATE/loop-task.md`](../../.github/ISSUE_TEMPLATE/loop-task.md), so the loop never has to stop and ask you to sharpen them.

The argument is the freeform task (e.g. `/new-task "add a copy button to the agent card"`). An optional `--ship` (or the user saying "ship it now") flips this from capture to capture-and-ship.

## Steps

1. **Ground it.** Take a quick look at the repo to anchor scope and likely files — Grep/Glob/Read, or `haven-explorer` for anything non-trivial. Scale to the task; skip for an obvious one-liner.
2. **Classify the surface(s)** — `area:frontend|backend|sdk|mcp|docs` and `money-path` — from the described change and the files it will likely touch (the Phase 6 money-path file list defines money-path).
3. **Ask clarifying questions when needed — do NOT guess.** If the scope is vague, the acceptance bar is unclear, the surface is ambiguous, or it touches the **money path / auth / schema**, use `AskUserQuestion` to get what you need before filing. A high-quality issue is the goal; a one-line prompt that's genuinely underspecified gets one or two sharp questions, not a guess.
4. **Draft the issue body** in the loop-task shape:
   - **Scope** — one paragraph the implementer can act on *without guessing*.
   - **Acceptance criteria** — the observable bar for "done" (concrete; the loop refuses vague issues).
   - **Files** — best-effort ownership.
   - **Surface** — the `area:*` / `money-path` checklist.
   - **Money-path?** — Yes/No, with the money-path note when Yes.
5. **Create the issue** with `mcp__github__issue_write`:
   - Apply the inferred **`area:*`** label(s) and **`money-path`** when applicable.
   - **Do NOT apply `code-quality`** — backlog only by default (see below).
   - Assign the requester. Return the issue link.

## Backlog only by default

Capturing a task is **not** the same as queuing it for the loop. A `/new-task` issue is filed **without** the `code-quality` "ready" marker, so a bare `/loop /ship-next` will not pick it up. This keeps the backlog safe to fill freely.

**To queue a backlog issue for the loop later:** add the `code-quality` label (or make it a sub-issue of an epic and run `/ship-next epic=#<n>`).

## Ship now (opt-in)

If the user passes `--ship` or says "ship it now": after creating the issue, **also add the `code-quality` label** and hand the issue to **`/ship-next`** to run the full pipeline (implement → review → doc-check → PR → reviewer-gated auto-merge). This is exactly what the `/ship-next "<task>"` front door does.

## Guardrails

- Never fabricate acceptance criteria for a money-path / auth / schema task — ask first.
- Keep the issue body in the loop-task template shape so generated and hand-written issues are interchangeable.
- Filing isn't final: GitHub issues are editable, so draft-then-refine is fine — but get the shape and the money-path classification right up front.
