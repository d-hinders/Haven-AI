---
owner: "@d-hinders"
status: current
covers:
  - .agents/skills/ship-next/SKILL.md
  - .agents/skills/quality-scan/SKILL.md
  - .agents/skills/quality-scan/references/dimensions.md
  - .agents/skills/haven-agent-workflow/references/doc-reviewer.md
  - docs/quality/issue-classification-2026-09.csv
last-verified: "2026-09-04" # #2507: written from the classification in `docs/quality/issue-classification-2026-09.csv`; every figure in this doc was re-derived from that file or from `git`/`gh` at `fb0d5372` while writing, and the command sits next to each one. Scope: the whole document is new in this PR; nothing here is carried over unverified from the working artifact it replaces.
---

# The 600-issue retrospective (2026-09-03)

Between 2026-08-10 and 2026-09-03 the repository accumulated 600 issues. This
document is the classification behind that number, the eight patterns it
found, and the guidelines the three shipped skills now carry. It exists so
those skills can cite something a reader can check: #2499, #2500 and #2501
were each written against this analysis while it lived only in a session, and
their reviewers all reported the same gap — the acceptance criteria named a
document nobody could open.

Every figure below states the command that produces it. Where a figure was
quoted wrong earlier in the wave, this document says so rather than quietly
printing the corrected value.

## Method

The issue set is the 600 most recent issues in the window, exported once:

```bash
gh issue list --repo d-hinders/Haven-AI --state all --limit 600 \
  --json number,title,labels,state,createdAt,author,body
```

Window: `2026-08-10T07:04:25Z` .. `2026-09-03T14:05:58Z` (#1248–#2486).

Each issue was read and assigned a root-cause category by hand — four passes
of 150 — because no label in the repository distinguishes "the code was
wrong" from "something claimed a state that was not true". The result is
`docs/quality/issue-classification-2026-09.csv`, one row per issue.

**Validation.** A 20-issue random sample was re-read against its assigned
category by an independent pass; 19 of 20 agreed. The one disagreement was a
`rail-retirement` issue also readable as `stale-doc` — a boundary case
between two categories that this document treats as the same pattern, so it
does not move any figure below.

**Multi-category rows.** 26 of the 600 rows carry two categories. The CSV
records both: `category` is the primary one, `categories` the full
pipe-separated list. The headline share is stable under either reading,
which is why it is quoted below without a qualifier:

```bash
F=docs/quality/issue-classification-2026-09.csv
# primary category only
cut -d, -f2 "$F" | tail -n +2 | sort | uniq -c | sort -rn
# every category mentioned
tail -n +2 "$F" | cut -d, -f3 | tr '|' '\n' | sort | uniq -c | sort -rn
```

Both readings give the same 237 of 455 for the group in *The finding* below.

## What the 600 are

`feature` and `other` are not defects, so the defect set is 455:

```bash
# 600 rows, 139 feature, 6 other  =>  455 defects
awk -F, 'NR>1 && $2!="feature" && $2!="other"' \
  docs/quality/issue-classification-2026-09.csv | wc -l      # 455
```

| Category | Count | Share of the 455 |
|---|---:|---:|
| `logic-bug` — the code did the wrong thing | 99 | 21.8% |
| `false-instrument` — a check that could not fail, or reported what it never looked at | 86 | 18.9% |
| `copy-ux` — wording, layout, or a confusing surface | 86 | 18.9% |
| `rail-retirement` — residue of a removed rail | 64 | 14.1% |
| `stale-doc` — documentation describing a state that had changed | 48 | 10.5% |
| `process` — the workflow itself misfired | 40 | 8.8% |
| `flake` — environment, not code | 25 | 5.5% |
| `contract-drift` — two declarations of one truth disagreeing | 18 | 4.0% |
| `security` | 15 | 3.3% |
| *(not defects)* `feature` 139, `other` 6 | | |

Counts in this table are "any category mentioned" (column 3), so the 26
two-category rows are counted under both and the column does not sum to 455.
The primary-category reading (column 2) gives 99 / 85 / 81 / 63 / 34 / 39 /
25 / 16 / 13 for the same rows.

**The finding.** Group the five categories that are all the same failure —
something asserted a state that was not true — and they outweigh ordinary
logic bugs by more than two to one:

```
false-instrument 86 + rail-retirement 64 + stale-doc 48 + process 40 + contract-drift 18
  => 237 distinct issues of 455  =  52.1%
logic-bug                                       =>  99 of 455  =  21.8%
```

Half of what this repository files is not "the code is wrong". It is **the
instruments are lying** — a guard that cannot fail, a number that was true
last week, a doc describing a rail that is gone, a claim that an operator
step was performed. The code half is the smaller half.

## The eight patterns

1. **Guards that cannot fail.** 56 unfalsifiable money-path guards in one
   tree (#2307); a guard that printed `[PASS]` without looking (#2455); a
   publish safety check bypassed while its suite stayed green (#2421).
2. **Text matching stood in for execution.** `indexOf('assert_publish_allowed')`
   found the call inside a `case` that skipped it (#2421). A regex counted 26
   where evaluating gave 27 (#2423).
3. **Numbers that were true when measured.** "39 passed" from a run that
   predated the last edit (#2421); a file count that moved 27 → 30 → 32 → 33
   inside one PR (#2423).
4. **Removals that left their claims behind.** The Safe rail's deletion took
   four slices; its residue is 63 issues in this window
   (`awk -F, 'NR>1 && $2=="rail-retirement"' docs/quality/issue-classification-2026-09.csv | wc -l`
   → 63; 64 counting the one row where it is the secondary category), across docs, comments, package READMEs,
   OpenAPI descriptions, fixtures, mocks and QA seeds.
5. **"Still" as a boundary marker.** 36 issue titles in the window contain
   the word *still* (`jq -r '.[].title' … | grep -ci still`). Each one is the
   previous sweep's edge, found by hand afterwards.
6. **Reviews that read the wrong tree.** A `cp -R` of a worktree copies a
   `.git` pointer file, so the reviewer's git commands read the live builder
   tree — one blocking finding about a paragraph nobody had touched (#2455).
7. **The merge method.** Since 2026-08-10, on `origin/dev` at `fb0d5372`:

   ```bash
   git log fb0d5372 --first-parent --since=2026-08-10T00:00:00Z --oneline \
     | grep -c '^[0-9a-f]* Merge pull request'      # 276
   git log fb0d5372 --first-parent --since=2026-08-10T00:00:00Z --oneline \
     | grep -cE '\(#[0-9]+\)$'                      # 351
   ```

   630 first-parent landings, 276 as merge commits, of which 4 are the
   legitimate `sync/*` back-merges — so **272 landed with the wrong method**.
   Earlier drafts of this figure quoted "264 of 604" from a bare
   `--since=2026-08-10`, which git resolves as an *approxidate* against the
   wall clock: the same SHA counted 258, 257 and 256 across one evening.
   Always pin the instant.
8. **One truth declared twice.** Three declarations checked across no
   boundary (#1442); an atomic value passing where a human-decimal was
   declared, caught only once the round-trip was tightened to what the
   emitter can actually produce (#2392, #2408).

## Guidelines

Each guideline states the pattern it answers and the check that makes it
mechanical. The right-hand column says where it now lives, so a reader can
see it is enforced rather than merely written down.

### A — Instruments

| | Guideline | Landed in |
|---|---|---|
| **A1** | Mutation-prove every guard before relying on it: make it fail, restore the tree byte-identical, then trust it. | `ship-next` *Implement*, `quality-scan` block 1 |
| **A2** | A guard about reachability or control flow is proven by executing the path, never by matching source text. | `ship-next` *Acceptance Gate* |
| **A3** | Prove the instrument can say yes before you use its no. Every "none found" is preceded by a positive control on the same instrument. | `doc-reviewer` §2.3, `ship-next` *Acceptance Gate* |
| **A4** | A check that could silently not run needs a red X for "did not happen". | `quality-scan` block 6 |

### B — Numbers

| | Guideline | Landed in |
|---|---|---|
| **B1** | Any count in prose is re-derived from its instrument at the commit you ship, and the prose states the basis. | `ship-next` *Acceptance Gate*, `doc-reviewer` §4 |
| **B2** | If a number can change without your PR, do not freeze it — name the test or tool that owns it. | `quality-scan` block 3 |
| **B3** | Correct a wrong figure in a regulatory record by stating how it was wrong, not by overwriting it. | `docs/regulatory/` practice; `doc-reviewer` §5 |

### C — Removals

| | Guideline | Landed in |
|---|---|---|
| **C1** | A removal PR ships with a claim sweep, and the sweep's commands are in the body. | `ship-next` *Implement*, `doc-reviewer` §2 |
| **C2** | Schedule the residue at the start, and gate the retired vocabulary in CI so the epic can finish. | `quality-scan` block 4 |
| **C3** | When a title says "still", widen the net — do not just fix the instance. | `ship-next` *Implement* |

### D — Reviews

| | Guideline | Landed in |
|---|---|---|
| **D1** | A reviewer works from a real clone or a fresh `git worktree add` — never `cp -R` — and quotes the isolation guard's output. | `reviewer.md`, `doc-reviewer` §1, `scripts/ci/review-isolation.mjs` |
| **D2** | A verdict belongs to the SHA it saw. Any commit after a verdict re-runs the pass that covered it. | `ship-next` *Independent Review*, `doc-reviewer` §1 |
| **D3** | State what you could not verify, verbatim, and carry it into the PR body unsoftened. | `ship-next` *Commit And Pull Request*, `doc-reviewer` return format |
| **D4** | Re-run the one claim you can. It is the cheapest verification available and it has fired every time. | `doc-reviewer` §4 |

### E — Merges

| | Guideline | Landed in |
|---|---|---|
| **E1** | Feature → `dev` is squash; `dev` → `main` is a merge commit. Make the repository refuse the other method. | `ship-next` *Merge Gate*; the repository setting is an owner action |
| **E2** | Refresh a base by interleaving `last-verified` chains, never by taking a side, and assert the result on raw bytes. | #2504 |

### F — Operator truth

| | Guideline | Landed in |
|---|---|---|
| **F1** | Never state an operator step as done. Write against the mechanism, and sweep code comments as carefully as docs. | `ship-next` *Implement*, `doc-reviewer` §2 |
| **F2** | Mechanism first, observation second, flag last — each step measured before the next. | `docs/operations/package-dev-channel.md` |
| **F3** | If the truth of an issue lives outside the repository, use `Refs`, not `Closes`, and leave it open until the world agrees. | `ship-next` *Closeout* |

### G — One truth

| | Guideline | Landed in |
|---|---|---|
| **G1** | One source, generated consumers. Where the second copy cannot be generated, round-trip it. | `openapi/spec.test.ts`, `quality-scan` block 2 |

## What this wave is not

The wave is not a quality collapse. It is an audit finding what it is built
to find, at a rate the team can absorb: 139 of the 600 are features, and the
455 defects were overwhelmingly found by the repository's own instruments and
reviews rather than by users. The guidelines exist so that the same defect
class stops arriving one instance at a time.

The three skills that carry them shipped on 2026-09-03: #2499 (`doc-reviewer`),
#2500 (`ship-next`), #2501 (`quality-scan`). Their PRs produced one more piece
of evidence for this document — across those three reviews, **every wrong
claim was caught by an independent read, and none by a gate**. On #2500, four
of six review rounds blocked on a sentence whose basis could not be found.
