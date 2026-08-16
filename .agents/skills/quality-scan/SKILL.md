---
name: quality-scan
description: Repeatable structural code-quality scan — sweeps the repo for the one or two biggest structural weaknesses, reports them with measured evidence, and stops for a human decision. Never implements, never files on its own; approved findings hand off to new-task.
---

# Quality Scan

Sweep the codebase for its **one or two biggest structural weaknesses**, report
them with hard evidence, and stop. This skill exists to make an occasional,
high-altitude scan repeatable — same method every run, and a ledger that
remembers what earlier runs found and what was decided, so standards escalate
instead of resetting to whoever happens to run it.

It does **not** implement anything, and it does **not** file issues on its own.
On explicit approval of a finding, append the disposition to the ledger and
hand off to [new-task](../new-task/SKILL.md) to create the epic and its slices —
following its **Epics** section, which is what gets the `epic` label and the
sub-issue links right. A finding filed without those is a tracking issue nothing
can query and `ship-next` cannot pull from.

## Scope

Bare invocation sweeps the whole repository. An argument narrows it:
`quality-scan packages/frontend` or `quality-scan --area=backend` scans only
that surface, judged by the same bar.

## The ledger (read it FIRST)

`docs/quality/scan-ledger.md` records every run: date, scope, findings, and
each finding's **disposition** — `shipped`, `accepted-as-debt`, or `rejected`,
with the reason. Before scanning:

1. Read the ledger and collect every prior finding and its disposition.
2. **Exclude prior findings from this run's report** — including
   `accepted-as-debt` ones. A conscious decision to live with something is a
   decision; re-surfacing it un-changed is nagging, not scanning.
3. The one exception: evidence that a prior finding has **materially
   worsened**. Then report it, say explicitly that it is a re-surface, and
   cite the delta against the ledger's recorded numbers ("was 1,059 positional
   mocks at 2026-07; now 1,730").

After a run, append the new entry (date, scope, findings, dispositions once
decided). The ledger is committed history — never rewrite old entries.

## The bar (the core of the skill — say no to small things)

A finding qualifies **only if all five hold**:

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

**Refuse and do not report:** lint-level nits, cosmetic refactors, dependency
bumps, "add tests here" without a structural thesis, and anything whose remedy
is one PR — that is a `new-task`, not an epic. State the refusals only if the
scan would otherwise be empty, so the emptiness is explained.

## Method

1. Read `docs/quality/scan-ledger.md`; collect prior findings + dispositions.
2. Size the repo: lines per package, largest files, per-layer
   source-vs-test ratios.
3. Probe the dimensions where structural problems live: test architecture and
   what is mocked away; validation and contract enforcement; data-layer
   coverage; cross-package duplication; fat controllers; `any` density; CI
   gate coverage vs. what is actually exercised.
4. Read the comment archaeology: `TODO`s, issue-number references, and
   repeated warning comments are where a codebase names its own recurring
   pain. A warning copy-pasted across files is a structural finding announcing
   itself.
5. Filter every candidate through the bar. Discard the rest silently.
6. Report the **top 1–2** findings: evidence tables, the demonstrated cost,
   and a proposed slicing into disjoint sub-issues.
7. **Stop.** Wait for the human decision. On approval: append the ledger
   entry, then hand off to [new-task](../new-task/SKILL.md) § *Epics* for the
   tracking issue and its slices.

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

## Cadence

Manual only — no cron, no CI wiring, no cadence doc. Findings at this
altitude do not accumulate weekly, and a schedule would bias the scan toward
small findings to have something to report.
