---
owner: "@AntonioSaaranen"
status: current
covers: []  # index and naming convention for the shard directory — it describes how shards are written, not any code path
last-verified: "2026-08-22" # #1789: release shards are named for the VERSION, not the PR number — the PR-number convention was unsatisfiable in principle (the gate blocks the PR until the shard exists, so the number cannot be known when the name is needed) and cost the 0.1.29-alpha.0 cut a wrong guess plus a correcting commit. Issue shards are unchanged; existing shards keep their names; the release/SKILL.md and scripts/README.md copies now say the same thing. Body re-read against the gate: the satisfied-by claim and the no-front-matter exemption still hold. Prior: created for #1366 — the sharded CASP verification log
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
  analysis; only the storage stopped colliding.
- **The parent doc** keeps the guardrails body and the historical EOF log
  (frozen as of 2026-08-12). Its `last-verified` now reflects genuine
  re-verification of the BODY claims (e.g. the weekly #1248 audit), not
  per-PR bumps.

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
