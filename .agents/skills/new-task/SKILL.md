---
name: new-task
description: Capture a freeform Haven task as a well-scoped GitHub backlog issue with concrete acceptance criteria, likely files, surface labels, and money-path classification. Use when a user asks to create, record, file, or queue a new Haven task or issue; ship only when explicitly requested.
---

# New Task

Turn a freeform request into a loop-ready GitHub issue without implementing it.

## Workflow

1. Inspect the repository just enough to anchor the scope, likely files, and existing patterns. Use a read-only explorer role from [haven-agent-workflow](../haven-agent-workflow/SKILL.md) for non-trivial work.

   **Every code claim in the body is measured, not remembered.** Each `file:line` reference, count, status list, schema claim, or mechanism claim (what code writes, reads, returns, or refuses) is produced by a command the body quotes, at a named commit: the body carries a one-line `Measured on `origin/dev` @ `<sha>`` and, for each figure, either the command inline or a single fenced *Method* block at the end. A mechanism claim is verified by reading the statement that does the work (the `INSERT`, the `UPDATE`, the `return`), never the comment above it, and cites that line. A claim the writer could not verify is written as a question ("verify whether … holds"), never as a fact. This is the same discipline `ship-next` already binds PR bodies with (its *Numbers state their basis* rule requires every count re-derived from its instrument at a named commit); nothing else enforces it for issue bodies, and unverified claims are the largest class of partner corrections on filed epics.
2. Classify every affected surface using `area:frontend`, `area:backend`, `area:sdk`, `area:mcp`, `area:docs`, and `money-path`. Confirm money-path classification against [ship-next](../ship-next/SKILL.md).
3. Ask one or two focused questions when scope, acceptance, or surface is ambiguous. Always ask before defining acceptance for money movement, authentication, authorization, or schema work.
4. Draft the body using [the loop-task template](../../../.github/ISSUE_TEMPLATE/loop-task.md):
   - **Scope**: one actionable paragraph.
   - **Acceptance criteria**: observable completion conditions.
   - **Files**: best-effort ownership.
   - **Surface**: checked surface labels.
   - **Money-path?**: explicit Yes or No.

   Take the template's **body shape and its sizing rule** — "keep it small and
   self-contained, one PR's worth of work"; anything larger is an epic, below.
   Do **not** take its `labels:` default. The template auto-applies
   `code-quality` because a human opening it through GitHub's UI is queueing work
   deliberately; this skill files to the backlog unless shipping was asked for,
   per *Backlog And Shipping*. Same template, opposite default, and only the
   filer knows which one applies.
5. Check GitHub for a materially duplicate open issue — and for an open issue this
   would be a "still" of. A "still" reopens or widens that issue; it never files a
   sibling ([ship-next § *Filing bar*](../ship-next/SKILL.md#filing-bar-2767)).
6. **A defect-type task carries a reproduction before it is queued (#2767).** When
   the task reports something broken — a product defect, missing product behaviour,
   or a required check that is red for a false reason or green over a real defect —
   the body names a repro at a SHA: a command, a failing test, or a screenshot. No
   repro, no issue: ask the requester for one, or record the task as **Not filed**
   in whatever PR or session surfaced it. Feature and epic tasks are unaffected;
   the full five-check bar is stated once, in ship-next, and applies to every
   filed defect whatever route files it.
7. Create the issue with the available GitHub integration. If no integration is available, use an authenticated `gh` CLI.
8. Apply every inferred `area:*` label and `money-path` when applicable. **Leave the issue unassigned** unless the requester asks to own it — both issue templates ship `assignees: []`, and a queue of unassigned issues is what the loop expects to read. Assignment records ownership; a `🔒 CLAIM` comment, never an assignee, records that someone is building right now.
9. Return the issue link and applied labels.

## Epics

A request whose remedy spans several disjoint pull requests is an **epic**: file
one tracking issue plus one issue per slice. A [quality-scan](../quality-scan/SKILL.md)
finding always arrives in this shape.

The canonical shape is the repository's own epic template,
`.github/ISSUE_TEMPLATE/loop-epic.md` — read it and follow it rather than
inventing a layout. Filing through the API bypasses the template, so the rules it
encodes have to be applied by hand; that is what the rest of this section is for.

- **Label the tracking issue `epic`**, in addition to its `area:*` labels. An
  epic without the label is invisible to every epic-scoped query, including the
  one a reader uses to ask what epics are open.
- **Attach each slice as a GitHub sub-issue of the tracking issue**, not only as
  a checklist line in its body. [ship-next](../ship-next/SKILL.md)'s `epic=#<n>`
  selects the lowest-numbered open **sub-issue**; slices tracked only as prose
  resolve to nothing, so the epic cannot be shipped from the queue at all.
- **Attach each slice as you create it, not in a pass at the end.** The attachment
  is keyed on the issue's internal identifier — which is *not* its number, is
  returned when the issue is created, and is absent from the listing and search
  results you can get afterwards. Link while you still hold it; recovering it
  later means decoding pagination cursors to read an id the API will not name.
- **Keep the build-order list in the body as well.** Sub-issue links carry
  membership but not sequencing, and `ship-next` reads that list to decide what
  is blocked.
- File slices in build order where possible, so lowest-numbered-open matches the
  intended sequence.
- **Write the epic's `## Promotion checklist` section** (owner decision
  2026-09-08, #2767), from the slices' operator-step notes: one unticked box per
  operator step the epic depends on, each naming where it is done, plus one box
  for the epic's product verification — which runbook or QA scenario is run on
  `dev`, by whom, before promotion. Every box starts unticked. `ship-next`'s
  closeout reads this section with `scripts/ci/epic-promotion-checklist.mjs` and
  reports the epic ready to close only when every box is ticked, so an epic filed
  without it can never be reported ready in the way the template expects.
- **Do not put `code-quality` on the slices** — the epic's open sub-issues already
  are the queue for `epic=#<n>`, and that label is for the standalone queue
  (`loop-epic.md` states this; it is the one rule most easily lost when filing
  through the API). Backlog-only still applies to the epic itself.
- **Add a `## Method` block when the epic body carries measurements.** Code
  claims in the body follow the writer rule in step 1, so the epic body closes
  with the block that rule asks for:

````markdown
## Method
Measured on `origin/dev` @ `3d056b8f`.

- "migration 084 renames every `safe_*` column":
  `git show 3d056b8f -- packages/backend/migrations/084*`
- "the refusals ledger has one writer":
  `grep -rn "INSERT INTO payment_refusals" packages/backend/src | wc -l`
````

- **Post one spec-review verdict comment on the epic before partners are
  pinged.** For an epic whose body carries code claims, the § *Epic review* pass
  below ends with the captain posting this shape on the tracking issue:

````markdown
Spec-review verdict on `origin/dev` @ `3d056b8f`: 9 claims re-run, 8 reproduce,
1 wrong (fixed): "27 `-rgb` twins" measures 20 (`grep -rc "rgb(" packages/frontend/src/app`).
Open questions: whether refusal caps belong on the ledger or the agent card.
````

## Epic review

Once per epic, after the tracking issue and its sub-issues are created and
**before** `pending-review` is lifted (or before the epic is announced ready,
when no review label is used), the captain dispatches **one
[haven-reviewer](../haven-agent-workflow/SKILL.md) pass** with the spec-review
brief below. The role already exists
([`.agents/skills/haven-agent-workflow/references/reviewer.md`](../haven-agent-workflow/references/reviewer.md),
dispatched by `.claude/agents/haven-reviewer.md`) — no new agent file, and the
review runs in its own isolated tree per that role's rules. The brief is fixed
text so two sessions dispatch the same review:

> Re-run every claim in the epic body and each sub-issue against `origin/dev`
> at the commit the body names: every `file:line`, count, status list, schema
> and mechanism claim. Report each as *reproduces* / *wrong (with the measured
> value and command)* / *could not verify*. Then, for each sub-issue: name any
> lever that could break an installed client (SDK, signer, connector,
> credential file, env var), a live payment path, or a migration ordering; and
> list what the scope does not say that a builder would have to decide.
> Findings by severity; no edits; no issues filed.

The captain then has three obligations before the epic goes to partners:

1. **Fix** every *wrong* claim in the epic and sub-issue bodies.
2. **Resolve or state** every named lever and scope gap: settle it in the body,
   or record it as an open question for the partners.
3. **Post the verdict comment** on the epic: the verdict SHA, the corrections
   applied, and the open questions (shape in § *Epics* above).

The pass is **not** run for single tasks, and not for epics whose bodies carry
no code claims — a pure process epic says so in its body and skips this
section.

## Backlog And Shipping

- Default to backlog-only: do not add `code-quality`.
- When the requester passes `--ship` or clearly asks to ship now, add `code-quality` and continue with [ship-next](../ship-next/SKILL.md).
- To queue an existing backlog issue later, add `code-quality` or make it an epic sub-issue.

## Guardrails

- Do not fabricate requirements for money-path, authentication, authorization, or schema tasks.
- Do not write an unverified code claim into a body: every count and `file:line` comes from a command the body quotes at a named commit (step 1), and an epic goes to partners only after its one spec-review pass and verdict comment (§ *Epic review*).
- Keep generated and hand-written loop issues interchangeable.
- Prefer an editable, correctly shaped issue over speculative implementation detail.
