---
owner: "@d-hinders"
status: current
covers:
  - .agents/skills/ship-next/SKILL.md
  - .agents/skills/quality-scan/SKILL.md
  - .agents/skills/quality-scan/references/dimensions.md
  - .agents/skills/haven-agent-workflow/references/doc-reviewer.md
  - .agents/skills/haven-agent-workflow/references/reviewer.md
  - scripts/ci/review-isolation.mjs
  - docs/operations/package-dev-channel.md
  - packages/backend/src/openapi/spec.test.ts
  - docs/quality/issue-classification-2026-09.csv
last-verified: "2026-09-08"
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

**One correction the review found.** #2012 was first classified
`rail-retirement` on the strength of its `safe-retirement:` title prefix; read
in full it is a spend-authority defect — a QA seed that re-grants a budget to a
revoked agent — and it is classified `security` here. A title prefix names the
epic a piece of work happened under, not its root cause, and the classification
had to be corrected once for exactly that reason.

**Validation.** A 20-issue random sample was re-read against its assigned
category by an independent pass; 19 of 20 agreed. The one disagreement was a
`rail-retirement` issue also readable as `stale-doc` — a boundary case
between two categories that this document treats as the same pattern, so it
does not move any figure below.

**Multi-category rows.** 26 of the 600 rows carry two categories. The CSV
records both: `category` is the primary one, `categories` the full
pipe-separated list. Counts below say which reading they use:

```bash
F=docs/quality/issue-classification-2026-09.csv
cut -d, -f2 "$F" | tail -n +2 | sort | uniq -c | sort -rn          # primary only
tail -n +2 "$F" | cut -d, -f3 | tr '|' '\n' | sort | uniq -c | sort -rn  # every category
```

Titles contain commas, so any count over the `title` column needs a real CSV
reader rather than `cut`; the shell form silently undercounts.

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
| `rail-retirement` — residue of a removed rail | 63 | 13.8% |
| `stale-doc` — documentation describing a state that had changed | 48 | 10.5% |
| `process` — the workflow itself misfired | 40 | 8.8% |
| `flake` — environment, not code | 25 | 5.5% |
| `contract-drift` — two declarations of one truth disagreeing | 18 | 4.0% |
| `security` | 16 | 3.5% |
| *(not defects)* `feature` 139, `other` 6 | | |

Counts in this table are "any category mentioned" (column 3), so the 26
two-category rows are counted under both and the column does not sum to 455.
The primary-category reading (column 2) gives 99 / 85 / 81 / 62 / 34 / 39 /
25 / 16 / 14 for the same rows.

**The finding.** Group the five categories that are all the same failure —
something asserted a state that was not true — and they outweigh ordinary
logic bugs by more than two to one. Counting *distinct issues*, since 26 rows
carry two categories and the naive column sum would double-count them:

```bash
F=docs/quality/issue-classification-2026-09.csv
# every category mentioned: 237 distinct issues of 455 = 52.1%
python3 -c "
import csv
L={'false-instrument','rail-retirement','stale-doc','process','contract-drift'}
d=[r for r in csv.DictReader(open('$F')) if r['category'] not in ('feature','other')]
print(len([r for r in d if set(r['categories'].split('|')) & L]), 'of', len(d))"
# primary category only: 236 of 455 = 51.9%
awk -F, 'NR>1 && ($2=="false-instrument"||$2=="rail-retirement"||$2=="stale-doc"||$2=="process"||$2=="contract-drift")' "$F" | wc -l
```

The two readings differ by exactly one issue (#2012, whose primary category is
`security` and whose secondary is `false-instrument`), so the share is 51.9%
or 52.1% depending on the reading. Logic bugs are 99 of 455 = 21.8% under
both.

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
   four slices; its residue is 62 issues in this window
   (`awk -F, 'NR>1 && $2=="rail-retirement"' docs/quality/issue-classification-2026-09.csv | wc -l`
   → 62; 63 counting the row where it is the secondary category), across docs, comments, package READMEs,
   OpenAPI descriptions, fixtures, mocks and QA seeds.
5. **"Still" as a boundary marker.** 36 issue titles in the window contain
   the word *still*. Titles contain commas, so the count needs a CSV reader:
   `python3 -c "import csv;print(sum('still' in r['title'].lower() for r in csv.DictReader(open('docs/quality/issue-classification-2026-09.csv'))))"`
   → 36; `cut -d, -f7 | grep -ci still` undercounts to 32. Each one is the
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
| **C1** | A removal PR ships with a claim sweep, and the sweep's commands are in the body. The sweep's hits are finished in the PR that triggered it — fixed or dropped under **Not filed**, not filed as a follow-up (#2767). | `ship-next` *Implement*, `doc-reviewer` §2 |
| **C2** | Schedule the residue at the start, and gate the retired vocabulary in CI so the epic can finish. | `quality-scan` block 4 |
| **C3** | When a title says "still", widen the net — do not just fix the instance. The widened net is swept in the PR that triggered it, and a "still" of an open issue widens that issue rather than filing a sibling (#2767). | `ship-next` *Implement* (#2512), *Filing bar* (#2767). Not landed when this document was written; the row said so and named the issue, which is why it exists. |

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
| **E1** | Feature → `dev` is squash; `dev` → `main` is a merge commit. Make the repository refuse the other method. | `ship-next` *Merge Gate*; the `Dev merge` ruleset (22449193) pins `dev` to `allowed_merge_methods: ["squash"]` and `Dev gate` (18134280) pins `main` to `["merge"]` — owner step O1 of #2632, 2026-09-07. The two are not the same age, and the row would mislead if it implied they were: `Dev merge` was CREATED that day (`created_at` 2026-09-07T14:24), while `Dev gate` dates from 2026-06-25 and only its `updated_at` is 2026-09-07T14:25. What landed on both is the merge-method PARAMETER, which is the load-bearing part; the ruleset object's age is not evidence either way, and GitHub's ruleset history endpoint returns 404 for the tokens available here, so when that parameter first appeared on `Dev gate` is not established. Checked live: `gh api repos/d-hinders/Haven-AI/rules/branches/dev` and `…/main`, both rulesets `enforcement: active`. `Haven automerge rules` (18021461) still carries `["squash", "merge", "rebase"]` on both branches, so the refusal rests on rulesets intersecting rather than on a single setting; not proven here by attempting a disallowed merge. |
| **E2** | RETIRED with the chain it governed (#2681, #2775). It said: refresh a base by interleaving `last-verified` chains, never by taking a side, and assert the result on raw bytes. There are no chains to interleave, and `chain-integrity.mjs`/`checkEntriesVerbatim` are deleted — so the rule is unactionable rather than merely stale. The GENERAL form outlives it: when two branches edit one append-only list, a merge that takes a side silently drops the other's entries, and byte-level assertion is what catches it. | [`docs/archive/last-verified-chains-2026-09.md`](../archive/last-verified-chains-2026-09.md) holds the chains; the reasoning is in git history for `docs-quality-system.md` |

### F — Operator truth

| | Guideline | Landed in |
|---|---|---|
| **F1** | Never state an operator step as done. Write against the mechanism, and sweep code comments as carefully as docs. | `ship-next` *Implement*, `doc-reviewer` §2 |
| **F2** | Mechanism first, observation second, flag last — each step measured before the next. | `docs/operations/package-dev-channel.md` |
| **F3** | If the truth of an issue lives outside the repository, use `Refs`, not `Closes`, and leave it open until the world agrees. | `ship-next` *Closeout* |

### H — Corrections and instruments

Added 2026-09-06 from a single-session retrospective, [`session-retrospective-2026-09-06.md`](session-retrospective-2026-09-06.md). The three rules and the evidence for them are there; they are listed here so the A–G set is not read as complete.

| | Guideline | Landed in |
|---|---|---|
| **H1** | A correction is a new claim. Verify the replacement sentence against its instrument, never against the sentence it replaces. | Stated only. Not mechanisable by a script, and said so rather than claimed. |
| **H2** | Before a "none found", check the instrument is looking at the column, the tree and the process you mean. | `ai-review-patterns.md` § *Instrument Self-Reference And Staleness*; the Captain Self-Check Preflight; `reviewer.md` must-check list |
| **H3** | After editing a sentence, read it to its full stop in the rendered file — the tail that describes the old head is on the line the diff does not show. | Stated only. |

### G — One truth

| | Guideline | Landed in |
|---|---|---|
| **G1** | One source, generated consumers. Where the second copy cannot be generated, round-trip it. | `packages/backend/src/openapi/spec.test.ts` (`quality-scan` block 2 checks a doc's `covers:` against its body, which is a different mechanism, not this one) |

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
