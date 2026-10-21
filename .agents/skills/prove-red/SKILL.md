---
name: prove-red
description: Run mutation cells with one tested runner instead of a hand rig. Use when ship-next Implement step 5 needs every new assertion mutation-proved, when a quality-scan block-1 census runs its budgeted mutations, or when a reviewer reproduces the author's cells and adds its own (prove-red verify).
---

# Prove Red

`node scripts/ci/prove-red.mjs` executes mutation cells: it backs up the file,
applies the wrong edit, runs the one test file, classifies the result, restores
the file and proves the restore. It replaces the per-issue hand rig, whose
recorded failures — a committed mutation, a wrong-occurrence inverse edit, a
`sed` that did not apply, a stale `dist`, a SQL red counted as caught, restores by
`git checkout` — are each a guardrail in the script (its header maps them, and
`scripts/ci/prove-red.test.mjs` drives each one).

**It does not design cells.** The nearest wrong edit is still the author's and the
reviewer's to find ([ship-next](../ship-next/SKILL.md) *Implement* step 5): the
four escapes named there were each found by a reviewer, and a runner only executes
the cells someone writes. That is why `verify` demands a reviewer-authored file.

## Modes

```bash
export SCRATCH=<your session scratchpad>      # required; the runner never guesses one
node scripts/ci/prove-red.mjs mutate  --issue <n>                          # author: run your cells
node scripts/ci/prove-red.mjs verify  --issue <n> --builder <builder-tree>  # reviewer: author's cells + your own
node scripts/ci/prove-red.mjs census  --issue <scan-id> --candidates <file> # quality-scan block 1
node scripts/ci/prove-red.mjs recover                                      # after a kill or an exit 3
```

Run it from inside the tree being mutated. `--cells <path>` and
`--review-cells <path>` override the default cells paths below; `--timeout
<seconds>` bounds each test run (default 600).

## Cells

A cells file is a JSON array in **`$SCRATCH` only — never in the tree**:
`$SCRATCH/prove-red-<issue>-cells.json` for the author (and the census),
`$SCRATCH/prove-red-<issue>-review-cells.json` for the reviewer. The runner
refuses a cells file or a `$SCRATCH` inside the tree, so the clean-tree
precondition never refuses a reviewer over its own cells.

```json
[{
  "id": "M1",
  "guard": "<what the assertion pins>",
  "test": "packages/<pkg>/src/<name>.test.ts",
  "file": "packages/<pkg>/src/<name>.ts",
  "edits": [{ "find": "<text that occurs exactly once>", "replace": "<the nearest wrong edit>" }],
  "family": "polarity",
  "note": "<the wrong edit, in words>",
  "expect_red": ["<describe title> > <test title>"]
}]
```

- `edits` is an ordered list; each `find` must occur **exactly once** in the file
  as the previous pairs left it (overlaps count). A move is two pairs.
- `all: true` with `replace` = the whole new file (a line-ending rewrite, say) is
  the **one waiver** of exactly-once. It is expected to be rare: name every
  `all: true` cell in the PR body, and the reviewer reviews it — otherwise it is
  the escape hatch that brings back the wrong-occurrence class.
- `expect_red` lists **full test names**: ancestor `describe` titles and the test
  title joined by ` > `. A name the unmutated run does not report, or reports as
  skipped, refuses the cell.
- `family` is one of the four families'
  slugs — `polarity`, `wildcard-token`, `any-error-code`, `unentered-branch`
  ([`ai-review-patterns.md` § Assertions A Wrong Edit Still Satisfies](../../../docs/contributing/ai-review-patterns.md#assertions-a-wrong-edit-still-satisfies))
  — or `guard-out` (step 5's reachability mutation), `census`, a probe kind of
  [quality-scan `dimensions.md` § 1, *Budget*](../quality-scan/references/dimensions.md)
  (`probe-second-copy`, `probe-count-only`), or `other`. `census`, probes and
  `other` need a `note` naming the mutation. The families are defined there, not
  here; the self-test holds the four slugs equal to that section, so a new family
  lands in all four homes `reviewer.md` names, and in the runner.
- `runner` is inferred (`*.test.mjs` → `node --test`, `packages/<pkg>/**/*.test.ts`
  → vitest, `*.spec.ts` → Playwright); set it when the path misleads. Unknown keys
  are refused, so a typo cannot silently drop a field.

**Handing cells on.** Subagents of one session share `$SCRATCH`, so the reviewer
reads the author's file in place. Across sessions, the PR body carries the cells
file in a collapsed block and the reviewer writes it to its own `$SCRATCH`.

## What a run requires (exit 2, nothing touched)

The tree is clean **and committed** — the assertions under test included, so each
result is bound to a commit; it is not the main checkout that worktrees hang off;
no `node_modules` symlink resolves outside the tree (run `npm ci` in a fresh
worktree); no journal from an earlier run is pending; no other `prove-red` holds
the tree's lock (`$(git rev-parse --git-dir)/prove-red.lock`, `O_EXCL`); every
edit applies exactly once; no backup from an earlier run is in the way. The
runner calls the test runner directly, not the package's `test` script, so build
the dependencies that script's prelude would (`npm --prefix ../core run build &&
…`) once before the run: the green baseline proves the test passes, not that the
`dist/` it reads is fresh. The lock
covers `prove-red` only: `npm run preflight` takes no lock, so do not run both in
one tree at once — the runner cannot see it.

## Per cell

1. Run the target test **unmutated**; refuse the cell unless it is green and
   reports every `expect_red` test, and refuse the run if that test wrote into the
   tree.
2. Back up to `$SCRATCH/<file>.<issue>.<role>.<cell>.bak` (`role` is `author` or
   `review`) and verify its sha256; journal the cell in the tree's git dir.
3. Apply the edits; assert `git diff --numstat` and `git status` name only that file.
4. When the mutated file's `packages/<pkg>/` differs from the test's — or a
   Playwright cell mutates app source — run `npm run build -w packages/<pkg>`.
5. Run only the target test file, in a fresh process (Playwright with
   `--retries=0`), and classify.
6. Restore by `cp` from the verified backup, check the sha256, **rebuild again if
   step 4 ran** (`dist/` is gitignored, so `git status` cannot see a mutant build;
   the journal marks the tree dirty until this build succeeds), then require an
   empty `git status --porcelain`.

It never stages, commits, pushes, or runs `git checkout`, `stash` or `restore`,
and it never inverts an edit.

## Classes

| class | meaning | counts as caught |
|---|---|---|
| **caught** | an `expect_red` test failed on an assertion-type error, and the run reported the baseline's test count | yes |
| **survived** | green, same test count | no — diagnose it |
| **shadowed** | red on assertions, but in no `expect_red` test: another test caught it, so the named guard is not what pins the behaviour | no |
| **mutation-red** | red for the mutation's own reason — compile, import or SQL error, a non-assertion throw in a named test, a timeout, or a different test count | no — fix the mutation and re-run |

Assertion-type is `ERR_ASSERTION` for `node --test`, an `AssertionError` for
vitest, an `expect(` failure for Playwright. One caveat the runner cannot see past:
`expect(fn).toThrow(/X/)` turns a thrown non-assertion error into an assertion
failure, so a SQL error inside such a test reads as caught — check the message.

## Exit codes and the Closeout table

| exit | meaning |
|---|---|
| 0 | every cell caught (`census`: every sampled cell ran to a class) |
| 1 | at least one cell survived, was shadowed, was mutation-red, or was refused at its baseline |
| 2 | refused before anything was mutated |
| 3 | a restore, rebuild or clean-tree check failed; the journal is kept — run `recover` before any test |
| 129 / 130 / 143 | SIGHUP / SIGINT / SIGTERM, after a verified restore |

`mutate` and `verify` print [ship-next's per-cell Closeout table](../ship-next/SKILL.md#closeout):
*Adversarial edit* is the family, the note and the edits; *Author result @ sha* is
the `mutate` outcome; *Reproduced by* is the `verify` outcome; *Status* is
`author-only` for a caught author cell, `reproduced` / **not reproduced** after
`verify`. The result JSON is `$SCRATCH/prove-red-<issue>-<mode>.json`.

## Interrupts and `recover`

Ctrl-C, SIGTERM and SIGHUP stop the test, restore the cell (and rebuild if one
ran), then exit; a second signal does not abort the restore. `kill -9` leaves the
mutant and the journal: the next run refuses, and `recover` restores **only** when
the file still matches the journalled mutant hash and the backup still matches the
original's. A hand edit after the kill, or a missing backup, exits 3 and nothing is
overwritten. Recover from an exit 3 the same way; if the message names a staged
change, inspect `git diff --cached` before anything else.

## `verify` (reviewers)

`verify` re-runs the author's cells **and requires a reviewer-authored cells
file**. It **fails closed**: a reviewer file that is missing, empty, unreadable,
not valid JSON, or made only of duplicates of the author's cells (same file and
edits, whatever the id) exits 2 and runs **nothing** — a mistyped path can never
run the author's cells alone and read as a review.

It runs only in your own root: the one `review-isolation.mjs` ACCEPTED with
`--builder` ([`reviewer.md`](../haven-agent-workflow/references/reviewer.md)
§ *Before anything else*); pass the same `--builder`, and the runner refuses a
root that is the builder's tree or not registered at its own path. Its edits are
the one exception to the reviewer's read-only posture, and every one is restored
before it exits 0 or 1. An exit 3 keeps the root. `verify` does not run `npm ci`:
a vitest or Playwright cell refuses without `node_modules` in the root, so run it
there first.

## `census` (quality-scan block 1)

Input: the saved output of the census command in
[`dimensions.md` § 1](../quality-scan/references/dimensions.md) (it must keep its
`candidate guard files: N` line). The runner skips files absent at `HEAD`, takes
the first five distinct files — newest landing first — and runs the one `census`
cell written for each, then up to two probe cells; anything else is listed as out
of budget and not run. It prints the block-1 table
(`| # | Guard file | Mutation | Baseline → mutant |`) for the scan report and the
ledger. A survivor's diagnosis is still the author's; the table leaves the slot.

## Playwright and frontend e2e

Supported: the runner forces `--retries=0` (a retry that passes would report a
flaky red as green) and rebuilds the app for a cell that mutates app source. Set
the environment the built run needs — `CI=1` and the placeholders — as
[`frontend.md` § mutation cells](../../../docs/contributing/ship-playbooks/frontend.md)
describes; the runner passes it through.

## When not to use it

A mutation that belongs in CI forever — a test that imports a mutant copy of an
ESM module from a temp dir, as `scripts/ci/baseline-verdict-gate.test.mjs` does —
stays in the test file. `prove-red` is for the proofs that are run once per change
and recorded in the PR body.
