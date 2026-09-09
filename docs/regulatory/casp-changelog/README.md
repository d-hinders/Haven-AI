---
owner: "@AntonioSaaranen"
status: current
covers:
  - docs/regulatory/casp-changelog/**
last-verified: "2026-08-29"
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
  analysis; only the storage stopped colliding. The glob matches any changed file in
  this directory, but since #2192 only an **added** one satisfies it: editing a
  shard that already merged does not clear the gate for your change. Until then
  it did, which is why *Once merged, a shard is immutable* below is written as a
  compliance rule first and a gate behaviour second.
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
  table syntax, or a **byte-identical duplicate file** (a stray `… 3.md` copy
  alongside its original). Fixable in place, deletion included for the
  duplicate: these are faults in *carrying* the claim, not claims about the
  code, and an exact copy holds no evidence its original does not. Establish the identity — same content hash, and ideally the same
  origin commit — in the PR; do not eyeball it. Bundling such a fix into your
  own money-path PR is safe: since #2192 the gate needs a genuinely **new**
  file, so the edit cannot stand in for the shard you still have to write.

**The mechanical reason, which is sharper than the principle — and is now
checked (#2192).** The gate that `satisfied-by` drives used to ask only whether
*some* changed file matched `docs/regulatory/casp-changelog/**`, never whether
that file was new. So editing a merged shard **satisfied the blocking
contract-doc gate for an unrelated money-path PR**, with no verification record
written — silently, on green CI. Both columns measured on 2026-08-29 holding
one money-path edit fixed — the *before* under #2188, the *after* on #2192's
own fix:

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

**Each shard is already an independent historical record.** It does not need
front-matter provenance text: its filename, Git history, and the parent
document's `satisfied-by:` declaration identify why it exists. Keep a new
per-change analysis in a new shard rather than compacting it into an older one.

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
