---
name: new-task
description: Capture a freeform Haven task as a well-scoped GitHub backlog issue with concrete acceptance criteria, likely files, surface labels, and money-path classification, reviewed before it is announced. The default route for EVERY issue an agent files — a user request, a follow-up from a PR review, a finding deferred out of a PR — never a bare `gh issue create`. Use when a user asks to create, record, file, or queue a new Haven task or issue, or when a session is about to file one; ship only when explicitly requested.
---

# New Task

Turn a freeform request into a loop-ready GitHub issue without implementing it.

**This is the default route for every issue an agent files** — a user's request,
a follow-up out of a PR review, a finding deferred from `ship-next`, a
quality-scan handoff. A bare `gh issue create` (or the GitHub integration's
create call) is the *mechanism* step 6 uses, not a substitute for the skill: an
issue filed around it skips the measurement rule, the prior-art sweep, the
backlog default and the § *Issue review* pass, and every one of those exists
because an issue filed without it went wrong. Exempt: issues that CI workflows
and scripts open by themselves (for example `guard-freshness`'s `ci-health`
issue, or the `docs-audit` and `promotion-digest` workflows), which record a
machine's observation, not an agent's judgement.

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
5. Check GitHub for a materially duplicate open issue.
   **GitHub is the source of truth for what is filed. It is not the only place a
   finding sits.** Also sweep [`docs/quality/scan-ledger.md`](../../../docs/quality/scan-ledger.md)
   and `docs/bug-reports/` for the same surface —
   `git grep -in '<surface keyword>' docs/quality/scan-ledger.md docs/bug-reports/` —
   because a quality-scan or a QA run records findings there *before* anyone files
   them, so they carry no issue number and no GitHub search can see them. Read the
   hit's **disposition** first: `rejected` and `accepted-as-debt` are decisions
   already taken, and re-filing one un-changed is nagging, not filing — only a
   worsening delta reopens it. Otherwise the hit is prior art: file that finding,
   citing the report and its identifier (`F2`, `B5` live in the report, not in the
   ledger entry), and record the issue on the ledger's **disposition line** — the
   entry itself is append-only history and is never edited.
6. Create the issue with the available GitHub integration. If no integration is available, use an authenticated `gh` CLI.
7. Apply every inferred `area:*` label and `money-path` when applicable. **Leave the issue unassigned** unless the requester asks to own it — both issue templates ship `assignees: []`, and a queue of unassigned issues is what the loop expects to read. Assignment records ownership; a `🔒 CLAIM` comment, never an assignee, records that someone is building right now. A PR that closes the issue clears every assignee on merge (#3177), so an assignee used for tracking does not survive the close.
8. Run § *Issue review* on the created issue, apply its corrections, and post
   the verdict comment. **Not optional, and not sized:** it runs on every issue
   this skill files, single task or epic, whatever its size or risk.
9. Return the issue link, applied labels, and what the review changed.

## Epics

A request whose remedy spans several disjoint pull requests is an **epic**: file
one tracking issue plus one issue per slice. Approved [quality-scan](../quality-scan/SKILL.md) structural findings use
this shape when they require multiple PRs; a one-PR improvement candidate
uses the standalone task workflow above. The scan handoff does not waive
prior-art checks, defect reproduction, or the backlog default.

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

  **Every box must be able to reach a ticked state truthfully (#2906).** A box
  records a **disposition** — *done*, or *waived / no longer applicable* with the
  reason and a link — not only a success. Two ways to write a box whose tick
  means nothing:

  - **A box that can never be true.** Epic #2906 was unclosable for five days
    because a waived operator step stayed phrased as "O3 dual-read proof recorded
    on this issue". The owner had waived O3; no amount of work could make that
    sentence true, so the checker reported not-ready forever while evidence piled
    up in comments the checker does not read. When a step is waived or stops
    applying, **rewrite the box to state that and tick it** — the tick records
    that the question was answered, not that the work happened.

    **A session RECORDS a waiver; it never MAKES one.** The rewritten box names
    who waived the step and links the comment where they did — in #2906 that was
    the owner, on 2026-09-14. A session may not both decide and record a waiver
    in one act, and "no longer applicable" is the term a motivated session would
    reach for, because an epic's scope can always be narrated so a step stopped
    applying. Without a named waiver-holder this rule is a tick-by-declaration
    route to closing any inconvenient epic, which is worse than the problem it
    fixes. The surrounding rule already says the epic stays open until a **human**
    ticks the last box; this does not weaken it.
  - **A box that is already true.** A box asking that a command "runs without a
    flag" when it already does is ticked on unchanged code and measures nothing.
    Write each box so it is **false today and true only when the work is done**.

  Where a slice may legitimately ship nothing — a decision-first slice whose
  honest outcome is "documented, no code" — write the box so that outcome is
  tickable; otherwise the epic hangs on a release that will never be cut.
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
  pinged.** The § *Issue review* pass below ends with the captain posting this
  shape on the tracking issue (a single task gets the same comment on itself):

````markdown
Spec-review verdict on `origin/dev` @ `3d056b8f`: 9 claims re-run, 8 reproduce,
1 wrong (fixed): "27 `-rgb` twins" measures 20 (`grep -rc "rgb(" packages/frontend/src/app`).
Open questions: whether refusal caps belong on the ledger or the agent card.
````

## Issue review

**Every issue this skill files gets one independent review before it is
announced, queued or shipped** — a single task and an epic alike, with no size,
risk or "docs-only" exemption. A per-issue test of whether the review is worth
running is the conditional the owner already rejected for pull requests
(CLAUDE.md, 2026-08-21); this rule extends the same decision to issues.

**Why it is mandatory (2026-09-24).** It used to run for epics only ("not run
for single tasks"). On 2026-09-24 three single tasks were filed with every
figure measured at a named commit — #3264, #3266, #3267 — and a review of each
still found material defects in all three, none of which measurement catches:
seven missed copies of the stale claim being fixed; an acceptance criterion that
capped the diff at two files and so forbade the fix; a criterion whose grep also
matched an unrelated word ("fail-safes") that nothing in the scope could remove;
a rename that would have made three "retired names must stay gone" guard tests
vacuous; test fixtures that already passed without exercising anything; a
caller list that named three wrong files; and an open question with a real
answer (a fail-open path that still gates multi-replica). The measurement rule
in step 1 proves the figures; this pass proves the *scope* and the *criteria*.
The three reviews ran in parallel in under two minutes each.

**When.** After the issue (or the epic and its sub-issues) is created, and
**before** any of: `code-quality` is added, a `--ship` hands off to
[ship-next](../ship-next/SKILL.md), `pending-review` is lifted, or the issue is
announced to partners. An issue the loop can select before its review has run
has skipped it.

**Who.** The captain dispatches **one
[haven-reviewer](../haven-agent-workflow/SKILL.md) pass per issue** (per epic:
one pass covering the tracking issue and every sub-issue) with the brief below.
Several issues filed together are reviewed in parallel. The role already exists
([`.agents/skills/haven-agent-workflow/references/reviewer.md`](../haven-agent-workflow/references/reviewer.md),
dispatched by `.claude/agents/haven-reviewer.md`) — no new agent file, and the
review runs in its own isolated tree per that role's rules. The brief is fixed
text so two sessions dispatch the same review:

> Re-run every claim in the issue body (for an epic, the tracking issue and
> each sub-issue) against `origin/dev` at the commit the body names: every
> `file:line`, count, status list, schema and mechanism claim, reading the
> statement that does the work, not the comment above it. Report each as
> *reproduces* / *wrong (with the measured value and command)* / *could not
> verify*. Then:
> 1. **Completeness** — find every other copy of the claim or pattern the issue
>    fixes (code, comments, env examples, docs, tests, skill text) and list the
>    ones the scope misses; name the historical records (CASP shards, archive,
>    ledger entries) that must stay as written.
> 2. **Criteria** — for each acceptance criterion: is it false today, reachable
>    when the work is done, and impossible to satisfy while the problem
>    survives? Flag a criterion that forbids the fix, matches something
>    unrelated, or is already true.
> 3. **Guards** — would the change as scoped weaken a test, lint or guard (a
>    rename inside a "must stay absent" test, a fixture or route the code no
>    longer reads)? Name any test that already passes without exercising what
>    its name claims.
> 4. **Levers** — name anything that could break an installed client (SDK,
>    signer, connector, credential file, env var, persisted browser storage), a
>    wire field, a live payment path, or a migration ordering.
> 5. **Gaps** — list what the scope does not say that a builder would have to
>    decide, and answer any question the issue poses where the code answers it.
>
> Findings by severity (blocking / should-fix / nit); no edits; no issues filed.

The captain then has three obligations before the issue is queued or announced:

1. **Fix** every *wrong* claim and every blocking or should-fix finding in the
   body — re-measured by the captain at a named SHA, never copied from the
   reviewer's wording.
2. **Resolve or state** every named lever and scope gap: settle it in the body,
   or record it as an open question for the requester or partners.
3. **Post the verdict comment** on the issue (for an epic, on the tracking
   issue): the verdict SHA, the corrections applied, and the open questions
   (shape in § *Epics* above). The comment is the record that the review ran.

A body with no code claims still gets the pass — the claim re-run is empty, but
completeness, criteria and gaps are not.

## Backlog And Shipping

- Default to backlog-only: do not add `code-quality`.
- When the requester passes `--ship` or clearly asks to ship now, run § *Issue review* first, then add `code-quality` and continue with [ship-next](../ship-next/SKILL.md).
- To queue an existing backlog issue later, add `code-quality` or make it an epic sub-issue.

## Guardrails

- Do not fabricate requirements for money-path, authentication, authorization, or schema tasks.
- Do not write an unverified code claim into a body: every count and `file:line` comes from a command the body quotes at a named commit (step 1), and no issue — single task or epic — is queued, shipped or announced before its § *Issue review* pass and verdict comment.
- Do not file around this skill. Every agent-filed issue goes through it; a bare `gh issue create` is only the mechanism of step 6.
- Keep generated and hand-written loop issues interchangeable.
- Prefer an editable, correctly shaped issue over speculative implementation detail.
