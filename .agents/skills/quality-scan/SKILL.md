---
name: quality-scan
description: Repeatable structural code-quality scan — sweeps the repo for the one or two biggest structural weaknesses, reports them with measured evidence, and stops for a human decision. Never implements, never files on its own; approved findings hand off to new-task.
---

# Quality Scan

Sweep the codebase for its **one or two biggest structural weaknesses**, report
them with hard evidence, and stop. This skill exists to make an occasional,
high-altitude scan repeatable — same method every run, and a ledger that
remembers what earlier runs found and what was decided, so standards escalate
instead of resetting to whoever happens to run it.

It does **not** implement anything, and it does **not** file issues on its own.
On explicit approval of a finding, append the disposition to the ledger and
hand off to [new-task](../new-task/SKILL.md) to create the epic and its slices —
following its **Epics** section, which is what gets the `epic` label and the
sub-issue links right. A finding filed without those is a tracking issue nothing
can query and `ship-next` cannot pull from.

## Scope

Bare invocation sweeps the whole repository. An argument narrows it:
`quality-scan packages/frontend` or `quality-scan --area=backend` scans only
that surface, judged by the same bar.

## The ledger (read it FIRST)

`docs/quality/scan-ledger.md` records every run: date, scope, findings, and
each finding's **disposition** — `shipped`, `accepted-as-debt`, or `rejected`,
with the reason. Before scanning:

1. Read the ledger and collect every prior finding and its disposition.
2. **Exclude prior findings from this run's report** — including
   `accepted-as-debt` ones. A conscious decision to live with something is a
   decision; re-surfacing it un-changed is nagging, not scanning.
3. The one exception: evidence that a prior finding has **materially
   worsened**. Then report it, say explicitly that it is a re-surface, and
   cite the delta against the ledger's recorded numbers ("was 1,059 positional
   mocks at 2026-07; now 1,730").

After a run, append the new entry (date, scope, findings, dispositions once
decided). The ledger is committed history — never rewrite old entries.

Two conventions make an entry re-measurable by a future run (the ledger header
also records a third — disposition upkeep — owned by
[ship-next](../ship-next/SKILL.md)'s closeout, not by this skill):

- **Measurement blocks.** Every evidence number is written as
  `command → number` (or names the script/ratchet that produced it). The bar
  already requires reproducibility; recording the command is what makes the
  exclusion rule's "cite the delta against the recorded numbers" a one-command
  check instead of a reconstruction. The only prior finding that could be
  re-measured cheaply was the one a ratchet happened to exist for — and the
  db-mock ratchet's own history shows ad-hoc recounting goes wrong (it once
  counted the pattern's name inside a comment). A finding whose number no
  ratchet or script reproduces gets a small script under `scripts/quality/`.
- **Probed clean.** Every entry ends with a `Probed clean:` section —
  `dimension → command → number` for each dimension probed that produced no
  qualifying finding. These are the baselines the next run diffs against, and
  together they map which dimensions are exhausted (where the next run should
  dig deeper rather than re-probe from zero). The 2026-08-18 entry did this
  informally; it is required from now on.
- **Wave-dimension coverage (#2501).** `Probed clean:` names every block in
  *Method* § *Wave dimensions* by its number, each as
  `block N → command → number`, including the blocks whose number was a
  finding elsewhere in the entry. A block absent from the section means the
  run did not take it, and the next reader must be able to tell that from
  "took it and found nothing" — the distinction the 600-issue wave's
  instruments kept collapsing (a green gate that had looked at nothing).

## The bar (the core of the skill — say no to small things)

A finding qualifies **only if all five hold**:

1. **Structural, not a defect list.** It names a pattern; "N instances of a
   bug" is triage, not a finding.
2. **Measured evidence.** Counted ratios, file/line counts, grep tallies —
   never impression. Every number in the report must be reproducible from the
   command that produced it.
3. **Demonstrated cost.** A past incident, a recurring workaround, a
   documented failure mode, or a tax visible in the codebase's own comments.
   If nothing has ever hurt because of it, it has not met the bar yet.
4. **Changes how contributors work** — not just how the code reads.
5. **Splittable** into parallelisable, disjoint slices a partner can pick up
   cold.

**Refuse and do not report:** lint-level nits, cosmetic refactors, dependency
bumps, "add tests here" without a structural thesis, and anything whose remedy
is one PR — that is a `new-task`, not an epic. State the refusals only if the
scan would otherwise be empty, so the emptiness is explained.

## Method

1. Read `docs/quality/scan-ledger.md`; collect prior findings + dispositions.
2. Size the repo: lines per package, largest files, per-layer
   source-vs-test ratios.
3. Probe the dimensions where structural problems live: test architecture and
   what is mocked away; validation and contract enforcement; data-layer
   coverage; cross-package duplication; fat controllers; `any` density; CI
   gate coverage vs. what is actually exercised; **guard effectiveness** —
   sample guards and regression tests per layer, mutate what each one claims
   to pin, and report the survival rate (a test that stays green under the
   mutation it exists to catch is the one weakness class no comment ever
   names: the #1586 heartbeat was dead code in production behind a green
   unit test); **incident clustering** — group the recent issue history by
   failure class and count recurrence over time (the method the 2026-08-18
   outbound finding used by hand: 6 issues in the class in 7 weeks); and
   **workflow archaeology** — rerun frequency per CI check, rerun/flake
   mentions in commits and PR comments, checks that pass only on retry.
   Runtime-UX stays out of scope: that class surfaces through external
   testing (epic #1585's origin), not repo scanning. **Then take every block
   in § *Wave dimensions* below** — the seven classes the 600-issue wave was
   measured to consist of, each with a command, a sample and a clean shape,
   so the number it produces is quotable as evidence or as a baseline.
4. Read the comment archaeology: `TODO`s, issue-number references, and
   repeated warning comments are where a codebase names its own recurring
   pain. A warning copy-pasted across files is a structural finding announcing
   itself.
5. Filter every candidate through the bar. Discard the rest silently.
6. Report the **top 1–2** findings: evidence tables, the demonstrated cost,
   and a proposed slicing into disjoint sub-issues.
7. **Stop.** Wait for the human decision. On approval: append the ledger
   entry, then hand off to [new-task](../new-task/SKILL.md) § *Epics* for the
   tracking issue and its slices — and end the handoff by stating the exact
   drive command (`ship-next epic=#<n>`). An approved epic is not in any
   queue by itself: the 2026-08-14 finding's slices sat approved but
   undrivable until someone noticed (the ledger records this).

### Wave dimensions — measurement blocks (#2501)

The 2026-09-03 retrospective over the 600-issue wave measured what the wave
was made of; these are its seven classes, one block each. A block states the
**command**, the **sample** it runs over, and **what clean looks like**, so a
reader can re-take it and the ledger can tell "no finding" from "did not look".
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

**1. Guard falsifiability — by execution, not by reading.** 56 money-path
guards asserted on names their module did not export and could not fail
(#2307); the class recurred inside one week in #2421, #2455 and #2444.

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
about; a change to the other 7 would never have re-implicated it.

```bash
# Sample: every doc with `contract: true`. "Claims" ≈ repo paths the body
# cites in backticks that exist as tracked files (a heuristic; the reader
# judges each miss). Globs are matched by prefix.
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

**3. Stale numbers in prose — re-derive from the instrument.** Five wrong
figures reached CASP shards in three days; a figure without its command
cannot be re-taken, so it cannot be caught.

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
retirement's residue took 63 issues over three waves (#1440); a sweep that
cannot tell a live copy from a historical one re-files them.

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
```

Clean: positive control > 0, and every live file is either a guard that names
the term to assert its absence (a `*retired*.test.ts`, a banned-list) or a
`status: current` doc that describes the term as history in the same
sentence. Report the live files by class with the top counts. On
`893d74f6`: positive control 31 shards; 176 files carry a copy — 39
historical, 137 live — backend tests and `openapi/spec.ts` lead;
`docs/architecture/03-payment-sequence.md` is `status: current` with 10
copies.

**5. Merge-method drift on `dev` — first-parent, by subject.** Feature → dev
is squash; 44% of the wave's landings arrived as merge commits, which is what
made the promotion recipes and the head-SHA reads go wrong (#1173, #2116).

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
```

Clean: `merge-commit: 0` in the window. Report the rate and the five most
recent wrong-method landings by PR number and date. On `893d74f6`, since
2026-08-10T00:00:00Z: 274 merge-commit, 346 squash, 623 total (3 subjects
match neither shape); the latest five are #2494, #2493, #2479, #2480 and
#2481, all on 2026-09-03.

**6. Nets with holes — each gate's allowlist vs the content class it checks.**
#2317, #2333, #2318, #2088, #1903, #1896 and #2300 were each a gate green on
a file it never read; the hole is measurable before the next one is found by
hand.

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
```

Clean: each list is empty or every entry is exempted by name with a reason
(the copy lint's `CONVENTION_EXEMPT`, the classifier's control globs, a
visual spec's stated scope, `EXEMPT_PACKAGE_DOCS`). Report per gate: what it
does not reach, and which entries carry the content class. On `893d74f6`:
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
Report the top five by bytes with their headroom, and every doc carrying
duplicates — those are latent gate failures waiting for the next editor. On
`893d74f6`: 92 docs; `mcp-runtime-compatibility.md` at 63,961 bytes (97.6%)
one merge after its #2477 compaction; `05-agent-api-openapi.md` carries 31
duplicate entries among 66.

## Worked example (the run that motivated this skill)

The scan that produced the real-DB testing epic, as the reference shape:

- **Sizing:** a source-vs-test ratio table per layer showed the data layer as
  the thinnest-tested, heaviest-mocked stratum.
- **Measured evidence:** 1,059 positional DB mocks
  (`mockResolvedValueOnce`-chains against `db.query`) counted across the
  backend route tests.
- **Cost from comment archaeology:** the `#775` workaround comment ("adding a
  query re-shuffles every chain") copy-pasted across 8 files, the `#757`
  incident, and the partial `#773` guard — the codebase had already named its
  own pain three ways.
- **The unlock:** CI already ran Postgres in the same job, so a real-DB
  harness cost no new infrastructure.
- **Slicing:** harness first (blocks the rest), then per-repository
  conversions as disjoint slices, then a shrink-only ratchet so the pattern
  cannot grow back.

That is the altitude: one pattern, four kinds of evidence, a cost the repo had
already documented about itself, and a slicing a partner could execute cold.

## Cadence

Manual only — no cron, no CI wiring, no cadence doc. Findings at this
altitude do not accumulate weekly, and a schedule would bias the scan toward
small findings to have something to report.

The natural invocation points, kept as heuristics rather than schedule: when
the `ship-next` queue runs empty, or when a scan-born epic just closed. Both
mark a real capacity-and-context moment — the codebase just absorbed a wave of
change, and there is room to decide what the next one should be.
