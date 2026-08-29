---
owner: "@AntonioSaaranen"
status: current
covers: []  # index and naming convention for the shard directory — it describes how shards are written, not any code path
last-verified: "2026-08-29" # #2188: merged shards are IMMUTABLE — new section states the correction mechanism for each of the three ways a shard goes wrong, and closes the wrong inference that shards have a `chain-reset` equivalent (they do not; the per-file model already is the compaction). Measured while writing it: editing a merged shard satisfies the satisfied-by gate for an unrelated money-path PR (exit 1 -> exit 0 on a one-character edit), so the rule has a mechanical reason, not only an attestation one. Convention/filename rules re-read against the gate and unchanged. Prior: #1789: release shards are named for the VERSION, not the PR number — the PR-number convention was unsatisfiable in principle (the gate blocks the PR until the shard exists, so the number cannot be known when the name is needed) and cost the 0.1.29-alpha.0 cut a wrong guess plus a correcting commit. Issue shards are unchanged; existing shards keep their names; the release/SKILL.md and scripts/README.md copies now say the same thing. Body re-read against the gate: the satisfied-by claim and the no-front-matter exemption still hold. Prior: created for #1366 — the sharded CASP verification log
---

# CASP verification log — sharded entries (#1366)

One file per money-path change, replacing the old append-at-EOF changelog in
[`casp-risk-guardrails.md`](../casp-risk-guardrails.md). The reason is
structural: every money-path PR must write its perimeter analysis, and when
all of them append to the same lines of one file, **any two concurrent PRs
conflict by construction** — on 2026-08-12 four PRs in a row went
CONFLICTING mid-CI on exactly those lines. A shard is a file no parallel PR
also edits.

## Convention

- **Filename:** `YYYY-MM-DD-<issue>.md` (the date you open the PR; the issue
  whose change you are analysing). Directory listing = chronology.
- **Filename, release PRs:** `YYYY-MM-DD-<version>-release.md`, e.g.
  `2026-08-22-0.1.29-alpha.0-release.md`. A release PR has **no issue**, so the
  ordinary rule has nothing to put in `<issue>`. The convention that grew in its
  place was the PR number — which does not exist until the PR is opened, and the
  shard has to exist *before* that, because the contract-doc coupling gate blocks
  the PR without it. That order of operations is circular, so cutting
  `0.1.29-alpha.0` meant guessing (`…-1782-release.md`, opened as **1783**) and
  paying a second commit to correct it ([#1789](https://github.com/d-hinders/Haven-AI/issues/1789)).
  The **version** is known before anything else happens — you pass it to
  `release:bump` — it is satisfiable up front, and it says more than either
  number: it names what shipped. Nothing validates a shard filename, so a wrong
  guess never fails anything; it just persists as a mislabelled compliance
  record. Existing shards keep their names — renaming a compliance log to match a
  new convention churns history for no benefit.
- **Content:** the same single-paragraph analysis the EOF entries carried —
  what changed, the authority/custody argument for why the CASP perimeter is
  unaffected (or how it narrowed), what is mutation-tested, ending with the
  verdict sentence (`Perimeter unchanged.` or stronger). No front-matter —
  shards are fragments of the parent contract doc, exempted in
  `validate-frontmatter.mjs`.
- **The gate:** `casp-risk-guardrails.md` declares
  `satisfied-by: docs/regulatory/casp-changelog/**` — the docs coupling gate
  accepts a PR that adds its shard here, without touching the parent doc.
  The DISCIPLINE is unchanged: every money-path change still writes its
  analysis; only the storage stopped colliding. The glob matches **any** changed
  file in this directory, including a modified one — see *Once merged, a shard
  is immutable* below for why that makes editing an old shard a gate hazard and
  not just a style question.
- **The parent doc** keeps the guardrails body and the historical EOF log
  (frozen as of 2026-08-12). Its `last-verified` now reflects genuine
  re-verification of the BODY claims (e.g. the weekly #1248 audit), not
  per-PR bumps.

## Once merged, a shard is immutable

A shard that has landed on `dev` is a compliance record, not a working note.
Do not edit it in place. Which correction mechanism applies depends on **when
the shard became wrong**, not on how wrong it is:

- **Stale via a later change** — it was true when written, and a subsequent PR
  invalidated it. The correction belongs in the **new** shard; the old one
  stays untouched. Shard-per-PR is already the structural equivalent of the
  `last-verified` chain — one shard *is* one dated entry — so there is no gap
  for an in-shard escape hatch to fill.
- **Wrong when written** — a genuine analysis error, describing the code as it
  stood at merge time. Still no in-place edit, for a stronger reason than
  tidiness: a merged shard may already be relied on as an attestation of what
  was checked. The correction is a **new dated shard** that quotes the wrong
  claim, says it was wrong and why, and states the correct fact. Rewriting the
  original would remove the evidence that the error was ever made.
- **Pure transcription defect** — a broken link, a typo'd issue number, mangled
  table syntax. Fixable in place: it is a rendering fault in *carrying* the
  claim, not a claim about the code. Land it in a PR that changes no money-path
  code, so the in-place edit cannot stand in for that PR's own shard — see the
  gate hazard below.

**The mechanical reason, which is sharper than the principle.** The gate that
`satisfied-by` drives asks only whether *some* changed file matches
`docs/regulatory/casp-changelog/**` — it does not ask whether that file is new.
So editing a merged shard **satisfies the blocking contract-doc gate for an
unrelated money-path PR**, and no new verification record gets written.
Measured on 2026-08-29 (#2188), holding one money-path edit fixed:

| Diff | `npm run docs:coupling` (strict) |
|---|---|
| money-path code only | **exit 1** — `BLOCKING: casp-risk-guardrails.md` |
| the same code + a **one-character** edit to an already-merged shard | **exit 0** |

The write that was supposed to be forced never happened, and nothing reports
it. That is why "correct it in a new shard" is the rule even when an in-place
fix would read better: the new file is what re-arms the gate.

**There is no `chain-reset` for shards, and there should not be.** The
`last-verified` chain has one ([`chain-integrity.mjs`](../../../scripts/docs/chain-integrity.mjs))
because that chain lives on a single line that must sometimes be compacted —
and `casp-risk-guardrails.md` itself declared `chain-reset(#1496)` for exactly
that reason: *its* entries became these shards. Reading that as precedent for
an in-shard escape hatch inverts it. The compaction the marker exists to
license is already what the per-file model gives you by default: one file per
entry, compacted by never having been concatenated. A shard needs no escape
from a chain it is not on.

## Example shard (`2026-08-12-9999.md`)

```markdown
- **#9999** — <one paragraph: what changed, why no new authority/custody/
  route, what refusals held, what is mutation-proven>. Perimeter unchanged.
```

## Example release shard (`2026-08-22-0.1.29-alpha.0-release.md`)

Same content requirements — only the filename rule differs, and the subject is a
version rather than an issue:

```markdown
- **Release 0.1.29-alpha.0** — <one paragraph: which issues the release carries,
  why publishing them moves no authority/custody/route surface, what the version
  bump itself touches (version strings and pins only)>. Perimeter unchanged.
```
