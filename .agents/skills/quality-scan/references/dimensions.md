# Quality-scan — wave-dimension measurement blocks (#2501)

Loaded by [`quality-scan`](../SKILL.md) § *Method* step 3. Each block states
the **command**, the **sample** and **what clean looks like**; the figures
under each block are the run in which the command last produced a number —
its positive control until the ledger supersedes them.

The 2026-09-03 retrospective over the 600-issue wave measured what the wave
was made of; these are its seven classes, one block each, so a reader can
re-take any of them and the ledger can tell "no finding" from "did not look".
Three rules hold for every block:

- **Use the instrument that exists; never re-implement it.** The money-path
  matcher is `scripts/ci/qa-freshness.mjs`'s `matchesGlob` (the one
  `money-path-classify.mjs` self-tests before it classifies anything); chain
  arithmetic is `scripts/docs/chain-integrity.mjs`'s exports; a mutation runs
  in a tree proven by `scripts/ci/review-isolation.mjs`, or in the builder's
  tree only behind a `cp` backup and a `git diff --quiet` after the restore.
  A second copy of a matcher is a second thing that can lie.
- **A number needs a positive control before it counts.** Block 4 carries one
  by construction; for the others, quote the run in which the command has
  produced a non-zero — the figures under each block, taken on
  `origin/dev@893d74f6` (2026-09-03), are that control until a later run
  supersedes them in the ledger.
- **The bar is unchanged.** These blocks produce evidence; whether it is one
  of the run's two findings is decided by § *The bar*, and the skill still
  implements nothing and files nothing.

**1. Guard falsifiability — by execution, not by reading.** This replaces the
#1602 *guard effectiveness* bullet, keeping its ledger name. 56 money-path
guards asserted on names their module did not export and could not fail
(#2307, found by reading); the execution precedents are #2307's own
acceptance criterion (every retained guard mutation-proven red), #2044's
three unfalsifiable spies, and the ledger's 2026-08-19 baseline (5 hand
mutations → 4 caught); #2444 is the *not load-bearing at the tested
condition* diagnosis in the wild (a PASS with the payment still on the
delegate).

```bash
# Sample: test files changed by the last 20 first-parent landings on dev
# whose diff also touched a money-path file (the classifier's own matcher).
node -e '
import("./scripts/ci/qa-freshness.mjs").then(async (q) => {
  const cp = await import("node:child_process")
  const globs = q.loadMoneyPathGlobs()
  const shas = cp.execFileSync("git", ["log", "--first-parent", "origin/dev", "-n", "20", "--format=%h"]).toString().trim().split("\n")
  const seen = new Set()
  for (const s of shas) {
    const files = cp.execFileSync("git", ["show", "--format=", "--name-only", s]).toString().trim().split("\n").filter(Boolean)
    if (!files.some((f) => globs.some((g) => q.matchesGlob(f, g)))) continue
    for (const t of files.filter((f) => /\.test\.(ts|tsx|mjs)$/.test(f))) if (!seen.has(t)) { seen.add(t); console.log(s, t) }
  }
  console.log("candidate guard files:", seen.size)
})'
# Budget: at most 5 mutations per run, one per file, newest landing first —
# never promise the whole sample. Per mutation: back up, invert or delete the
# condition the guard names in its own title, run that file, restore, prove.
cp <prod-file> "$SCRATCH/backup" && sed -i '' 's/<guarded condition>/<inverted>/' <prod-file>
npx vitest run <test-file> 2>&1 | grep -E 'Tests |Test Files'
cp "$SCRATCH/backup" <prod-file> && git diff --quiet -- <prod-file> && echo restored
```

Clean: every mutation turns its file red. A survivor is reported with one of
the three diagnoses the repo already uses — *weak test* (asserts something
the mutation does not touch), *dead code* (the mutated line is unreachable),
or *not load-bearing at the tested condition* (the guard holds elsewhere) —
never as a bare count. On `893d74f6`: 9 candidate files; the control mutation
(#2483's `you should append --json` → `you may append`) took
`agent-connection-setups.test.ts` from 107 passed to 1 failed; 1 of 1 caught.

**2. Contract-doc `covers:` completeness — derived from claims vs declared.**
#2425's runbook was born declaring 5 of the 12 files its body made claims
about (its own `last-verified` note records the widening); a change to the
other 7 would never have re-implicated it.

```bash
# Sample: every doc whose FRONT-MATTER declares `contract: true` — the
# anchored `^contract: true` (8 docs). An unanchored grep returns 18: the
# same 8 plus 7 casp-changelog shards and 3 contributing docs that mention
# the phrase in prose. Shards are dated records and never carry the key, so
# they are excluded by construction, not by list.
# Derivation, as a command: every backticked path in the BODY that exists
# as a tracked file, diffed against the declared `covers:` (globs matched by
# prefix). A heuristic — the reader judges each miss; the coupling gate's
# reverse walk (`coupling-gate.mjs`, #2457) names the declared side.
for d in $(rg -l "^contract: true" docs --glob '*.md' | sort); do
  declared=$(awk '/^---$/{c++; next} c==1' "$d" | awk '/^covers:/{f=1;next} f&&/^  - /{sub(/^  - /,"");print;next} f{f=0}' | sort -u)
  claimed=$(awk '/^---$/{c++; next} c>=2' "$d" | grep -o '`[^` ]*`' | tr -d '`' | grep -E '^(packages|scripts|\.github)/[^ ]+\.[a-z]+$' | sort -u | while read p; do git ls-files --error-unmatch "$p" >/dev/null 2>&1 && echo "$p"; done)
  missing=0; for p in $claimed; do hit=0; for g in $declared; do case "$g" in *'**'*) [[ "$p" == "${g%%\*\**}"* ]] && hit=1;; *) [ "$p" = "$g" ] && hit=1;; esac; done; [ $hit = 0 ] && missing=$((missing+1)); done
  echo "$d declared=$(echo "$declared" | grep -c .) cited=$(echo "$claimed" | grep -c .) cited-but-not-covered=$missing"
done
```

Run it under `bash` — zsh does not word-split `$claimed`, and the loop then
reports one miss per doc whatever the truth is (measured: that is exactly the
false reading a first draft of this block produced). Clean:
`cited-but-not-covered=0` on every doc, and no doc whose body cites nothing
while its `covers:` is wide (over-wide: the doc trips on changes it says
nothing about). Report both directions with the file names. On `893d74f6`:
8 contract docs; `docs-quality-system.md` cites 17 existing paths and covers
3 of them, `mcp-runtime-compatibility.md` 18 and 5, `dev-environment.md` 5
and 1; `delegation-rail-security-model.md` declares 23 and cites 0.

**3. Stale numbers in prose — re-derive from the instrument.** Two figures
that reached CASP shards and had to be corrected in place: #2421's shard
(`2026-09-02-2421.md:110`) claimed `39 passed` for a run that was 38 passed,
1 failed; #2423's shard (`2026-09-03-2423.md`, lines 26 and 36) said 27
files where the re-run gave 33. A figure without its command cannot be
re-taken, so it cannot be caught.

```bash
# Sample A: figure-bearing lines in the last 7 days of CASP shards, and how
# many of them also quote the command that produced the figure.
rg -n -o '\b[0-9]+ of [0-9]+\b|\b[0-9]+/[0-9]+\b|\b[0-9]+%' $(ls -t docs/regulatory/casp-changelog/2026-*.md | head -25) | wc -l
rg -n '\b[0-9]+ of [0-9]+\b|\b[0-9]+/[0-9]+\b|\b[0-9]+%' $(ls -t docs/regulatory/casp-changelog/2026-*.md | head -25) | rg -c '`(rg|grep|git|node|npm|find|ls|wc) '
# Sample B: the previous ledger entry's `Probed clean:` lines — re-run each
# recorded command verbatim and diff the number.
rg -c ': any\b|as any' packages/*/src --type ts -g '!*test*' | awk -F: '{s+=$2} END{print s}'
npm run lint:db-mocks 2>&1 | rg 'db-mock gauge'
```

Clean: every re-derived figure matches its recorded one or the drift is
explained; every figure-bearing shard line carries a command. Report the
mismatches as `recorded → now` with the command. On `893d74f6`: 18
figure-bearing lines across the 25 most recent shards, 1 with a command;
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
# The skill file holds this very list, so it is excluded: an instrument that
# counts itself reports one live copy on a clean tree.
rg -l -i "$T" docs packages .agents scripts -g '*.md' -g '*.ts' -g '*.tsx' -g '*.mjs' -g '*.json' -g '!node_modules' -g '!**/dist/**' -g '!.agents/skills/quality-scan/SKILL.md' | sort > "$SCRATCH/rv-files.txt"
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
(#1173, #2116). The rule is direction-dependent: the post-promotion sync-back
(`sync/*`, or `main` itself) is deliberately MERGE-merged onto `dev`
(`branch-and-release-flow.md` § *After every promotion*), so those heads are
counted separately, never as drift. **Bar interaction, stated so a future run
does not suppress it:** the remedy is one ruleset edit
(`allowed_merge_methods: ["squash"]` on `dev`, the mirror of #2165 on
`main`), so this dimension never yields an epic — it yields a `Probed clean`
baseline and, on drift, a `new-task`.

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
hole is measurable before the next one is found by hand. The "did the gate
run at all" half has no dedicated instrument: the real observable is the
jobs-API completeness warning in `scripts/ci/qa-freshness.mjs`
(`completenessWarningFromJobs`, lines 555–575, #1044 — advisory only; the
freshness gate still passes on a green-with-skips run).

```bash
# Copy lint: files that can carry product copy but are outside SCAN_DIRS and
# SCAN_FILES, run through the lint's own matcher.
git ls-files 'packages/frontend/src/**/*.ts' 'packages/frontend/src/**/*.tsx' 'packages/sdk/src/**/*.ts' | grep -vE '\.test\.|__tests__|/app/|/components/' > "$SCRATCH/cl.txt"
node -e 'import("./scripts/frontend-copy-lint.mjs").then(async (m) => { const fs = await import("node:fs"); const files = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter((f) => !m.SCAN_FILES.includes(f)); let hit = 0; for (const f of files) { const n = m.findCopyIssues(fs.readFileSync(f, "utf8")).length; if (n) { hit++; console.log(n, f) } } console.log("unscanned:", files.length, "with hits:", hit) })' "$SCRATCH/cl.txt"
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
rg -n "Gap 1|#2164|qa-override|KNOWN LIMIT|completenessWarningFromJobs" scripts/ci/qa-freshness.mjs | cut -c1-120
```

Clean: each list is empty or every entry is exempted by name with a reason
(the copy lint's `CONVENTION_EXEMPT`, the classifier's control globs, a
visual spec's stated scope, `EXEMPT_PACKAGE_DOCS`), and every exit branch is
documented in the script and named in `autonomous-pr-loop.md`'s safety
model. Report per gate: what it does not reach, which entries carry the
content class, and the exit-branch list with line numbers. **Take the
docs-boundary count pinned** — `git ls-tree -r --name-only <sha>` rather than
`git ls-files`, which reads the live worktree: re-taken unpinned on a branch
that ADDS a Markdown file, this block reads 37 where the pinned figure is 36,
and the extra file is the reader's own change. (Observed on this block's own
review; the same hazard is why block 5 prints its SHA.) On `893d74f6`:
copy lint 72 unscanned files, 5 with hits (all identifier-shaped — the
documented false-positive class); money path 29 verb files, 20 outside the
perimeter (qa-agent pilots, backend scripts, `sdk/src/sweep.ts`,
`frontend/src/lib/hybridAccountOps.ts`); visual gate 4 of 24 app routes
shot; 36 Markdown files outside both docs-quality boundaries.

**7. Chain health — headroom under the ceiling, and duplicates.** #2477's
chain reached 774,483 bytes through concatenating merges; the gate now
refuses a line over 64 KiB or carrying a duplicate entry, but only on the
doc a PR changes — the scan reports headroom before it fails someone at push.

```bash
# Sample: every doc with a `last-verified` line, measured with the gate's own
# parser and ceiling.
node -e '
import("./scripts/docs/chain-integrity.mjs").then(async (m) => {
  const fs = await import("node:fs"); const cp = await import("node:child_process")
  const files = cp.execFileSync("git", ["ls-files", "docs/*.md", "docs/**/*.md", "README.md", "CLAUDE.md", "AGENTS.md", "ABOUT_HAVEN.md"]).toString().trim().split("\n")
  const rows = []
  for (const f of files) { const line = m.lastVerifiedLine(fs.readFileSync(f, "utf8")); if (!line) continue; const a = m.chainAnomalies(line); rows.push({ f, bytes: line.length, pct: (100 * line.length / m.MAX_CHAIN_BYTES).toFixed(1), dups: a.duplicates.length }) }
  rows.sort((a, b) => b.bytes - a.bytes)
  console.log("docs:", rows.length, "ceiling:", m.MAX_CHAIN_BYTES, "with duplicates:", rows.filter((r) => r.dups).length)
  for (const r of rows.slice(0, 5)) console.log(r.bytes, r.pct + "%", "dups=" + r.dups, r.f)
})'
```

Clean: no line above 80% of `MAX_CHAIN_BYTES` and `with duplicates: 0`.
Report the top five with their headroom, and every doc carrying duplicates —
those are latent gate failures waiting for the next editor. State the unit:
the guard compares `line.length`, i.e. UTF-16 code units of the line without
its newline, so quote that and not `wc -c` (which counts bytes plus the
newline and reads 64,231 for the same line). On `893d74f6`: 92 docs;
`mcp-runtime-compatibility.md` at 63,961 units of 65,536 (97.6%) one merge
after its #2477 compaction — the doc `release-bump.mjs` re-pins on every
release; `05-agent-api-openapi.md` carries 31 duplicate entries among 66.
