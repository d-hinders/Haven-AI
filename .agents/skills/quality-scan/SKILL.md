---
name: quality-scan
description: Repeatable code-quality scan — reports up to two structural findings and up to five bounded improvement candidates, with measured evidence and explicit coverage limits, then stops for a human decision. Never implements, never files on its own; approved findings hand off to new-task.
---

# Quality Scan

Sweep the codebase and report **Structural findings** (zero to two) and
**Improvement candidates** (zero to five), with hard evidence and coverage
limits, then stop. Neither section is a quota. This skill exists to make an occasional,
high-altitude scan repeatable — same method every run, and a ledger that
remembers what earlier runs found and what was decided, so standards escalate
instead of resetting to whoever happens to run it.

It does **not** implement anything, and it does **not** file issues on its own.
On explicit approval, append the decision to the ledger and hand off to
[new-task](../new-task/SKILL.md): one-PR candidates become standalone tasks;
multi-PR structural work follows its **Epics** section for tracking and slices.
Approval to file is not approval to implement or ship.

## References

- [`references/dimensions.md`](references/dimensions.md) — the numbered wave
  dimensions a run probes, numbered. `Probed clean:` cites these by number.
- [`references/discovery-method.md`](references/discovery-method.md) — the
  code-quality discovery method: how to run a pass, the discovery prompts, the
  coverage summary and the verification baseline. Moved here from
  `docs/contributing/code-quality-loop.md` by #2640 so the method sits with the
  skill that performs it. Read it before a full-repository sweep.

## Scope

Bare invocation sweeps the whole repository. An argument narrows it:
`quality-scan packages/frontend` or `quality-scan --area=backend` scans only
that surface, judged by the same bar.

## The ledger (read it FIRST)

`docs/quality/scan-ledger.md` records every run: date, scope, findings, and
each finding or candidate's **disposition** — `shipped`, `accepted-as-debt`, or `rejected`,
with the reason. Before scanning:

1. Read the ledger and collect every prior finding and candidate, including
   pending decisions, and each disposition.
2. **Exclude prior findings and candidates from both output levels** — including
   `accepted-as-debt` ones. A conscious decision to live with something is a
   decision; re-surfacing it un-changed is nagging, not scanning.
3. The one exception: evidence that a prior finding has **materially
   worsened**. Then report it, say explicitly that it is a re-surface, and
   cite the delta against the ledger's recorded numbers ("was 1,059 positional
   mocks at 2026-07; now 1,730").

After a run, append the new entry (date, revision, scope, both output levels,
coverage, and dispositions once decided). Mark undecided items pending owner
decision. Append later decisions and issue links; never maintain task progress
or build-order queues here. GitHub owns implementation tracking. The ledger is committed history — never rewrite old entries.

**The ledger is read back as prior art, not only by the next scan.**
[new-task](../new-task/SKILL.md) sweeps it — and `docs/bug-reports/` — before
filing, because a finding recorded here carries no issue number and no GitHub
search can see it. Until someone files it, this entry is the only record that
the defect is known; a reader who rediscovers it live will otherwise file a
sibling. So name the surface precisely enough to be matched on: the file or
tool at fault, not just the theme. (#2968 duplicated the 2026-09-13 scan's F2
30 hours after it was recorded.)

Two conventions make an entry re-measurable by a future run (the ledger header
also records a third — disposition upkeep — owned by
[ship-next](../ship-next/SKILL.md)'s closeout, not by this skill):

- **Measurement blocks.** Every evidence number is written as
  `command → number` (or names the script/ratchet that produced it). The bar
  already requires reproducibility; recording the command is what makes the
  exclusion rule's "cite the delta against the recorded numbers" a one-command
  check instead of a reconstruction. The only prior finding that could be
  re-measured cheaply was the one a ratchet happened to exist for — and the
  db-mock ratchet's own history shows ad-hoc recounting goes wrong (it once
  counted the pattern's name inside a comment). Name an existing instrument
  first (`scripts/ci/*`, `scripts/docs/*`, a ratchet); a new script only when
  none exists, and then it lives with its kind under `scripts/ci/` or
  `scripts/docs/` — there is no `scripts/quality/`.
- **Coverage record.** Keep the `Probed clean:` heading for continuity, but
  treat it as a coverage record, not a blanket clean verdict. For each dimension
  use `dimension → examined / partial / not examined → revision, command and
  result → sample boundaries → missing verification and reason`. Do not invent
  a zero for an unexecuted check. `examined` means the declared sample was
  actually inspected; it never means the whole repository was proven clean.
- **Wave-dimension coverage (#2501).** Name every current numbered block in
  [the dimensions reference](references/dimensions.md), including blocks that
  produced a finding or candidate. Record other probes in the same format.
  Partial and unexamined areas remain visible in the final report. In
  particular, “no new structural finding” says nothing about the candidate
  section or an unexecuted mutation sample.

## Structural findings — the existing strict bar

A structural finding qualifies **only if all five hold**:

1. **Structural, not a defect list.** It names a pattern; "N instances of a
   bug" is triage, not a finding.
2. **Measured evidence.** Counted ratios, file/line counts, grep tallies —
   never impression. Every number in the report must be reproducible from the
   command that produced it.
3. **Demonstrated cost.** A past incident, a recurring workaround, a
   documented failure mode, or a tax visible in the codebase's own comments.
   If nothing has ever hurt because of it, it has not met the bar yet.
4. **Changes how contributors work** — not just how the code reads.
5. **Splittable** into parallelisable, disjoint slices a partner can pick up
   cold.

One-PR remedies do not qualify as structural findings; evaluate them under
**Improvement candidates** instead.

## Improvement candidates — bounded, evidence-backed opportunities

Report at most five concrete opportunities. For each, state:

- **Opportunity and evidence:** the affected surface, a named revision, and
  reproducible commands/results or the existing instrument. Evidence must
  demonstrate a failure mechanism or measurable contributor burden. A past
  incident is not mandatory. Label any untested hypothesis and distinguish
  it from what was observed; speculation alone does not qualify.
- **Expected benefit:** the specific risk or contributor cost the change
  reduces, not just how it would make the code look.
- **Approximate scope:** likely files/boundaries and whether it fits one PR
  or needs multiple PRs; do not manufacture an epic for a small improvement.
- **Verification still needed:** the focused test, mutation, comparison or
  review that would establish the benefit and preserve existing behavior.

For both levels, exclude cosmetic preferences, lint-only nits, speculative
abstractions, dependency bumps alone and generic “add tests” suggestions.
An empty section is valid; do not pad it. Briefly explain refusals only when
both sections are empty. Check existing GitHub tracking and local prior art
(the ledger and bug reports, per new-task) before calling an opportunity new;
link already-tracked work as context rather than presenting it as a new item.
If tracking cannot be checked, disclose that limit and mark novelty unverified.

## Method

1. Read `docs/quality/scan-ledger.md`; collect prior findings + dispositions.
2. Size the repo: lines per package, largest files, per-layer
   source-vs-test ratios.
3. Probe the dimensions where structural problems live: test architecture and
   what is mocked away; validation and contract enforcement; data-layer
   coverage; cross-package duplication; fat controllers; `any` density;
   **incident clustering** — group the recent issue history by failure class
   and count recurrence over time (the method the 2026-08-18 outbound finding
   used by hand: 6 issues in the class in 7 weeks); and **workflow
   archaeology** — rerun frequency per CI check, rerun/flake mentions in
   commits and PR comments, checks that pass only on retry. Read qa-dev at
   the `money-flow` **job** level, never the run conclusion: most qa-dev runs
   are gate-skipped `deployment_status` runs that still conclude `success`
   (#3348). The harness's in-step retry never moves `run_attempt`, so count
   it from the job log's `money-flow QA passed on attempt 2/2` line. Runtime-UX stays
   out of scope: that class surfaces through external testing (epic #1585's
   origin), not repo scanning. Then take the numbered **wave dimensions** — the
   classes the 600-issue wave was measured to consist of — each as its
   numbered block in [`references/dimensions.md`](references/dimensions.md),
   which states the command, the sample and what clean looks like, so the
   number is quotable as evidence or as a `Probed clean` baseline:
   1. **Guard falsifiability by execution** — mutate what a sampled guard
      claims to pin and run it; report survivors with one of three diagnoses
      (weak test / dead code / not load-bearing at the tested condition). This
      is the #1602 *guard effectiveness* dimension made executable, under its
      ledger name (#2307, #2044, #2444).
   2. **Contract-doc `covers:` completeness** — paths the body cites vs the
      declared `covers:`, both directions (#2425).
   3. **Stale numbers in prose** — re-derive every quoted figure from its
      instrument; a figure without a command is the finding (#2421, #2423).
   4. **Retired-vocabulary residue** — the last removal epic's terms and its
      dead exports, with a positive control and a live/historical partition
      (#1440, #1993, #2107).
   5. **Merge-method drift on `dev`** — first-parent landings by subject
      shape and head prefix, sync-backs apart; remedy is a one-line ruleset
      edit, so this yields a baseline or a `new-task`, never an epic (#2165).
   6. **Nets with holes** — each gate's allowlist vs the content class it
      checks, and each gate's green-without-running exit branches. This is
      the *CI gate coverage vs. what is actually exercised* dimension made
      concrete (#2317, #2088, #2300, #1044).

   **When the scope asks for a live exercise.** "Runtime-UX stays out of
   scope" above means the scan does not hunt UX defects by clicking through a
   product; a scope that asks for the live dev environment to be exercised
   (the 2026-09 mandate did, three runs running) brings those calls in. Two
   rules then, because the live runtime and the tree are different things:

   - **Record every runtime's identity before the first call**, with the
     command that produced it: the tree (`git rev-parse HEAD`), each local
     package as installed (for the signer,
     `~/.haven/agents/<slug>/signer-runtime.json`, or the connector's doctor),
     what is published (`npm view @haven_ai/<pkg> dist-tags`), and each hosted
     service's deployed revision where one can be read (`railway status
     --json`, a deployment record) — or the words "not determinable", which
     is a coverage limit, not a gap to fill by assumption.
   - **A claim about what the tree DOES comes from a tree instrument that
     was run** — a test that pins the behaviour — not inferred from a source
     reading or from what the live runtime did. (Citing `file:line` for what
     the source SAYS is fine; inferring what it does at runtime is not.) The 2026-09-21
     report recorded the runtime identity correctly (a 2026-09-15 dev build of
     the signer, against a newer dev dist-tag), then wrote that the tree's
     `sign-context.ts` sets exactly what the stale runtime returned. It does
     not: the tree emits `next_tool_name`, and a pin in
     `packages/signer/src/next-step-characterization.test.ts` says so. A
     source reading stood in for the instrument that was one command away.

   Live calls stay read-only unless the owner authorises one, and a refusal
   proves reachability as well as a success does.

4. Read the comment archaeology: `TODO`s, issue-number references, and
   repeated warning comments are where a codebase names its own recurring
   pain. A warning copy-pasted across files is a structural finding announcing
   itself.
5. Evaluate opportunities against the appropriate output level; preserve
   the ledger exclusions for both. Check tracking before presenting new work.
6. Report **Structural findings** (up to two): evidence, demonstrated cost,
   and disjoint proposed slices. Report **Improvement candidates** (up to
   five) using the fields above. Include the coverage record and qualify
   conclusions to the sample actually examined.
7. Append the run to the ledger and open the report and the entry as a pull
   request. **Run its independent review before presenting anything for
   decision** — the `haven-reviewer` pass `CLAUDE.md` § *How shipping is
   governed* makes mandatory on every pull request, briefed explicitly to
   re-derive every figure and every claim about a past event from its
   instrument or its artifact at the SHA (`git show <sha>:<path>`). That is
   the scan's own dimension 3 applied to the scan, and neither review role
   does it unbriefed. Apply what it finds — the entry is still unmerged, so
   correcting it in place does not touch the append-only rule — and present
   the findings at the reviewed SHA, a corrected figure stated as corrected.
   **It costs the owner time, and that is the trade:** on 2026-09-21 the owner
   acted on its decision at 14:24:21Z (the first filing), at least 26 minutes
   56 seconds before the report's last reviewed commit (`702fe38e`,
   14:51:17Z, bound in the third review round) — on a report carrying a `covers:` figure of 21 against
   a true 7 (caught only because `new-task` re-measured before filing), an
   in-scope residue count of 10 against a true 16, and a claim about the tree
   read off a stale runtime. Then **stop for the human decision**, and record
   it in a **separate** ledger pull request: appending it to the reviewed one
   voids the verdict for the file it binds. That run appended its decision to
   the scan's own pull request (#3212, `958ac624`), and its review started at
   that commit — after the decision; #3218 shows the separate shape, used for the same entry's later
   `shipped` disposition. On
   explicit approval to file, append the decision and hand off to
   [new-task](../new-task/SKILL.md), preserving its filing checks and backlog
   default. Do not file an unverified defect as though it were reproduced.
   Use a standalone task for one-PR work and **Epics** for multi-PR work.
   Return the issue link and the appropriate drive command (`ship-next <n>`
   or `ship-next epic=#<n>`); providing the command does not execute it.

## Worked example (the run that motivated this skill)

The scan that produced the real-DB testing epic, as the reference shape:

- **Sizing:** a source-vs-test ratio table per layer showed the data layer as
  the thinnest-tested, heaviest-mocked stratum.
- **Measured evidence:** 1,059 positional DB mocks
  (`mockResolvedValueOnce`-chains against `db.query`) counted across the
  backend route tests.
- **Cost from comment archaeology:** the `#775` workaround comment ("adding a
  query re-shuffles every chain") copy-pasted across 8 files, the `#757`
  incident, and the partial `#773` guard — the codebase had already named its
  own pain three ways.
- **The unlock:** CI already ran Postgres in the same job, so a real-DB
  harness cost no new infrastructure.
- **Slicing:** harness first (blocks the rest), then per-repository
  conversions as disjoint slices, then a shrink-only ratchet so the pattern
  cannot grow back.

That is the altitude: one pattern, four kinds of evidence, a cost the repo had
already documented about itself, and a slicing a partner could execute cold.

## Output examples

These are hypothetical teaching examples, not findings about this repository.
A real report must replace the fixture revision and results with its own evidence.

- **Preventive one-PR candidate:** in a fixture at revision `example-A`,
  `git grep -n 'retryDelay' example-A -- fixture/` identifies two independent
  retry-delay implementations; reading both shows the same formula. A
  comparison test at that revision agrees on ordinary and boundary inputs.
  No outage is known. The observed burden is that one delay-policy change
  requires editing and reviewing both implementations. Candidate: extract the
  shared pure calculation, keeping caller-specific retry decisions local.
  Scope: the two callers and a helper, one PR. Benefit: eliminate the second
  policy edit. Verification still needed: run both callers' characterization
  tests with the extraction and check that their differing stop conditions
  remain unchanged. This qualifies on observed contributor burden; it does
  not claim an unobserved production defect.
- **Rejected cosmetic suggestion:** “rename the helper because the new name
  reads better.” No failure mechanism or contributor burden is demonstrated;
  it belongs in neither output level.
- **Partial scan:** “Structural findings: none in the examined sample.
  Improvement candidates: none established. Block 1 → partial → revision
  `example-B`, the reference's candidate-census command identified tests →
  latest first-parent money-path sample → mutation execution missing because
  Vitest was unavailable.” Do not substitute “zero surviving mutations” or
  describe the money path as clean. Other dimensions still need their own
  examined/partial/not-examined rows.

## Cadence

Manual only — no cron, no CI wiring, no cadence doc. Findings at this
altitude do not accumulate weekly, and a schedule would bias the scan toward
small findings to have something to report.

The natural invocation points, kept as heuristics rather than schedule: when
the `ship-next` queue runs empty, or when a scan-born epic just closed. Both
mark a real capacity-and-context moment — the codebase just absorbed a wave of
change, and there is room to decide what the next one should be.
