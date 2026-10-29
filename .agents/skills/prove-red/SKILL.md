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
node scripts/ci/prove-red.mjs verify  --issue <n> --builder <builder-tree> --expect-head <sha>  # reviewer
node scripts/ci/prove-red.mjs census  --issue <scan-id> --candidates <file> # quality-scan block 1
node scripts/ci/prove-red.mjs recover                                      # after a kill or an exit 3
```

Run it from inside the tree being mutated. `--scratch <dir>` stands in for
`$SCRATCH`; `--cells <path>` and `--review-cells <path>` override the default
cells paths below; `--timeout <seconds>` bounds each test run (default 600).

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
  here. They live in four places — ship-next *Implement* step 5,
  [`ai-agent-workflow.md`](../../../docs/contributing/ai-agent-workflow.md)'s
  preflight item, `reviewer.md`'s must-check item and `ai-review-patterns.md` —
  and a new family goes into all four together (`reviewer.md` asks the same of
  its three trap lists). The self-test holds the runner's four slugs equal to
  the `ai-review-patterns.md` section, so a family added there fails CI until it
  is added here too.
- `runner` is inferred (`*.test.mjs` → `node --test`, `packages/<pkg>/**/*.test.ts`
  → vitest, `*.spec.ts` → Playwright); set it when the path misleads. Unknown keys
  are refused, so a typo cannot silently drop a field.

**Handing cells on.** Subagents of one session share `$SCRATCH`, so the reviewer
reads the author's file in place. Across sessions, the PR body carries the cells
file in a collapsed block and the reviewer writes it to its own `$SCRATCH`.

## What a run requires (exit 2, nothing touched)

The tree is clean **and committed** — the assertions under test included, so each
result is bound to a commit; it is not the main checkout that worktrees hang off
(a main checkout with no linked worktrees — a standalone `git clone` made for
review — is allowed); each cell's `file` is a regular tracked file inside the
tree, not a symlink, and valid UTF-8 (an edit to any other bytes would rewrite
bytes the cell never named); no `node_modules` symlink resolves outside the tree (run `npm ci` in a fresh
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

1. When step 4 will rebuild, build the **unmutated** package first and refuse the
   cell if it does not build, so the baseline never reads a stale `dist/`. Then
   run the target test unmutated; refuse the cell unless it is green and reports
   every `expect_red` test, and refuse the run if that test wrote into the tree.
2. Back up to `$SCRATCH/<file>.<issue>.<role>.<cell>.bak` (`role` is `author` or
   `review`) and verify its sha256; journal the cell — hashes and file mode — in
   the tree's git dir.
3. Apply the edits; assert `git diff --numstat` and `git status` name only that file.
4. When the mutated file's `packages/<pkg>/` differs from the test's — or a
   Playwright cell mutates app source — run `npm run build -w packages/<pkg>`.
   A test that reads its **own** package's `dist/` is not rebuilt for; give such
   a cell a test in another package, or build by hand around it.
5. Run only the target test file, in a fresh process (Playwright with
   `--retries=0`), and classify.
6. Refuse the restore (exit 3, nothing overwritten) if the file no longer holds
   the mutant the runner wrote — someone edited it during the run. Otherwise
   restore by `cp` from the verified backup and put the file mode back, check the
   sha256 and the mode, **rebuild again if step 4 ran** (`dist/` is gitignored, so `git status` cannot see a mutant build;
   the journal marks the tree dirty until this build succeeds), then require an
   empty `git status --porcelain`.

Every test run and build runs in its own process group, journalled while a cell
is in flight, so a signal or a timeout reaches what it spawned. It never stages,
commits, pushes, or runs `git checkout`, `stash` or `restore`, and it never
inverts an edit.

## Classes

| class | meaning | counts as caught |
|---|---|---|
| **caught** | an `expect_red` test failed on an assertion-type error, and the run reported the baseline's test count | yes |
| **survived** | green, same test count | no — diagnose it |
| **shadowed** | red on assertions, but in no `expect_red` test: another test caught it, so the named guard is not what pins the behaviour | no |
| **mutation-red** | red for the mutation's own reason — compile, import or SQL error, a non-assertion throw in a named test, a timeout, or a different test count | no — fix the mutation and re-run |

Assertion-type is `ERR_ASSERTION` for `node --test`, an `expect(` failure for
Playwright — with or without a custom message (`expect(v, 'msg')`, `expect.poll(…,
{ message })`; `PLAYWRIGHT_ASSERTION_SHAPE`, #4294; a message that itself holds a
blank line reads as an error) — and for vitest (`VITEST_ASSERTION_SHAPE`, #4284) an `AssertionError`
or the frontend's idiom: a jest-dom matcher (`Error: expect(element)…`), a
`getBy*` (`TestingLibraryElementError`), or a `findBy*` / `waitFor` timeout
(a plain `Error:` with the query library's "Unable to find …" or "Found …"
message); or the backend's idiom (#4456): a `.rejects` on a promise that
resolved (`Error: promise resolved "…" instead of rejecting`), or a failing
OpenAPI helper (`expectMatchesSpec`'s `Error: Response from … does not match
the '…' schema in openapi/spec.ts:`, `expectRejectsOffSpec`'s `Error: <METHOD>
<path> did not refuse the off-spec body …`). Deliberately an error: a
`.resolves` on a rejected promise (`Error: promise rejected "…" instead of
resolving`), which wraps whatever the code threw, and the OpenAPI helpers'
own contract throws ("OpenAPI spec has no path …"). Only the recorded stems
count; an unrecorded shape reads as an error, so a new one is added with a
recorded fixture case. Caveats the runner cannot see past:
`expect(fn).toThrow(/X/)` turns a thrown non-assertion error into an assertion
failure, so a SQL error inside such a test reads as caught — check the message.
A jest-dom matcher handed a non-element (`expect(undefined).toHaveClass(…)`) and a
`getBy*` used as setup rather than as the observation also read as assertion: the
runner sees only the failure message, not which line meant to assert.
A run with both kinds of failure is **caught** when any `expect_red` test failed on
an assertion, whatever else threw; with no named assertion red, a non-assertion
failure anywhere makes it **mutation-red**, not shadowed.

## Exit codes and the Closeout table

| exit | meaning |
|---|---|
| 0 | every cell caught (`census`: every sampled cell ran to a class) |
| 1 | at least one cell survived, was shadowed, was mutation-red, or was refused at its baseline |
| 2 | refused with nothing left mutated — before any cell, or after earlier cells ran and were restored (a later baseline wrote into the tree; an unexpected error with no journal pending) |
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
overwritten. So does a journalled process group that is still running — the test
or build the killed run started can still write a mutant build; wait for it, or
stop it with the `kill` command the message prints, then recover again. Recover from an exit 3 the same way; if the message names a staged
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
root that is the builder's tree or not registered at its own path, a HEAD other
than `--expect-head`, and an author result file (`prove-red-<issue>-mutate.json`)
produced in this same root. Its edits are
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
the environment the built run needs — `CI=1` and the `NEXT_PUBLIC_*`
placeholders the frontend's `test:e2e:*:built` scripts set — and the runner passes
it through.
[`frontend.md` § 4 Verification](../../../docs/contributing/ship-playbooks/frontend.md#4-verification)
says why those scripts rebuild every time, why mutation cells use `--retries=0`,
and what a cell costs.

## Known limits

These are stated so nobody counts them as proven:

- **The stale-lock break is race-checked, not race-tested.** A dead holder's
  lock is renamed away, re-read and, if its holder turns out to be alive, linked
  back; when even that fails (a third run took a fresh lock in between) the
  runner warns that two runs may be active. No fixture reproduces that
  interleaving deterministically.
- **Killing a child's whole process group on a signal is defence in depth.**
  `node --test` and `npm` forward signals to their own children, so no test can
  tell the group kill from a leader-only kill; the observable halves — children
  run detached, and `recover` waits for a journalled group — are tested.
- **Some checks are backstops behind earlier ones**: the sha256 and mode checks
  after the copy (the backup is verified before it), and the one-file `numstat`
  check after the mutation (a baseline that writes into the tree is refused
  first). Each survives its own mutation for that reason.
- `recover`'s `ps -o pid,command -g <pgid>` hint selects by process group on
  macOS; on Linux procps, use `ps -eo pid,pgid,command | awk '$2 == <pgid>'`.
- **`verify` refuses the builder's tree only from evidence it can read.** It
  refuses when `--builder` names this root, or when the author's
  `prove-red-<issue>-mutate.json` in `$SCRATCH` records this root. With no
  author result in `$SCRATCH` and a wrong `--builder`, it cannot tell, and runs.
  Pass the builder's real path.
- **Children run in their own process group**, so a kill aimed at
  `prove-red`'s own group (a harness timeout, for example) does not reach them.
  The journalled group id covers this: `recover` refuses while that group is
  alive and prints how to inspect and stop it.

## When not to use it

A mutation that belongs in CI forever — a test that imports a mutant copy of an
ESM module from a temp dir, as `scripts/ci/baseline-verdict-gate.test.mjs` does —
stays in the test file. `prove-red` is for the proofs that are run once per change
and recorded in the PR body.
