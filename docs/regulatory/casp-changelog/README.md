---
owner: "@AntonioSaaranen"
status: current
covers: []
last-verified: "2026-08-12" # created for #1366 — the sharded CASP verification log
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
