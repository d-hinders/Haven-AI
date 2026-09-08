---
owner: "@d-hinders"
status: current
covers:
  - packages/cli/src/args.ts
  - packages/cli/src/commands.ts
  - packages/backend/src/index.ts
  - packages/mcp/src/tools.ts
  - packages/qa-agent/src/lib/delegation-budget.ts
  - .agents/skills/ship-next/SKILL.md
  - .agents/skills/haven-agent-workflow/references/reviewer.md
  - .agents/skills/haven-agent-workflow/references/doc-reviewer.md
  - .agents/skills/haven-agent-workflow/references/design-reviewer.md
  - docs/contributing/ai-agent-workflow.md
  - docs/contributing/ai-review-patterns.md
  - docs/bug-reports/qa-explore-agent-onboarding-2026-09-06.md
last-verified: "2026-09-06"
verified:
  - "New document. Every repository figure below was re-derived at `f8a7311c` while writing, and the command that produces it sits next to it. The four session counts (five rewrite defects, four instrument lies, three dangling half-sentences, two surviving mutations) are hand-counted from one session and say so; they are not derivable from the repository and are not presented as if they were. The one reproduction in § *The instrument lied* was run at `f8a7311c` and its output is quoted verbatim, with the caveat stated inline that a worktree list is machine-local and only the column disagreement generalises. NOT verified here: the pre-#2608 rejection behaviour of the five MCP tools, which is why § *Rewriting text you have just read* item 5 states the generalisation defect and not a per-tool count. One figure was REMOVED after review rather than caveated — a commit-count for the stale checkout in § *The instrument lied* item 3 — because it had no instrument, and the document's own H2 says an un-derived number does not get to stand next to derived ones. Four findings from the independent pass are folded in: the `covers:` gap on `design-reviewer.md` (this doc makes a claim about its content), the H2 row naming one home when the rule landed in three, two branch names quoted as substrings rather than in full, and that removed figure."
---

# The one-session retrospective (2026-09-06)

On 2026-09-06 sixteen pull requests landed on `dev` and ten issues closed:

```bash
gh pr list --state merged --limit 40 \
  --json number,mergedAt -q '[.[]|select(.mergedAt|startswith("2026-09-06"))]|length'   # 16
gh issue list --state closed --limit 40 \
  --json number,closedAt -q '[.[]|select(.closedAt|startswith("2026-09-06"))]|length'   # 10
```

This document is not about that number. It is about the fourteen defects the
day produced, because they fall into four shapes and the largest one is not
the shape anybody guards against.

The sibling record [`issue-retrospective-2026-09.md`](issue-retrospective-2026-09.md)
classified 600 issues over three weeks and found `false-instrument` second
only to `logic-bug`. This document covers one session and finds the same
family from the inside: not "a check that could not fail" written into the
repository, but a check that could not fail **being used, live, to decide what
to write next**.

## Method, and its limit

The repository figures are re-derived, with their commands. The defect counts
are not: they were read out of one session's own history by hand, the way the
600 were read by hand. Nothing in `git` distinguishes "a false sentence caught
in review" from "a sentence that was always right", so those four numbers are
a count of what one reader found and no instrument can confirm them. They are
useful for their **shape**, not their magnitude.

## 1 — Rewriting text you have just read

**Five defects. Every one of them was introduced while correcting a different
false claim.** That is the whole finding: the act of fixing a wrong sentence
is itself the highest-risk moment in the session, and it is unguarded because
it looks like the safe part of the work.

1. **The CLI default (#2591).** The draft said the CLI defaults to
   `localhost`. It does not:

   ```bash
   grep -rn 'DEFAULT_API\s*=' packages/cli/src/
   # packages/cli/src/commands.ts:22  a production Railway URL
   ```

   The sentence came from a stale `--help` output read minutes earlier — in
   the same session that was rewriting `--help` **because it was stale**
   (#2590). The false sentence was also the more dangerous of the two: it
   tells an operator that an omitted `--api` is inert, when an omitted `--api`
   reaches production.

2. **The chain parenthetical (#2596).** The change existed to stop the served
   artifacts asserting a chain, and the draft's own explanatory aside —
   "(Base in production, Base Sepolia on a test deployment)" — was a bare
   chain assertion. The endpoint reports two lists precisely because neither
   is a constant:

   ```bash
   grep -n 'deployable: deployableChainIds' packages/backend/src/index.ts
   # packages/backend/src/index.ts:223  { deployable, supported }
   ```

3. **`--force` (#2601).** The draft instructed
   `git worktree remove --force`. Both halves were reproduced before the doc
   shipped: plain `remove` refuses a root holding modified or untracked
   files; `--force` deletes them. The same file invites a reviewer to leave a
   patch in that root, so the convenient flag would have destroyed the work
   the instruction was written to preserve. What shipped drops `--force`, so
   git's refusal is the guard and nobody has to remember the rule —
   `reviewer.md`, `doc-reviewer.md`, `design-reviewer.md`,
   `ship-next/SKILL.md` and `ai-agent-workflow.md` all say `remove` bare.

4. **"Zero run reports" (#2538).** Written while my own run report was
   already merged in the base, and had already produced two filed issues:

   ```bash
   git log --diff-filter=A --format='%h %s' -1 \
     -- docs/bug-reports/qa-explore-agent-onboarding-2026-09-06.md
   # b8bdb791 feat(2538): the cold-agent onboarding scenario, on the cadence (#2592)
   ```

5. **"Byte-identical" (#2366).** The draft said the five MCP tools rejected
   the undeclared key spelling identically. That was read off **one** tool and
   written about five. It is also unsettleable by reading: the MCP SDK strips
   undeclared keys before a handler runs (#2312), so the source text of a
   handler cannot tell you what an undeclared argument does. The claim needed
   `client → InMemoryTransport → server`, per tool, and had none.

The common mechanic in all five: a correction reuses the wording, the shape or
the confidence of the text it is replacing, and inherits a claim that was
never checked because it arrived looking already-checked.

## 2 — The instrument lied

**Four times.** Each was caught, and each would have produced a confident,
false report if it had not been.

1. **The probe printed its own input.** A command invoked with a value echoed
   that value in its usage banner, so grepping its output for the value
   matched the invocation, not a leak. The instrument answered a question
   about itself.
2. **The grep matched branch names.** Counting review roots by grepping
   `git worktree list` counts branches too. Reproduced at `f8a7311c`:

   ```bash
   git worktree list | grep -c review                       # 2
   git worktree list | awk '{print $1}' | grep -c '/review'  # 0
   ```

   Both hits are branch names — `docs/2499-doc-reviewer-claim-derived-scope`
   and `docs/2500-ship-next-build-so-review-finds-less`. The
   count was of the wrong column. **These two numbers are machine-local** —
   a worktree list is not in the repository, so another reader will get
   different values. What reproduces is the disagreement between the columns,
   not the magnitudes — the independent review pass on this document re-ran
   both commands and got `3` and `1`, which is the caveat working rather than
   failing.
3. **The checkout was stale.** Twice, a local read was about to be reported
   as "the code is not there". The code was there; the tree was old — a
   `grep` over a stale worktree is a measurement of the past, and its "not
   found" is indistinguishable from a real absence. *A commit-count for that
   staleness was quoted during the session and is deliberately not repeated
   here: it was never instrumented, and this document is the wrong place to
   carry an un-derived number.*
4. **The issue search returned a hit I did not see.** The instrument was
   right and the reading was wrong, which is the failure mode no positive
   control catches.

Three of the four are the **same** defect wearing different clothes: the
instrument answered a question adjacent to the one asked, and the answer was
well-formed enough to pass for the real one. This is why the discipline is a
measurement discipline and not a review routine — a reviewer reading my prose
sees a plausible number, not a mis-aimed grep. It has been added to
[`ai-review-patterns.md`](ai-review-patterns.md) § *Instrument Self-Reference
And Staleness*.

## 3 — The dangling half-sentence

**Three times, in three files, after I had already noticed it.** Replace the
head of a sentence, leave its tail describing the old head: the
`last-verified` chain tail, the `08-local-vs-hosted-mcp.md` tail, and the
`--force` doc.

This is the only defect in the session that I **repeated after seeing it**,
which makes it the most instructive one here. Noticing a pattern did not
prevent its next instance; the two later ones were written after the note
existed. A pattern that lives only in a session's attention is not a control.
The mechanical form is cheap and is what the rule should be: after editing a
sentence, re-read it to its full stop, in the rendered file, not in the diff —
a diff shows the changed line, and the tail is usually on the next one.

## 4 — The surviving mutation

**Two guards were mutated and did not fail.** #2594's caller choice
(`use: 'ceiling' | 'floor'` in `packages/qa-agent/src/lib/delegation-budget.ts`)
was pinned nowhere, and #2366's per-tool wiring in `packages/mcp/src/tools.ts`
was unpinned. Both are now asserted on behaviour.

Nothing new — this is guideline A1 from the 600-issue retrospective doing its
job. It is recorded because the rate matters: two survivors in one session,
in code written *by an agent that knew the rule*, is the argument for the
mutation being mandatory rather than advised.

## What this changes

| | Rule | Where it lands |
|---|---|---|
| **H1** | A correction is a new claim. Verify the replacement sentence against its instrument, never against the sentence it replaces — including when the old sentence is the thing you are fixing. | This document; `ai-review-patterns.md` § *Instrument Self-Reference And Staleness* |
| **H2** | Before a "none found", check that the instrument is looking at the column, the tree and the process you mean. A grep over `git worktree list`, a stale checkout, and a command that echoes its own arguments all return well-formed wrong answers. | All three of the lists this repository keeps in sync: `ai-review-patterns.md` § *Instrument Self-Reference And Staleness*, the Captain Self-Check Preflight in `ai-agent-workflow.md`, and the canonical reviewer role's must-check list |
| **H3** | After editing a sentence, read it to its full stop in the rendered file. The tail that describes the old head is on the line the diff does not show. | This document |

H1 and H3 are stated here and not yet mechanised anywhere: neither is checkable
by a script, and claiming otherwise would be this document committing its own
finding. H2 is the one with a home, because "prove the instrument can say yes"
already had one (guideline A3) and this only widens what counts as the
instrument.
