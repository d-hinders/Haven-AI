# Quality-scan — measurement blocks (#2501, #4471)

Loaded by [`quality-scan`](../SKILL.md) § *Method* step 4. Each block states
the **command**, the **sample** and **what clean looks like**; the figures
under each block are the run in which the command last produced a number —
its positive control until the ledger supersedes them. The prose here and in
the ledger explains; the machine-readable source of the commands and their
latest figures is `docs/quality/scan-baselines.json` (#4625), whose rows the
weekly `scan-remeasure.yml` re-runs at one SHA.

Blocks 1–6 are the classes the 2026-09-03 retrospective measured the 600-issue
wave to consist of. Blocks 8 and 9 are not: they come from the 2026-10-27
measurement of the 537 non-epic issues created 2026-09-20..2026-10-26 by
discovery channel, which found that two classes came mostly from live
purchases — a refusal labelled "transient, retry once" or left untyped (8 of 9
by title pattern), and one tool's output lost or refused across a hop (8 of
10). They are numbered 8 and 9, not 7 and 8: the ledger already uses "block 7"
for the retired *Chain health* block (#2775, `e91bca463`), and its delta rule
compares blocks by number. Block 10 is neither: it comes from the purchase QA of
2026-11-09 (#4754, #4755), which found two money defects no block looked for,
both visible from unpaid requests. Four rules hold for every block:

- **Use the instrument that exists; never re-implement it.** The money-path
  matcher is `scripts/ci/qa-freshness.mjs`'s `matchesGlob` (the one
  `money-path-classify.mjs` self-tests before it classifies anything); a mutation runs
  in a tree proven by `scripts/ci/review-isolation.mjs`, or in the builder's
  tree only behind a `cp` backup and a `git diff --quiet` after the restore.
  A second copy of a matcher is a second thing that can lie.
- **A number needs a positive control before it counts.** Block 4 carries one
  by construction; for the others, quote the run in which the command has
  produced a non-zero — the figures under blocks 1–6, taken on
  `origin/dev@893d74f6` (2026-09-03), are that control until a later run
  supersedes them in the ledger. Blocks 8 and 9 carry a seeded control of their
  own and their figures were taken at `aad313ad9` (2026-10-27), not at
  `893d74f6`; block 10 carries its own fixture controls and its figures were
  taken at `8486093df` (2026-11-11).
- **Run each instrument the way CI runs it, and prove the tools resolve.**
  A gate CI invokes with a flag answers a different question without it:
  `coupling-gate.mjs` runs `--strict` in `docs-coupling.yml`, and strict mode
  turns off the incidental-path filter for contract docs, so the same path can
  be named or ignored depending on the flag. The 2026-09-21 hardening of block
  2 first measured without `--strict`, got 12 of 14, and wrote an exception
  for the other two that CI never makes. Before any block, check that its
  tools exist in the shell you will run it in —
  `command -v rg >/dev/null || echo 'rg missing: every count below would be a broken-instrument zero — stop'`
  — because a missing `rg` prints `command not found` to stderr and a
  pipeline then reports `0`. (It only prints: an `exit` pasted into an
  interactive shell would close the session.) Block 2 has to run under
  `bash`, where `rg` may be absent; there it uses `grep -rl`, as the
  2026-09-21 run did. On the machine that ran the 2026-09-21 scan `rg`
  resolved only as a function the agent harness injects into its own shell;
  neither a plain `bash -l` nor `zsh -li` had it.
- **The bar is unchanged.** These blocks produce evidence; whether it qualifies as a
  structural finding or improvement candidate is decided by the canonical
  skill's respective bar. The skill still implements nothing and files nothing.

**Coverage applies to every block.** Follow the canonical skill's coverage
record: examined / partial / not examined, revision and command/result,
sample boundaries, and missing verification with its reason. “Clean” below
means clean within the stated, executed sample. A sample not run is never a
zero; report it as partial or not examined. A block may support an improvement
candidate without meeting the structural bar, but still needs evidence.

**1. Guard falsifiability — by execution, not by reading.** This replaces the
#1602 *guard effectiveness* bullet, keeping its ledger name. 56 money-path
guards asserted on names their module did not export and could not fail
(#2307, found by reading); the execution precedents are #2307's own
acceptance criterion (every retained guard mutation-proven red), #2044's
three unfalsifiable spies, and the ledger's 2026-08-19 baseline (5 hand
mutations → 4 caught); #2444 is the *not load-bearing at the tested
condition* diagnosis in the wild (a PASS with the payment still on the
delegate).

**Sample: money-path guard files that carry no recorded mutation, oldest
first.** A *guard file* is a test file whose path, with `.test.` removed,
matches a money-path glob (`.github/money-path-globs.json`, through the
classifier's own matcher) — `packages/backend/src/modules/x402/__tests__/foo.test.ts`
is one because `…/foo.ts` matches `packages/backend/src/modules/x402/**`.
*No recorded mutation* is measured against the record of past cells, and the
record is stated here because it decides the sample.

**What record of past cells exists, and why the sample does not read it.**
Three were checked at `8486093df`:
- `prove-red` result files (`$SCRATCH/prove-red-<issue>-<mode>.json`) — the
  runner's own output, but `$SCRATCH` is per-session and nothing commits them,
  so no file survives to be read.
- PR bodies' mutation tables — durable, and 154 of the 300 merged PRs in
  2026-10-01..2026-11-11 mention a mutation. But a table names a guard by its
  sentence (`an undeclared hosted-only key fails`), not by path: 0 of the 300
  carry a `Guard file` column, so no row joins to a file.
- the ledger's block-1 lines — prose, and the same problem (`bare-hash
  refusal`, `audit rotation bound`).

No record is usable at file granularity, so the criterion is met the way the
issue allows: sample money-path guard files **not changed in the last 20
first-parent landings**, with **N = 20** — the same window the previous sample
used, so the change is which side of the window, not a new window. A file no
landing has touched in 20 landings is the code least likely to have been
mutated already, which is the property the sample wants.

```bash
# Sample: money-path guard files NOT changed by the last 20 first-parent
# landings on dev, oldest first (the file that has gone longest without a
# landing goes first). Falls back to the previous sample — test files changed
# by those landings whose diff also touched a money-path file, newest landing
# first — when the filtered set is empty.
node -e '
import("./scripts/ci/qa-freshness.mjs").then(async (q) => {
  const cp = await import("node:child_process")
  const git = (...a) => cp.execFileSync("git", a).toString()
  const globs = q.loadMoneyPathGlobs()
  const landings = git("log", "--first-parent", "origin/dev", "-n", "20", "--format=%h").trim().split("\n")
  const recent = new Set()
  for (const s of landings) for (const f of git("show", "--format=", "--name-only", s).trim().split("\n").filter(Boolean)) recent.add(f)
  const isGuard = (f) => /\.test\.(ts|tsx|mjs)$/.test(f) && globs.some((g) => q.matchesGlob(f.replace(/\.test\.(ts|tsx|mjs)$/, ".$1"), g))
  const rows = git("ls-files", "packages").trim().split("\n").filter((f) => isGuard(f) && !recent.has(f))
    .map((f) => ({ f, sha: git("log", "-1", "--format=%h", "--", f).trim(), at: Number(git("log", "-1", "--format=%ct", "--", f).trim()) }))
    .sort((a, b) => a.at - b.at)
  if (rows.length) {
    for (const r of rows) console.log(r.sha, r.f)
    console.log("candidate guard files:", rows.length)
    return
  }
  const seen = new Set()
  for (const s of landings) {
    const files = git("show", "--format=", "--name-only", s).trim().split("\n").filter(Boolean)
    if (!files.some((f) => globs.some((g) => q.matchesGlob(f, g)))) continue
    for (const t of files.filter((f) => /\.test\.(ts|tsx|mjs)$/.test(f))) if (!seen.has(t)) { seen.add(t); console.log(s, t) }
  }
  console.log("candidate guard files:", seen.size)
})'
# Budget (below): 5 census mutations, one per file, in the order the census
# lists them (oldest first), plus up to 2 targeted probes — never promise the
# whole sample. Per mutation: invert or delete the condition the guard names in
# its own title. Save the output above to $SCRATCH/census-<scan>.txt, write one
# `census` cell per sampled file (plus the probes) to
# $SCRATCH/prove-red-<scan>-cells.json, then:
node scripts/ci/prove-red.mjs census --issue <scan> --candidates "$SCRATCH/census-<scan>.txt"
```

**The output is a contract `prove-red` consumes.** `parseCandidates`
(`scripts/ci/prove-red.mjs:419`) reads `<sha> <file>` lines and a
`candidate guard files: N` line, and `selectCensus` (`:449`) takes the first
five listed. The command keeps that shape and lists files in the order the
runner should take them — oldest first — printing, per file, the commit that
last touched it. The fallback branch prints the landing that changed the file,
which is the same field under the old sample's meaning.

**Fallback, not a second sample.** When every money-path guard file changed in
the last 20 landings, the filtered set is empty and the command prints the
previous sample instead: test files changed by those landings whose diff also
touched a money-path file, newest landing first. That branch is the old command
unchanged; a run that takes it says so in its block-1 line.

[prove-red](../../prove-red/SKILL.md) § *census* picks the sample, runs each
cell against a green baseline, restores and verifies it, and prints the block-1
table; the cell schema and the classes are there, not here.

Clean: every mutation fails the guard's own assertion (a compile or SQL red
does not count; see Budget). A survivor is reported with one of the four
diagnoses the repo already uses — *weak test* (asserts something
the mutation does not touch), *dead code* (the mutated line is unreachable),
*not load-bearing at the tested condition* (the guard holds elsewhere), or
*shadowed* (the named guard stays green while another test catches the
mutation) — never as a bare count. On `893d74f6`: 9 candidate files; the control mutation
(#2483's `you should append --json` → `you may append`) took
`agent-connection-setups.test.ts` from 107 passed to 1 failed; 1 of 1 caught.
That 9 is the **old** newest-landing sample's figure and stays as its control.
On `8486093df` the new sample reads **253 candidate guard files**, oldest
first; the first five are `packages/mcp-server/src/auth.test.ts` (`f5f259f0d`),
`boot.test.ts` (`48f9fc34a`), `log.test.ts` (`418c8ce96`), `http.test.ts`
(`78107695c`) and `packages/signer/src/node-version.test.ts` (`ba14f39e4`).

**Budget: 5 census mutations plus up to 2 targeted probes.** The five are the
first five files the census lists, one mutation each, in that order (oldest
first). A probe is one of two kinds, the two that found the 2026-10-19 run's
weak guards: the
*second copy* of a guard a census mutation caught (M5, `client.ts:1936`,
green in its own package and caught only across a package boundary → C3; M5
was also that run's fifth census target), and a *count-only pin*, one that
asserts only a length or count (M7, which survived → C4). That run's M6 (`evals/graders.ts`, outside the census,
caught) fits neither kind and is out of budget; there is no third kind,
because M6 was caught and yielded no finding. A red counts only when the
guard's own assertion fails. A compile or SQL error is the mutation's red,
not the guard's: M1's first form reddened 6 tests on an unreferenced `$1`,
so keep the parameter referenced (`(sa.user_id = $1 OR TRUE)`) and re-run.

**2. Contract-doc `covers:` completeness — derived from claims vs declared.**
#2425's runbook was born declaring 5 of the 12 files its body made claims
about (its own `last-verified` note records the widening); a change to the
other 7 would never have re-implicated it.

```bash
# Sample: every doc whose FRONT-MATTER declares `contract: true` — the key
# read from the FIRST front-matter block only. A whole-file grep cannot do
# that: `rg -l "^contract: true" docs --glob '*.md'` returns 8 at `99ef8d063`
# and 8 at `f11274ada`, and one of the 8 is
# `docs/contributing/docs-quality-system.md`, which carries the key only
# inside its body's front-matter schema example (`:49`) and has no `contract`
# key of its own (`:1-29`; its `last-verified` chain records the same at
# `docs/archive/last-verified-chains-2026-09.md:467`). The front-matter read
# returns 7 at both SHAs. An unanchored grep returns 25 at `99ef8d063` and 26
# at `f11274ada`: the 8 plus 10 casp-changelog shards and 7 docs that mention
# the phrase in prose (8 at `f11274ada`, the 2026-10-30 scan report being the
# extra one). Shards are dated records and never carry the key, so they are
# excluded by construction, not by list.
# The match is `^contract: true` followed by whitespace or end of line — the
# trailing-comment form, because the repo's own parser strips a trailing
# ` # comment` from a scalar (`scripts/docs/validate-frontmatter.mjs:216-218`)
# and `coupling-gate.mjs:548` reads `parsed.data.contract === 'true'`.
# Derivation, as a command: every backticked path in the BODY that exists
# as a tracked file, diffed against the declared `covers:` (globs matched by
# prefix). A heuristic — the reader judges each miss; the coupling gate's
# reverse walk (`coupling-gate.mjs`, #2457) names the declared side.
FM='FNR==1{c=0} /^---$/{c++; next} c==1 && /^contract: true([[:space:]]|$)/{print FILENAME; nextfile}'
# Counter-control, before the loop: the selector must read the front-matter
# block and nothing else. A fixture whose BODY carries the key must NOT be
# selected; one whose front matter carries it MUST be. A fixture tests the
# selector's logic, not today's repository, so it does not depend on
# `docs-quality-system.md:49` staying unindented.
CTL=$(mktemp -d)
cat > "$CTL/body-only.md" <<'EOF'
---
owner: "@x"
status: current
covers:
  - scripts/docs/**
last-verified: "2026-10-30"
---

contract: true
EOF
cat > "$CTL/front-matter.md" <<'EOF'
---
owner: "@x"
status: current
contract: true
covers:
  - scripts/docs/**
last-verified: "2026-10-30"
---

no key in the body
EOF
awk "$FM" "$CTL/body-only.md" | grep -q . && echo "CONTROL FAILED body-only fixture selected"
awk "$FM" "$CTL/front-matter.md" | grep -q . || echo "CONTROL FAILED front-matter fixture not selected"
rm -rf "$CTL"
set -f  # no pathname expansion: `packages/signer/**` must stay a glob STRING, not become the directory listing
for d in $(git ls-files 'docs/*.md' | xargs awk "$FM" | sort); do
  declared=$(awk '/^---$/{c++; next} c==1' "$d" | awk '/^covers:/{f=1;next} f&&/^  - /{sub(/^  - /,"");print;next} f{f=0}' | sort -u)
  claimed=$(awk '/^---$/{c++; next} c>=2' "$d" | grep -o '`[^` ]*`' | tr -d '`' | grep -E '^(packages|scripts|\.github)/[^ ]+\.[a-z]+$' | sort -u | while read p; do git ls-files --error-unmatch "$p" >/dev/null 2>&1 && echo "$p"; done)
  missing=0; for p in $claimed; do hit=0; for g in $declared; do case "$g" in *'**'*) [[ "$p" == "${g%%\*\**}"* ]] && hit=1;; *) [ "$p" = "$g" ] && hit=1;; esac; done; [ $hit = 0 ] && missing=$((missing+1)); done
  echo "$d declared=$(echo "$declared" | grep -c .) cited=$(echo "$claimed" | grep -c .) cited-but-not-covered=$missing"
done
set +f
```

The series converts: the old selector's 17 (2026-10-26) is the new 15 plus
the body-example doc's 2, and its 18 (2026-09-25 to 10-21) was taken on the
same false 8-doc sample, so the next run's drop from 17 to 15 is that doc
leaving the sample, not two misses fixed.

Run it under `bash` — zsh does not word-split `$claimed`, and the loop then
reports one miss per doc whatever the truth is (measured: that is exactly the
false reading a first draft of this block produced). Keep the `set -f`: without
it the unquoted `for g in $declared` expands every `**` entry into the
directory's contents before the match, and every glob-covered file counts as
a miss — the 2026-09-21 run first reported 21 misses for the runtime doc
against a true 7 that way, and the figures below, the 2026-09-15 /
2026-09-17 ledger entries and the 2026-09-17 bug report §4 were taken
without it (the corrected values are given in parentheses below). Clean:
`cited-but-not-covered=0` on every doc, and no doc whose body cites nothing
while its `covers:` is wide (over-wide: the doc trips on changes it says
nothing about). Report both directions with the file names — and **confirm
every miss with the gate CI runs before it becomes a finding**:
`node scripts/docs/coupling-gate.mjs --strict --changed=<path>` must NOT name
the doc for a path the loop reports as uncovered. The loop is a heuristic over
glob strings; the gate is the authority, and `--strict` is how CI invokes it
(without the flag the gate drops test and generated paths swept up by a
wildcard, which strict mode keeps for contract docs — see *Run each
instrument the way CI runs it* above). On `99ef8d063` and `f11274ada` the
loop reports 15 misses across 5 of 7 documents with the front-matter selector,
against 19 across 6 of 8 with the whole-file grep. Measured
on `e42ed68f` with `--strict`: of the first reading's 21 misses, the gate names
the runtime doc for all 14 false ones and for none of the 7 true ones, so the
confirmation alone would have settled that reading. On `893d74f6`:
8 contract docs; `docs-quality-system.md` cites 17 existing paths and covers
3 of them (10 with `set -f`), `mcp-runtime-compatibility.md` 18 and 5 (11
with `set -f`), `dev-environment.md` 5 and 1 (unchanged); `delegation-rail-security-model.md` declares 23 and cites 0.
The 8 there included the body-example doc (C1, 2026-10-30); at `893d74f6` it
also had no front-matter key.

**3. Stale numbers in prose — re-derive from the instrument.** Two figures
that reached CASP shards and had to be corrected in place: #2421's shard
(`2026-09-02-2421.md:110`) claimed `39 passed` for a run that was 38 passed,
1 failed; #2423's shard (`2026-09-03-2423.md`, lines 26 and 36) said 27
files where the re-run gave 33. A figure without its command cannot be
re-taken, so it cannot be caught.

The figure shape has to match those founding specimens, and a ratio-only
regex (`N of M`, `N/M`, `N%`) matches none of the three lines (#3348). The
shape below adds bold numbers and count nouns. It stays single-line: 2423's
`**33` wraps before `files`, but the bold shape matches line 26 on its own,
so `rg -U` is not needed. Run the positive control first; a control that
fails means the regex cannot say yes, and its zero is not a finding.

```bash
R='\b[0-9]+ of [0-9]+\b|\b[0-9]+/[0-9]+\b|\b[0-9]+%|\*\*[0-9]+(\*\*|[ ,;:)]|$)|\b[0-9]+ (passed|failed|skipped|red|files|commits|tests|runs|rows|lines|hits|matches)\b'
# Positive control: every founding specimen line must match.
for spec in 2026-09-02-2421.md:110 2026-09-03-2423.md:26 2026-09-03-2423.md:36; do
  sed -n "${spec##*:}p" "docs/regulatory/casp-changelog/${spec%%:*}" | rg -q "$R" || echo "CONTROL FAILED $spec"
done
# Sample A: figure-bearing LINES (not matches) in the 25 newest shards by
# dated name (not `ls -t`: mtime in a fresh worktree is checkout order), and
# how many of those lines also quote the command that produced the figure.
rg -n "$R" $(ls docs/regulatory/casp-changelog/2026-*.md | sort | tail -25) | wc -l
rg -n "$R" $(ls docs/regulatory/casp-changelog/2026-*.md | sort | tail -25) | rg -c '`(rg|grep|git|node|npm|find|ls|wc) '
# Sample B: the manifest's rows (`docs/quality/scan-baselines.json`, #4625) —
# run `node scripts/docs/scan-remeasure.mjs --sha <sha>` and read each delta;
# the ledger's `Probed clean:` lines are prose and carry no runnable command.
# Its `docFigures` section re-runs the figures quoted in current docs, so a doc
# row enters this block by construction (#4631).
rg -c ': any\b|as any' packages/*/src --type ts -g '!*test*' | awk -F: '{s+=$2} END{print s}'
npm run lint:db-mocks 2>&1 | rg 'db-mock gauge'
```

Clean: every re-derived figure matches its recorded one or the drift is
explained; every figure-bearing shard line carries a command. Report the
mismatches as `recorded → now` with the command. On `893d74f6` the old
ratio-only regex reported 18, but that was `rg -o | wc -l`, i.e. 18 matches
on 14 lines, with 1 carrying a command. These figures reproduce at
`893d74f6` with the dated-name sample; the original mtime order cannot be
recovered. On `9b06b174`, with the shape and sampling above: 11
figure-bearing lines across the 25 newest shards (`2026-09-24-3271` …
`2026-09-26-rpc-error-key-scrub`), 2 with a command. Three of the 11 are not
measured figures: a `10%` protocol constant, a `404/500` status pair and a
`4/4` slice number. The old regex found exactly those 3 lines and missed
every specimen;
ledger re-derivations against the 2026-08-19 entry: `any` 14 → 18, gate
scripts 27 → 24, db-mocks 62/465/66 → 58/312/61, zod 0 → 0.

**4. Retired-vocabulary residue — with a positive control.** The Safe-rail
retirement (#1440) ran to 43 sub-issues (`gh api graphql` →
`subIssuesSummary { total completed }` → 43/43) plus the residue rounds
#1993 and #2107 after the epic was "done"; `gh issue list --state all
--search 'safe-retirement in:title' --limit 200 --json number | jq length` → 53. A sweep
that cannot tell a live copy from a historical one re-files them. The
residue has a code half too: an exported function with no live importer.

```bash
# Terms: the identifiers the last removal epic's shards list as deleted
# (#1440 / #2055 today — update the list when the next epic retires more).
T='executeAllowanceTransfer|generateTransferHash|hasTokenAllowanceConfigured|decideCoverage|legacy-authorize|allowance-nonce|safe_approver_metadata|approval_requests|pendingApprovals|approval queue'
# THIS file holds the list, so it is excluded: an instrument that counts
# itself reports one live copy on a clean tree. (Until 2026-09-22 the line
# below excluded SKILL.md, which never held the list — the exclusion pointed
# at the wrong file from the day this block landed in #2506, and every run
# since counted this file as one live copy: on `e42ed68f` the corrected
# exclusion reads 191 / 46 / 145 against the 192 / 46 / 146 recorded then.)
rg -l -i "$T" docs packages .agents scripts -g '*.md' -g '*.ts' -g '*.tsx' -g '*.mjs' -g '*.json' -g '!node_modules' -g '!**/dist/**' -g '!.agents/skills/quality-scan/references/dimensions.md' | sort > "$SCRATCH/rv-files.txt"
# Positive control: the shards that RECORD the deletion must match, so a zero
# here means the instrument is broken, not that the residue is gone.
rg -l -i "$T" docs/regulatory/casp-changelog | wc -l
# Partition: historical = shards, ledger, archive, bug-reports, or a doc
# whose front-matter `status:` is not `current`; everything else is live.
live=0; hist=0; : > "$SCRATCH/rv-live.txt"
while read f; do s=$(awk '/^---$/{c++; next} c==1 && /^status:/{print $2; exit}' "$f" 2>/dev/null)
  case "$f" in docs/regulatory/casp-changelog/*|docs/quality/scan-ledger.md|docs/archive/*|docs/bug-reports/*) hist=$((hist+1));;
  *) if [ -n "$s" ] && [ "$s" != "current" ]; then hist=$((hist+1)); else live=$((live+1)); echo "$(rg -c -i "$T" "$f") $f" >> "$SCRATCH/rv-live.txt"; fi;; esac
done < "$SCRATCH/rv-files.txt"
echo "files=$(wc -l < "$SCRATCH/rv-files.txt") historical=$hist live=$live"; sort -rn "$SCRATCH/rv-live.txt" | head
# Code half: an exported repository function whose only references outside
# its defining file are tests (or comments) is dead by construction — a
# grep-able positive control. Current specimen: three exports #2479 left in
# x402-authorizations.ts because they were outside its named list.
for n in recordX402Signature confirmX402Intent failPendingX402Intent; do echo "== $n"; rg -l "$n" packages --glob '!**/__tests__/**' -g '!**/dist/**'; done
```

**A scope is a filter over `rv-live.txt`, never a hand count.** A run limited
to some packages takes its in-scope figure from the partition the command
already wrote, so tests stay counted as live exactly as they are tree-wide:

```bash
grep -cE ' packages/(mcp|mcp-server|signer|demo-merchant-mcp)/' "$SCRATCH/rv-live.txt"    # in-scope live files
grep -E  ' packages/(mcp|mcp-server|signer|demo-merchant-mcp)/' "$SCRATCH/rv-live.txt" | grep -cE '\.test\.ts$|__tests__'   # of which tests
```

On `e42ed68f` that reads **16 live, 7 of them tests**. The 2026-09-21 report
first wrote 10 — "6 tests, and 4 non-test lines" — a hand-kept list that had
missed one test, both package READMEs and three source files: the one number
in that block not produced by its instrument.

Clean: positive control > 0, and every live file is either a guard that names
the term to assert its absence (a `*retired*.test.ts`, a banned-list) or a
`status: current` doc that describes the term as history in the same
sentence. Report the live files by class with the top counts. On
`893d74f6`: positive control 31 shards; 176 files carry a copy — 39
historical, 137 live — backend tests and `openapi/spec.ts` lead;
`docs/architecture/03-payment-sequence.md` is `status: current` with 10
copies. Code half: `failPendingX402Intent` returns only its defining file;
`recordX402Signature` and `confirmX402Intent` return the defining file plus
one comment line in `packages/qa-agent/src/run.ts:76` — no importer for any
of the three.

**5. Merge-method drift on `dev` — first-parent, by subject and by head.**
Feature → dev is squash; 44% of the wave's landings arrived as merge commits,
which is what made the promotion recipes and the head-SHA reads go wrong
(#1173, #2116). The remedy landed on 2026-09-07: `Dev merge` (ruleset 22449193)
makes `dev` squash-only, so a window starting after that date probes clean by
construction — a merge-commit landing then means the ruleset was changed, and
that is the finding. Before it, the post-promotion sync-back (`sync/*`, or
`main` itself) was merge-merged on purpose and is counted `LEGIT` below; the
owner dropped the sync-back on 2026-09-26 (`branch-and-release-flow.md` §
*Promotion to production*). **Bar interaction:** this dimension never yields
an epic — a `Probed clean` baseline and, on evidenced drift, a possible
improvement candidate. Filing
requires explicit approval and the canonical skill's new-task handoff.

```bash
# Sample: every first-parent landing on dev in the window. Record the SHA
# the counts were taken at — dev moves between a fetch and a report, and a
# figure without its SHA cannot be re-taken (this block's first draft quoted
# counts from one fetch and a PR list from the previous one). The window is
# an explicit instant: a bare `--since=2026-08-10` is a git approxidate that
# takes the CURRENT time of day, so the same SHA counted 257, 256 and 255
# over one evening.
git rev-parse --short origin/dev
git log --first-parent origin/dev --since=2026-08-10T00:00:00Z --format=%s | awk '/^Merge pull request/{m++} /\(#[0-9]+\)$/{s++} END{print "merge-commit:",m+0,"squash:",s+0,"total:",NR}'
git log --first-parent origin/dev --since=2026-08-10T00:00:00Z --format='%h %ad %s' --date=short | grep ' Merge pull request' | head -5
# Merge landings by head: the legitimate sync-backs (`main`, `sync/*`) apart,
# then by branch prefix — which merge path defaults wrong is what a remedy
# targets.
git log --first-parent origin/dev --since=2026-08-10T00:00:00Z --format=%s | grep '^Merge pull request' | sed -E 's#.* from d-hinders/##' | awk -F/ '{p=$1; if($0 ~ /^(main$|sync\/)/) p="LEGIT(main|sync/*)"; c[p]++} END{for(k in c) print c[k], k}' | sort -rn
```

Clean: `merge-commit` equals the `LEGIT` count in the window — every
merge-commit landing is a sync-back. Report the count with and without the
sync-backs, the prefix table, and the five most recent wrong-method landings
by PR number and date. On `893d74f6`, since 2026-08-10T00:00:00Z: 274
merge-commit, 346 squash, 623 total (3 subjects match neither shape); of the
274, 4 are `sync/*` sync-backs and 0 are `main`, leaving 270 wrong-method; by
prefix `fix` 142, `feat` 43, `claude` 20, `docs` 18, `test` 12, `codex` 10,
`chore` 10, `refactor` 5, `feature` 5, `ci` 3, `release` 1, `hotfix` 1; the
latest five are #2494, #2493, #2479, #2480 and #2481, all on 2026-09-03.

**6. Nets with holes — each gate's allowlist vs the content class it checks,
and each gate's green-without-running branches.** This replaces the *CI gate
coverage vs. what is actually exercised* bullet. #2317, #2333, #2318, #2088,
#1903, #1896 and #2300 were each a gate green on a file it never read; the
hole is measurable before the next one is found by hand. For qa-dev the "did
the harness run every leg" half is enforced twice, and both fail the
`money-flow` job:
- (a) the `Coverage completeness` step in `.github/workflows/qa-dev.yml`
  exits 1 on `green-with-skips:` (blocking since #1066, no
  `continue-on-error`);
- (b) `packages/qa-agent/src/run.ts` exits 1 on any skip under
  `QA_REQUIRE_ALL_LEGS=1`, which is set as a repo variable
  (`gh variable list | grep QA_REQUIRE_ALL_LEGS`).

The freshness gate reads the `money-flow` **job** conclusion (`selectGreenRun`,
`moneyFlowJobConclusion`), so a skipping run is never admitted. The
instrument is therefore job level: `gh run view <id> --json jobs --jq
'.jobs[]|select(.name=="money-flow")|.conclusion'`. The step-level
`completenessWarningFromJobs` that `qa-freshness.mjs` once carried could never
fire — it looked for a failed `Coverage completeness` step inside a run whose
`money-flow` job had succeeded, a pair GitHub cannot produce while the step
blocks — and #3368 removed it. What keeps that safe is pinned instead:
`packages/qa-agent/src/skip-marker.test.ts` fails if the `money-flow` job ever
gains `continue-on-error`, or the step stops running on `if: success()` or stops
exiting 1 on the marker.

```bash
# Copy lint: files that can carry product copy but are outside SCAN_DIRS and
# SCAN_FILES, run through the lint's own matcher. The list is a pinned
# `git ls-tree`, not a pathspec: in a plain pathspec `**` is not special (`*`
# already crosses `/`), so `packages/sdk/src/**/*.ts` forces one more
# directory level and reaches 0 of the 46 non-test files directly under
# `packages/sdk/src` (115 before the `.test.` exclusion) — #4611. The content
# read is pinned to the same SHA — `git show <sha>:<file>` — because
# `fs.readFileSync` reads the live checkout, and a file deleted after <sha>
# would crash the read.
SHA=e0617aa9f
git ls-tree -r --name-only "$SHA" packages/frontend/src packages/sdk/src | grep -E '\.(ts|tsx)$' | grep -vE '\.test\.|__tests__|/app/|/components/|/hooks/' > "$SCRATCH/cl.txt"
# Positive control: the listing must reach the top level of both trees.
grep -cE '^packages/sdk/src/[^/]+\.ts$' "$SCRATCH/cl.txt"             # 46 at e0617aa9f
grep -cE '^packages/frontend/src/[^/]+\.(ts|tsx)$' "$SCRATCH/cl.txt"  # 1 at e0617aa9f
node -e 'import("./scripts/frontend-copy-lint.mjs").then(async (m) => { const fs = await import("node:fs"); const cp = await import("node:child_process"); const sha = process.argv[2]; const files = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter((f) => !m.SCAN_FILES.includes(f)); let hit = 0; for (const f of files) { const n = m.findCopyIssues(cp.execFileSync("git", ["show", sha + ":" + f], { encoding: "utf8" })).length; if (n) { hit++; console.log(n, f) } } console.log("unscanned:", files.length, "with hits:", hit) })' "$SCRATCH/cl.txt" "$SHA"
# Money-path perimeter: files that call a money verb but match no glob.
rg -l -e 'sendTransaction|redeemDelegation|signTypedData|sendUserOperation|executeTransaction|broadcastTransaction' packages --type ts -g '!*test*' -g '!**/dist/**' > "$SCRATCH/mv.txt"
node -e 'import("./scripts/ci/qa-freshness.mjs").then(async (q) => { const fs = await import("node:fs"); const globs = [...q.loadMoneyPathGlobs(), ...q.loadMoneyPathControlGlobs()]; const files = fs.readFileSync(process.argv[1], "utf8").trim().split("\n"); const out = files.filter((f) => !globs.some((g) => q.matchesGlob(f, g))); console.log("verb files:", files.length, "outside perimeter:", out.length); console.log(out.join("\n")) })' "$SCRATCH/mv.txt"
# Visual gate: app routes no visual spec shoots.
comm -23 <(find packages/frontend/src/app -name 'page.tsx' | sed -E 's#packages/frontend/src/app##; s#/page\.tsx$##; s#/\([^)]*\)##g; s#^$#/#' | sort -u) <(rg -o "'/[a-z][a-z0-9/-]*'" packages/frontend/e2e/*.visual.spec.ts | sed -E "s/.*:'([^']*)'/\1/" | sort -u)
# Docs-quality boundary: Markdown neither front-mattered nor in the
# packages/** manifest.
git ls-files '*.md' | grep -vE '^(docs/|packages/|README|CLAUDE|AGENTS|ABOUT_HAVEN)' | wc -l
# Second half — exit branches: for each gate, the branches on which it
# returns green WITHOUT exercising the content it claims to check. Re-read
# them from the script; for qa-freshness.mjs at 893d74f6 they are:
#   - coverage is derived from money-path-globs.json alone (§ "Gap 1",
#     ~line 520): a behaviour edit outside the globs is invisible;
#   - version-bump-only money-path diffs are partitioned out of coverage,
#     logged but green (#2164, lines 917–929);
#   - the `qa-override` label bypasses with a warning only (lines 41, 128,
#     150, 283);
#   - `headSha` is the branch tip at trigger time, not the deployed SHA, on
#     `schedule` / `workflow_dispatch` runs (KNOWN LIMIT, lines 131–136).
rg -n "Gap 1|#2164|qa-override|KNOWN LIMIT" scripts/ci/qa-freshness.mjs | cut -c1-120
```

Clean: each list is empty or every entry is exempted by name with a reason
(the copy lint's `CONVENTION_EXEMPT`, the classifier's control globs, a
visual spec's stated scope, `EXEMPT_PACKAGE_DOCS`), and every exit branch is
documented in the script and named in `autonomous-pr-loop.md`'s safety
model. Report per gate: what it does not reach, which entries carry the
content class, and the exit-branch list with line numbers. **Take the
docs-boundary count pinned** — `git ls-tree -r --name-only <sha>` rather than
`git ls-files`, which reads the live worktree: re-taken unpinned on a branch
that ADDS a Markdown file, this block reads 44 where the pinned figure is 43,
and the extra file is the reader's own change. (Observed on this block's own
review; the same hazard is why block 5 prints its SHA.) On `e0617aa9f`:
copy lint 111 unscanned files, 14 with hits — the frontend's 4, unchanged
from the glob's reading, plus 10 files at the SDK's top level the glob could
not see, carrying 16 hits: 6 in agent-facing strings (one each in six files)
and 10 in JSDoc (the documented false-positive class); money path 32 verb
files, 20 outside the perimeter (qa-agent pilots, backend scripts,
`sdk/src/sweep.ts`, `frontend/src/lib/hybridAccountOps.ts`); visual gate 15 of
27 app routes shot (12 not shot); 43 Markdown files outside both docs-quality
boundaries. The copy-lint figure is pinned to that SHA; the other three are
live-tree readings taken at that checkout, so they drift with the tree (see
the note below).

The series converts: every ledger entry from 2026-09-15 to 2026-11-02
(#4609 adds the tenth) quoted the glob's reading — 75 / 6, 87 / 6, 98 / 6,
52 / 4, 56 / 4, 60 / 4, 64 / 4, 64 / 4, 66 / 4 — and this block's own
recorded 72 / 5 at `893d74f6` was taken the same way, with that SHA's
`SCAN_FILES`, that SHA's matcher and the filter before `fe491ac24` added
`/hooks/`. The 72 reproduces on that list; the 5 is that SHA's matcher —
today's matcher reads 7 on the same list, because the three `src/hooks/`
files are hits under the pre-`/hooks/` filter and the matcher changed 222
lines between the two SHAs. Re-run with today's allowlist and filter it reads
35 / 4. So the next entry's step from 66 / 4 to 111 / 14 is the selector
change, not 45 new unscanned files.

**Observation for the lint's owner, not a decision of this block:** the six
agent-facing strings the glob never reached are
`packages/sdk/src/tools.ts:158`, `tool-descriptions.ts:261`,
`x402-protocol.ts:459`, `merchant-completion.ts:570`,
`x402-funding-leg.ts:440` and `types.ts:2058` — all `transaction hash`, in
tool descriptions or agent-read error text. Whether they join `SCAN_FILES`
is #2317's call (#3882 is the precedent); this block only reports them. The
money-path, visual-gate and docs-boundary halves of this fence still read
the live tree — out of scope for #4611, which fixes the copy-lint half only.

**8. Refusal census — what the backend suite's own answers become at the hosted
mapper.** The 2026-10-27 channel measurement found the refusal class came
mostly from live purchases (8 of 9 by title pattern), and the scan had found
refusal-family defects too (#3213, #3214, #4458). This block asks the question
from the tree: when a backend route refuses, does the hosted mapper
(`normalizeError`, `packages/mcp-server/src/tools/support/errors.ts`) answer it
with a step the agent can follow, or does it fall through to the generic
`API_ERROR` branch? A trial of this block on 2026-10-27 produced #4468 (task-
and sub-budget refusal mapping) and #4470 (retry class).

```bash
# Prerequisites: the core and SDK builds (the mapper's imports resolve to their
# dist), and the backend suite's own database.
npm run build -w packages/core && npm run build -w packages/mcp-server
docker compose up -d postgres
# 1. Record. The recorder is a vitest setup file that wraps the `fastify`
#    factory with an `onSend` hook. It is inert unless HAVEN_RESPONSE_RECORDING
#    is set, truncates its file at the start of each run, writes a seeded
#    control row, and is never part of the backend's own config.
node scripts/ci/refusal-census.mjs record --out "$SCRATCH/recording.ndjson"
# 2. Join. Every distinct error row is fed to the built `normalizeError` the way
#    the SDK transport hands it over: the full body (bounded), and the message
#    built as `error: details` (haven-api-transport.ts:123-137). The dedupe key
#    keeps the decorating fields the mapper reads — payment_id, revert_cause,
#    task_budget_id — so two rows that answer differently are not collapsed.
node scripts/ci/refusal-census.mjs block8 --recording "$SCRATCH/recording.ndjson"
```

**Sample: backend route tests only** — the test files that call `Fastify(`
themselves (134 at `aad313ad9`). The shared `buildApp()` helper
(`packages/backend/src/__tests__/helpers.ts:9`) mounts none of the payment
routes, so hooking it would record almost nothing. The local MCP, the CLI and
the signer's own refusals are **outside** this sample.

**Route set.** The agent payment routes are a rule, not a hand list: every
`POST` under `/payments`, `/x402` or `/machine-payments`
(`AGENT_PAYMENT_ROUTE_RE` in the instrument). The trial's named three
(`POST /payments`, `POST /x402`, `POST /x402/authorize`) are a subset; the 5xx
section adds `POST /payments/:id/sign`, which the rule already covers.

**Clean:** no unmarked typed code on an agent payment route reaches
`API_ERROR`; every 5xx on those routes either answers a typed non-transient
step or is marked `deliberately-transient` in
`scripts/ci/refusal-census-allowlist.json`; no non-answer (timeout,
unreachable, non-JSON) reads as a refusal. Report the marked and unmarked rows
apart, so a new unmarked code is visible rather than absorbed.

**Positive control:** a seeded synthetic unmapped code next to a known mapped
one — `delegation_expired` must be answered and `refusal_census_control` must
be reported. A checkout of `bffb8dc97^` would rot as sibling modules move, and
it would edit `packages/mcp-server/src`, which this file's first rule allows
only in an isolated tree.

**Self-test and empty-run refusal.** `scripts/ci/refusal-census.test.mjs` runs
in the always-run *Repo CI config checks* job (`node --test
scripts/ci/*.test.mjs`, `.github/workflows/ci.yml:91`), so it needs no `npm ci`
and no build. On a fixture recording and fixture `normalizeError` results it
proves the join can say yes and no: a code the fixture mapper answers is not
reported as unmapped, a seeded unmapped code is reported, and a mapper that
answers nothing fails the control. It covers the join only — not the real
`normalizeError`, which is the block command's job against the built package.
The block command refuses an empty run before it reads anything: `assertPlausible`
rejects a recording below the 200-row floor (`MIN_ROWS`) or one that carries no
`/__refusal-census-control` row with `refusal_census_control` — the row the
recorder writes once at truncate time, so a file left over from an earlier run
is refused rather than measured.

**False-positive classes.**
- *A refusal answered before `normalizeError` by a tool-level handler* — the
  census cannot observe the answer, so a row it reports may already be handled:
  `state-direct-recovery.ts:809-847` (`close_needs_reprepare` /
  `close_outcome_unconfirmed` on the sub-budget path),
  `catalog-purchase.ts:862-866`, `quote-response.ts:442-453`.
- *Test stub routes* — a route a test registers to answer a fixed error is not
  a backend refusal: `GET /contacts/boom`, `GET /boom`, and
  `client-compat.test.ts`'s own `/payments/:id`.

**Baseline (`aad313ad9`, 2026-10-27).** Backend suite: 543 files, 542 green,
287.99 s wall; the red file is `ops-readonly-role.test.ts`, whose 20 failing
tests all say `permission denied to create role` (the local database grant).
Recording: 1,972 rows from 120 test files; 1,613 error rows (1,504 4xx, 109
5xx) from 116 test files; 563 distinct `(method, route, status, code)` keys.
Typed rows: 174 distinct, 157 of them reach the generic `API_ERROR` branch,
most on owner routes. On the payment routes: 20 typed rows (13 distinct codes)
reach `API_ERROR`; three are deliberately generic or answered elsewhere —
`client_outdated` 426 (the body carries its own step, and the generic branch
drops it), `invalid_request` 400, `prepare_failed` 502 (deliberately
transient); the other 10 are #4468's. 5xx: 46 distinct keys in all; of the 14
on `POST /x402/authorize`, `POST /payments` and `POST /payments/:id/sign`, 10
get a typed non-transient answer, 3 get the generic transient step correctly
(`prepare_failed` ×2, a delegate-account deploy failure), and 1 is a test's own
control (`allowance-rail-retired.test.ts`, 500). SDK sites: 41
`new HavenApiError(` sites in non-test `packages/sdk/src` — 35 with a literal
status (15 at 500/502, `408`, `0`, and 18 at 4xx), 6 with a variable status
(listed with its source; `merchant-completion.ts:271` carries the merchant's
own status); 14 of the 15 5xx sites were executed and all answer transient,
#4470 judges nine of them deterministic; the two transport non-answers (`408`,
`0`) answer "refused as made (4xx)" (#4470).

**Re-run with this block's own instrument (2026-10-27, `origin/dev@2b82a465b`).**
543 files, 543 green, 29.28 s wall; 2,206 rows; 1,614 error rows; 574 distinct
keys; 156 typed rows reach `API_ERROR`; SDK sites 41 (36 literal, 5 variable —
the transport's own `res.status` site is the sixth the trial counted as
literal); non-answers: 2 recorded rows plus the `408` and `0` SDK sites; both
halves of the positive control passed. The deltas against the trial are the
recording's own (a different database, a different run), not a different
question. The trial's red file (`ops-readonly-role.test.ts`) is green here
because this run's database grants the role; the trial's figures stand as the
first baseline.

**The block's own finding, closed.** Re-running the join on that same recording
against the tree after #4468 merged (PR #4483) reads **142** typed rows instead
of 156, and no task- or sub-budget code remains unmarked: the ten codes the
trial found are answered by their own branches. The recording is unchanged —
only the mapper moved — which is what makes the join a measurement rather than
a snapshot.

**9. Field round-trip — what the backend emits vs what each SDK mapper reads.**
The hop class (8 of 10 by title pattern) is a field that one side writes and
the other never reads. This block compares the 2xx bodies of the agent's read
routes, from the same recording, with the `raw.<key>` set each SDK mapper reads.
A trial on 2026-10-27 produced #4469 (receipt-list fields).

```bash
# Same recording as block 8 — one `record` run feeds both blocks.
node scripts/ci/refusal-census.mjs block9 --recording "$SCRATCH/recording.ndjson"
```

**Sample: backend route tests only** — the 2xx bodies those tests produced. A
route with no recorded 2xx body is reported as partial, never as clean.

**Route set and mapper set.** The route set is the six agent read routes the
SDK maps, one per `MAPPERS` entry: `GET /machine-payments/receipts`
(`mapPaymentReceipt`), `GET /machine-payments/:id/status`
(`mapPaymentStatusResult`), `GET /payments` (`mapPaymentResult`),
`GET /agents/:id/task-budgets` (`mapTaskBudget`), `GET /agents/:id/sub-budgets`
(`mapSubBudget`) and `GET /catalog` (`mapCatalogEntry`). The instrument's
`MAPPERS` table names, per mapper, the route whose body it reads and the
backend file that builds that body. Two mappers in the SDK's mapper files are
**partial, not measured**, so the table is the measured subset:
`mapSupersession` (`account-reads.ts:138`) maps the nested `superseded_by`
object of `GET /machine-payments/allowances` (`account-reads.ts:471`) and
destructures `{ agent_id, superseded_at }` rather than reading `raw.<key>` on
the route body, so the top-level-key join cannot see it — `mapperReadKeys`
would return an empty set and report every emitted key on that route as unread;
`paymentStateFromRaw` (`payment-state.ts:136`) maps the bodies of the write
routes the SDK calls (`POST /payments` 201, `POST /x402`,
`POST /payments/:id/sign`), not a read route, so this block's read-route join
does not measure it. The receipt mapper is read through
`scripts/ci/vocabulary-divergence.mjs`'s exported `scanReceiptSurface`
(the same 31 receipt keys), with `readBlock` and `stripCommentsAndStrings` for
the others — not a second key extractor.

**Self-test and empty-run refusal.** Block 8's paragraph covers both, and the
same file covers this join: `roundTrip` runs on the fixture recording and both
control halves must pass, and `assertPlausible` refuses the same short or
control-less recording before either block reads it.

**Clean:** every emitted key is read by the route's mapper or named in
`READ_OUTSIDE_MAPPER`; every read key is emitted in the recording, or its
builder emits it in a state the recorded tests did not reach (reported, with
that flag).

**Positive control:** a seeded control key that nothing emits must be reported,
and a key the recording does emit (`payment_id` on the receipt route) must not
be.

**False-positive classes.**
- *Read-never-emitted* — a key counts only after a grep scoped to the route's
  body builder (non-test `src`, excluding migrations and `openapi/spec.ts`)
  finds no emitter. A key that is also a column or a spec property would
  otherwise always grep non-zero. The seeded control key is the check that the
  grep can say no.
- *Emitted-never-read* — keys read outside the mapper: `client_update`
  (`haven-api-transport.ts:121`, spliced in by `client-compat.ts:353`), and
  `total` / `has_more` / `next_cursor` in `listReceiptsPage`. Stub routes are
  the same class as block 8's.

**Recorder ordering.** The recorder's `onSend` is registered inside the factory,
before any route or middleware, so it runs **before** `client-compat.ts:353`
splices `client_update` into a body. A recorded 2xx body therefore does not
carry `client_update`, which is why that key is in `READ_OUTSIDE_MAPPER` rather
than reported as emitted-but-unread.

**Baseline (`aad313ad9`, 2026-10-27).** Emitted but never read:
`GET /machine-payments/receipts` — 6 keys `mapPaymentReceipt` never reads
(#4469); `GET /machine-payments/:id/status` — `mpp`, which
`PaymentStatusResult` and `RawPaymentStatusResult` declare
(`packages/sdk/src/types.ts:2329`, `:2607`) but `mapPaymentStatusResult` never
sets. Read but never emitted: `GET /machine-payments/:id/status` — 5 keys, all
emitted in backend source (`modules/payments/agent-payment-status.ts`) in states
the recorded tests did not reach; that is this direction's known
false-positive class.

**Re-run with this block's own instrument (2026-10-27, `origin/dev@2b82a465b`).**
Emitted but never read: 11 keys — the trial's 7 (the six receipt keys, with
`delivery_quality` as the wire name of the delivery verdict, and `mpp`), plus
four the wider mapper set reaches: `spent_display` and `remaining_display`
(`mapTaskBudget`), `is_live` (`mapSubBudget`), `endpoint_host`
(`mapCatalogEntry`). Read but never emitted: 12 keys — the trial's 5 on
`GET /machine-payments/:id/status`, plus 7 on `GET /payments`
(`error_message`, `explorer_url`, `chain_id`, `fee`, `signed_at`,
`submitted_at`, `expires_at`), all emitted in `routes/payments.ts` in states the
recorded tests did not reach. Both halves of the positive control passed.

**The block's own finding, closed.** Re-running the join on that same recording
against the tree after #4469 merged (PR #4479, squash `8cdcf8811`) reports
**5** emitted-but-never-read keys instead of 11: `mapPaymentReceipt` now reads
all six receipt keys in block form (`payment-mappers.ts:190-211`), so the five
that remain are `mpp`, `spent_display`, `remaining_display`, `is_live` and
`endpoint_host`. Read but never emitted is unchanged at 12. The recording is
unchanged — only the mapper moved — which is what makes the join a measurement
rather than a snapshot.

**10. Catalog conformance — the row against the merchant's own 402, and the
header the SDK would build.** No block compared a catalog row with the
merchant's 402, or measured the payment header the SDK builds from it. The
purchase QA of 2026-11-09 found two money defects no block looks for, both
visible from unpaid requests: #4754 (a doubled EIP-3009 payment header answered
HTTP 431 after funding — 4,969 bytes at Anchor and 6,520 at CoinGecko, because
the v2 envelope echoes the merchant's `extensions`) and #4755 (the Anchor
calldata row carries no `http_method` or `body_example`, while the merchant's
402 to a POST declares `method: POST, bodyType: json`). The same hand probe
found three more HTTP rows whose 402 declares query parameters the catalog
cannot carry.

**Two tiers, because of the owner decision of 2026-11-10 on #4757.** A default
whole-repo scan may send unpaid requests to hosted Haven on dev; unpaid requests
to third-party merchants happen only when the person starting the scan asks for
them.

- **Default tier (every run).** The block's offline fixture controls, plus the
  unauthenticated `GET /catalog` of hosted Haven on **dev**, used only to list
  which rows are `status: active` and their `protocol`, `source` and
  `endpoint_host`. Nothing is sent to a merchant.
- **Third-party tier (only when the starter asks for third-party probes).**
  Every `status: active`, `source: operator`, `protocol: http` row whose
  `endpoint_host` is not Haven-operated. The Haven-operated hosts excluded are
  the demo merchant's two deployments (migration 058):
  `demo-merchant-dev-84e4.up.railway.app` and
  `enthusiastic-blessing-production-171f.up.railway.app` — both `protocol: mcp`,
  which this block does not cover either. The report quotes the request that
  turned the tier on. Without it the block writes
  `block 10 → third-party tier not examined → third-party probes not requested`.

**Where the probe target comes from.** The public listing carries neither
`resource_url` nor the call fields (`PUBLIC_CATALOG_FIELDS`,
`packages/backend/src/routes/catalog.ts:85-101`). The block states its source: a
locally migrated database at the scan SHA (the one blocks 8 and 9 already need),
labelled "seed rows at `<sha>`", or a dev agent's authenticated `GET /catalog`,
which returns only rows on that agent's own chain (`routes/catalog.ts:340-341`).
A scan session may hold a **dev** agent key; block 10 uses it for that read
only. A session never holds a production agent key and never reads hosted Haven
production. The rows file the third-party tier probes is built by that match:
each listed row joined to its target on `name` and `endpoint_host` together; a
listed row with no match, or more than one, is reported as "no probe target" and
not probed. A row count of 0 from a source is reported the same way, not as
clean. The live-call rule applies to the listing read: record the deployed
revision before the first call where it can be read, or write "not
determinable", which is a coverage limit.

**Probe (third-party tier only).** One unpaid request per row, as the row
declares it. No payment header, no signer, no Haven payment tool, no credential
or cookie, redirects not followed, one attempt. Rows with `source: bazaar` are
never probed: their URLs are seller-chosen and unreviewed, and the backend's own
refresh reaches them only through its guarded fetch. A row answering anything
but 402 is reported, not retried.

**Half A, call semantics.** The row's method, body type and body example against
the 402's `extensions.bazaar.info.input` (method, bodyType, body or
queryParams). Report rows whose declared shape differs, and rows whose 402
declares parameters the catalog has no column for. A 402 that carries no
`extensions.bazaar.info.input` is reported as `no declared input`, a lead and
never a match: a row with no declared method is probed with GET
(`merchant-catalog.ts:447`, the refresh's own default), Anchor's GET answer to
the calldata row carried no input, and the mismatch was in its POST answer
(#4755). The block does not send a second request with another method.

**Half B, header budget.** For each 402, build the payment header the SDK would
send, through the real `x402V2PaymentEnvelope` with a fixed dummy authorization,
and print its byte length, the names `x402RetryHeadersFor` returns, the product
of the two, and the size of the largest echoed extension. The built header is
never sent. Live figures exist only in the third-party tier; the default tier
runs half B over the fixture alone.

- Clean: every product is at or under **6,520 bytes**, the largest header
  observed to succeed (#4754). A product above **9,938 bytes**, the observed
  failure (2 × 4,969 against Anchor), is a finding; between the two it is a
  lead.
- Since #4756 (merged after this issue's measurement base) a v2 payload goes out
  under one header name, so at the tip the product equals the header length.
  Re-read `packages/sdk/src/x402.ts` at the scan SHA and say so in the block's
  line.

```bash
# Prerequisite: the SDK build — half B goes through the real envelope.
npm run build -w packages/sdk
# Default tier, every run: the offline fixture controls, then the dev listing.
node scripts/ci/catalog-conformance.mjs fixtures
node scripts/ci/catalog-conformance.mjs listing
# Third-party tier, only when the starter asked for third-party probes: one
# unpaid request per row, from a row source the block names.
node scripts/ci/catalog-conformance.mjs probe --rows "$SCRATCH/catalog-rows-<scan>.json"
```

**Positive control (offline, every run).** Half A: a committed fixture pair, one
catalog row and one 402 whose `extensions.bazaar.info.input` declares a
different method and a query parameter, which the comparison must report; a
matching pair, which it must not; and a third pair whose 402 carries no input,
which must be reported as `no declared input`. A known match alone would only
show that both sides parse. Half B: a fixture challenge with an echo of 5 KB or
more. In the third-party tier the Anchor token-price row (POST, declared,
matches) is the live control.

**False-positive classes, stated** (third-party tier): a merchant that is down;
a merchant whose GET and POST 402s differ; a row on a chain the environment does
not list. And for both tiers: a row the tier does not cover (Haven-operated,
`protocol: mcp`, `source: bazaar`) is out of sample, not clean.

**Baseline figures.** The fixture controls at `8486093df` (the PR's base):
`fixtures` → the mismatch pair reported (`method: row GET, 402 POST; body: row
none, 402 json; query parameters the catalog cannot carry: network`), the
matching pair not reported, the no-input pair reported as `no declared input`;
half B over the large-echo fixture → header **7,976 bytes**, names
`PAYMENT-SIGNATURE` (1), product **7,976 bytes**, largest echoed extension
**5,122 bytes** → lead. The default tier's listing read, taken
2026-11-11T02:37Z: **26 entries, 24 active, 12 http/operator, 12 mcp/operator, 0
bazaar**; the third-party tier would cover 12 rows across 7 hosts
(`api.anchor-x402.com`, `api.linkedpanda.com`, `api.nansen.ai`, `minifetch.com`,
`pro-api.coingecko.com`, `services.ampersend.ai`,
`services.sandbox.ampersend.ai`). For the third-party tier, the 2026-11-09 hand
probe recorded in #4754 and #4755 stands, labelled as taken by hand, until the
first run whose starter asks for third-party probes supersedes it.

**Reporting.** Each tier is reported on its own line: `examined`, `partial`, or
`not examined → <reason>` (network unavailable; third-party probes not
requested). Neither is ever a zero.

**Self-test.** `scripts/ci/catalog-conformance.test.mjs` runs in the always-run
*Repo CI config checks* job (`node --test scripts/ci/*.test.mjs`), so it needs no
`npm ci` and no build. It proves the join can say yes and no on the committed
fixtures, and the budget arithmetic and its thresholds on a fixture encoder; it
does not prove the real envelope produces the bytes — that is `fixtures` mode's
job against the built package, and the figures above are what it printed.

**Not a manifest row.** Block 10 does not join
`docs/quality/scan-baselines.json`: it needs the network (the dev listing, and
the third-party tier on request) and an SDK build, while a manifest row must be
cheap, offline, and carry the newest `Probed clean` entry's SHA with a `$SHA`
command (`scripts/docs/scan-baselines.test.mjs`). Its fixture figures live here
and in the ledger entry, not in the manifest.

**Probe: residual archaeology — what merged PRs say they did not solve.** Not a
numbered block: it is the replacement for reading `TODO`s, and it produces leads
for candidates, never a structural finding on its own. The repository now names
its unsolved problems in PR bodies, not in comments: `git grep -c -w -E
'TODO|FIXME|HACK|XXX' 49747fac3 -- 'packages/*/src/*' | wc -l` → **0 files**
(control, the same command with `import` → 2,303), and all three product
candidates of the 2026-10-30 run cite a merged PR's own statement of a residual
(`scan-ledger.md:2330` PR #4544, `:2338` PR #4546, `:2342` PR #4479).

**Sample: PRs merged to `dev` in the scan window.** The window is bounded by
**instants**, never dates: a date-only range grows within hours (2026-10-30..
2026-11-09 read 112 at 2026-11-09T21:40Z and 114 later that day). Quote the
count beside the time it was taken.

```bash
# Sample: PRs merged to dev in the window, bounded by instants.
FROM=2026-10-30T00:00:00Z; TO=2026-11-09T21:40:00Z
gh pr list --state merged --base dev --search "merged:$FROM..$TO" --limit 300 --json number,title,body > "$SCRATCH/prs.json"
# Extract the inline `Residual risk:` line and every residual heading's
# top-level bullets; print the ones that cite no issue or PR.
node -e '
const fs = require("node:fs")
const prs = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const inline = /^[-*]?\s*\**Residual risk:\**[ \t]*(\S.*)$/gim
const heading = /^#{2,3}\s*(Residual risk|Not covered|Not in scope|Follow-?ups?|Deferred|Known limits?|Out of scope)/gim
const none = /^(none|n\/a|no)\b/i
let withInline = 0, saysNone = 0, withHeading = 0, bullets = 0, cited = 0
for (const pr of prs) {
  const body = pr.body ?? ""
  const lines = [...body.matchAll(inline)].map((m) => m[1].trim()).filter(Boolean)
  if (lines.length) withInline += 1
  saysNone += lines.filter((t) => none.test(t)).length
  const sections = [...body.matchAll(heading)]
  if (sections.length) withHeading += 1
  for (const m of sections) {
    const rest = body.slice(m.index + m[0].length)
    const stop = rest.search(/^#{1,3}\s/m)
    const section = stop === -1 ? rest : rest.slice(0, stop)
    for (const b of section.split("\n").filter((l) => /^[-*]\s+\S/.test(l))) {
      bullets += 1
      if (/#\d+/.test(b)) cited += 1
      else console.log(`#${pr.number} ${b.trim().slice(0, 160)}`)
    }
  }
  for (const l of lines) if (!none.test(l) && !/#\d+/.test(l)) console.log(`#${pr.number} Residual risk: ${l.slice(0, 160)}`)
}
console.log(`PRs ${prs.length}; inline Residual risk ${withInline} (${saysNone} say none); residual headings ${withHeading}; bullets ${bullets}, ${cited} citing an issue or PR`)
' "$SCRATCH/prs.json"
```

**Report:** the residuals that cite no issue number, grouped by surface, each
with its PR number. Each is a **lead for a candidate, not a finding** — the
structural bar is unchanged, and a residual a PR already names is prior art the
scan must not re-file as new.

**Clean:** every residual in the window either cites an issue or PR, or is
accepted by a recorded owner decision. **False-positive classes:** a residual
that says `none`; a residual accepted by a recorded owner decision; a residual
already tracked under another wording (the same defect named differently in
another PR or issue).

**The `TODO` grep stays as a one-line control, not as a step.** It is the
existing `comment-archaeology-markers` row in `docs/quality/scan-baselines.json`
with its `import` control row, and `REQUIRED_BLOCKS` in
`scripts/docs/scan-baselines.test.mjs` keeps `comment-archaeology`. A zero from
it is a control that the instrument can still say no, not a finding.

**Baseline (window 2026-10-30T00:00:00Z..2026-11-09T21:40:00Z, taken
2026-11-11T02:44Z):** 112 PRs; 55 carry an inline `Residual risk:` line, 6 of
those say none; 15 carry a residual heading; 59 top-level bullets in those
sections, 4 citing an issue or PR. The same figures the issue recorded at
2026-11-09T21:40Z, reproduced by this command — the instant-bounded window is
what makes them stable.

**Not a manifest row.** The `gh` census cannot join
`docs/quality/scan-baselines.json`: a manifest row must carry the newest
`Probed clean` entry's SHA and a `$SHA` command
(`scripts/docs/scan-baselines.test.mjs`), and this one reads GitHub at a wall
clock, not a commit. The `comment-archaeology-markers` row stays the manifest's
record of the `TODO` control.
