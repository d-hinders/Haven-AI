---
owner: "@AntonioSaaranen"
status: current
covers: []  # index and naming convention for the shard directory — it describes how shards are written, not any code path
last-verified: "2026-08-29" # #2192: the hazard this section described is now CHECKED — the coupling gate requires an ADDED satisfied-by match, so editing a merged shard no longer clears the blocking gate. Both the case-3 qualifier and the hazard paragraph rewritten accordingly (the former said in as many words that the rule was convention and not gate-checked; that is no longer true), and the parent-doc edit named as the escape hatch it always was. Immutability rule and the three cases otherwise unchanged. Prior: #2188: merged shards are IMMUTABLE — new section states the correction mechanism for each of the three ways a shard goes wrong, and closes the wrong inference that shards have a `chain-reset` equivalent (they do not; the per-file model already is the compaction). Measured while writing it, and reproduced independently by review: editing a merged shard satisfies the satisfied-by gate for an unrelated money-path PR (exit 1 -> exit 0 on a one-character edit), so the rule has a mechanical reason, not only an attestation one — and the doc says plainly that its own case-3 qualifier is convention rather than a gate check. Counted for the chain-reset claim: 181 shards, zero carrying a last-verified line. Convention/filename rules re-read against the gate and unchanged. Prior: #1789: release shards are named for the VERSION, not the PR number — the PR-number convention was unsatisfiable in principle (the gate blocks the PR until the shard exists, so the number cannot be known when the name is needed) and cost the 0.1.29-alpha.0 cut a wrong guess plus a correcting commit. Issue shards are unchanged; existing shards keep their names; the release/SKILL.md and scripts/README.md copies now say the same thing. Body re-read against the gate: the satisfied-by claim and the no-front-matter exemption still hold. Prior: created for #1366 — the sharded CASP verification log
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
Do not edit it in place — with one narrow exception, the third case below.
Which correction mechanism applies depends on **when the shard became wrong**,
not on how wrong it is:

- **Stale via a later change** — it was true when written, and a subsequent PR
  invalidated it. The correction belongs in the **new** shard; the old one
  stays untouched.
- **Wrong when written** — a genuine analysis error, describing the code as it
  stood at merge time. Still no in-place edit, for a stronger reason than
  tidiness: a merged shard may already be relied on as an attestation of what
  was checked. The correction is a **new dated shard** that quotes the wrong
  claim, says it was wrong and why, and states the correct fact. Rewriting the
  original would remove the evidence that the error was ever made.
- **Pure transcription defect** — a broken link, a typo'd issue number, mangled
  table syntax. Fixable in place: it is a rendering fault in *carrying* the
  claim, not a claim about the code. Bundling one into your own money-path PR
  is fine now — since #2192 the gate requires a genuinely **new** file, so the
  edit simply does not count towards it and you still write your own shard.

**The mechanical reason, which is sharper than the principle — and is now
checked (#2192).** The gate that `satisfied-by` drives used to ask only whether
*some* changed file matched `docs/regulatory/casp-changelog/**`, never whether
that file was new. So editing a merged shard **satisfied the blocking
contract-doc gate for an unrelated money-path PR**, with no verification record
written — silently, on green CI. Measured on 2026-08-29 (#2188), holding one
money-path edit fixed:

| Diff | before #2192 | after #2192 |
|---|---|---|
| money-path code only | exit 1 | exit 1 |
| the same code + a **one-character** edit to an already-merged shard | **exit 0** | **exit 1** |

The gate now requires at least one **added** match, so an edit to an old shard
no longer stands in for the new one. It is "at least one added", never "no
modified matches" — a PR that writes its own shard and tidies an old one still
passes. Renames do not count: an old record under a new name is not a new
record.

If a money-path change genuinely warrants no new shard, the escape hatch is the
one that was always there: **edit the parent `casp-risk-guardrails.md`
directly**, which clears the gate and leaves a reviewable statement of why.

**There is no `chain-reset` for shards, and there should not be.** The
structural answer first, because it is not arguable: `chain-reset(#N)` is an
escape hatch for one `last-verified` **line**, and
[`chain-integrity.mjs`](../../../scripts/docs/chain-integrity.mjs) only ever
inspects that line. **No shard carries one** — 181 shards, zero
`last-verified:` front-matter entries (one shard carries other front-matter;
none carries this). There is nothing for the marker to act on.

The reason it feels like there should be one is worth naming, since the
analogy is what misleads: `casp-risk-guardrails.md` declared
`chain-reset(#1496)` on its own line *because its entries became these
shards*. That is the compaction, already performed — reading it as precedent
for an in-shard escape hatch inverts it. The per-file model gives you by
default what the marker exists to license: one file per entry, compacted by
never having been concatenated. A shard needs no escape from a chain it is
not on.

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
