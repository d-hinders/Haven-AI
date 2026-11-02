---
owner: "@d-hinders"
status: record
covers:
  - .agents/skills/quality-scan/references/dimensions.md
  - .agents/skills/release/SKILL.md
  - .github/workflows/docs-audit.yml
  - scripts/docs/audit-staleness.mjs
  - scripts/docs/validate-frontmatter.mjs
  - scripts/frontend-copy-lint.mjs
  - scripts/ci/refusal-census.mjs
  - scripts/ci/prove-red.mjs
  - packages/frontend/scripts/serve-docs.mjs
  - packages/frontend/src/lib/__tests__/served-docs.test.ts
  - packages/backend/src/modules/mpp/evidence.ts
  - packages/backend/src/routes/__tests__/machine-payments.test.ts
  - packages/backend/src/modules/accounting/__tests__/purchase-correlation.db.test.ts
  - packages/frontend/src/components/haven/TransactionActivityRow.tsx
  - packages/frontend/src/components/haven/__tests__/TransactionActivityRow.test.tsx
  - packages/sdk/src/tools.ts
  - packages/sdk/src/tool-descriptions.ts
  - packages/sdk/src/types.ts
  - packages/sdk/src/x402-protocol.ts
  - packages/sdk/src/merchant-completion.ts
  - packages/sdk/src/x402-funding-leg.ts
  - docs/contributing/docs-quality-system.md
  - docs/architecture/00-overview.md
  - docs/product/agent-key-rotation.md
last-verified: "2026-11-02"
---

# Quality scan 2026-11-02 — whole repo, weighted to the landings since 2026-10-30

Scope: the whole repository, weighted toward the **24** first-parent landings
after the 2026-10-30 scan:

```bash
git rev-parse origin/dev
# e0617aa9f4c2d0b09d724bcbaeca0815ad3205c5

git rev-list --first-parent --count 99ef8d063..origin/dev
# 24

git diff --shortstat 99ef8d063..origin/dev
# 334 files changed, 11033 insertions(+), 3385 deletions(-)
```

The window is the UX-consistency epic (#4560: 13 slices, 4 follow-up rounds),
the five 2026-10-30 candidates' builds, and one weekly docs audit. Measured by
one agent in the main checkout at `e0617aa9f` (the branch tip equals
`origin/dev`; no linked worktree), `npm ci`'d under Node 24, with core, the
SDK, the signer and the hosted MCP built. The clone arrived shallow at 50
commits and was unshallowed before any history figure was taken. Blocks 8 and 9
recorded the backend suite against a disposable local Postgres 16 database
created for the run. The block-1 census ran through the repo's mutation runner,
which backs up, restores and checks each file itself; the tree ended with
`git status --porcelain` empty apart from this report. One read-only worker
took the GitHub Actions reads. GitHub was read-only. No live Haven, MCP, dev or
production call was made.

Every prior ledger finding and candidate is excluded, whatever its
disposition. None materially worsened in the re-measured dimensions below.

## 1. Structural findings

None in the examined sample.

The window is one tracked frontend epic plus the builds of the previous scan's
candidates. The two candidates below have different mechanisms and fit one pull
request each; neither needs parallel slices. C1 sits beside the retired block 7
(*chain health*) and the 2026-10-26 run B's C2 (#4459, `shipped`): #4459 took
dated records out of the audit's ranking and forbade re-check sections on them;
C1 is the same growth on the docs that are still ranked, and no prior entry
measured it.

## 2. Improvement candidates — pending owner decision

### C1 — the weekly docs audit regrows the retired `last-verified` chain as body prose, on the docs the audit still ranks

**Opportunity and evidence.** #2681 (owner, 2026-09-07; PR #2775, 2026-09-09)
retired the per-doc `verified:` chain: "Replace with a plain
`last-verified: <date>` and nothing else." Its stated reason was "the system's
habit of producing prose to prove prose was checked" — 68,029 words, 20 % of
governed prose, "narrative that no reader reaches", loaded "into every session
and every reviewer pass". The chains were moved verbatim to the archive and a
script verifies that archive.

Since the first weekly audit after that retirement, the audit's closing PR has
appended a dated paragraph to each doc it re-verified — the same record, in the
body instead of the front matter. At `e0617aa9f`:

```bash
# Narrow shape: a paragraph that opens `Re-verified YYYY-MM-DD`, outside the archive.
git grep -c -E '^Re-verified 20[0-9]{2}-[0-9]{2}-[0-9]{2}' origin/dev -- 'docs/*.md' ':!docs/archive/*' | wc -l
# 30 docs
git grep -h -E '^Re-verified 20[0-9]{2}-[0-9]{2}-[0-9]{2}' origin/dev -- 'docs/*.md' ':!docs/archive/*' | wc -l
# 69 paragraphs — 65 in 28 `status: current` docs, 4 in 2 `status: record` docs
#   (status read from each file's first front-matter block)

# Bytes those paragraphs occupy (paragraph = the opener to the next blank line), current docs only.
# → 68,773 bytes (72,877 across all 30 docs; the docs tree is 7,857,011 bytes of Markdown)

# Wide shape: any dated re-verification opener (heading, bold, blockquote or bare).
git grep -l -E '^(#+ |\*\*|_|> )?Re-(verified|checked) (on )?20[0-9]{2}-[0-9]{2}-[0-9]{2}|^#+ .*[Rr]e-(verif|check).*20[0-9]{2}-[0-9]{2}' origin/dev -- 'docs/*.md' ':!docs/archive/*' | wc -l
# 42 docs (28 current, 14 record), 92 openers

# Positive control and start date: zero at the parent of the first audit after the retirement, 9 at that audit.
git grep -h -E '^Re-verified 20[0-9]{2}-[0-9]{2}-[0-9]{2}' 2f8a666cb^ -- 'docs/*.md' ':!docs/archive/*' | wc -l   # 0
git grep -h -E '^Re-verified 20[0-9]{2}-[0-9]{2}-[0-9]{2}' 2f8a666cb  -- 'docs/*.md' ':!docs/archive/*' | wc -l   # 9

# Landings that added one, by month.
git log --first-parent origin/dev --format='%ad' --date=short -G'^Re-verified 20[0-9]{2}-' -- 'docs/*.md' | cut -c1-7 | sort | uniq -c
# 3 in 2026-09, 18 in 2026-10, 1 in 2026-11
```

The heaviest doc is the architecture overview: 6 paragraphs, **7,533 of its
21,626 bytes** (35 %) are re-verification prose. The 2026-11-02 audit landing
(`e0617aa9f`, 14 files, `+290/−46`) added 12 narrow-shape paragraphs; the
2026-10-26 one (`ba99cdc5d`, `+536/−16`) appended its notes as `## Dispositions
re-checked …` sections instead, which is why the narrow shape undercounts and
the wide shape is reported too. The shape is not required by anything: the
audit issue's body asks to "re-verify it against the code and bump
`last-verified`, or update it", and the only instruction that asks for a
*Re-verified* note is the release skill's step 3 for the security model.

Two costs the repository has already paid for this class:

- **#2938 (2026-09-13):** a re-verification blockquote in a served doc carried
  a literal `covers:` token and turned the required *Frontend checks* red
  queue-wide, because `served-docs.test.ts` forbids that token in a served body.
  The guard still exists and still reads the body: one of the four docs the
  frontend serves to agents (`docs/product/agent-key-rotation.md`, through
  `packages/frontend/scripts/serve-docs.mjs`) carries one narrow-shape
  paragraph of 1,573 bytes today, served to every agent that fetches it.
- **#2681's own measurement** is the reason the front-matter form was retired;
  the body form is 15 % of that size after eight weeks and grows at the audit's
  cadence (one paragraph per ranked doc per week).

**Expected benefit.** The audit's closing PR stops writing prose to prove the
reading happened; the PR body and the `last-verified` bump are the record, as
#2681 decided. Served docs stop carrying a diary. The retirement cannot
silently reverse under a new syntax, because a guard names the shape.

**Approximate scope.** One PR: a guard beside the front-matter validator that
refuses a dated re-verification opener in a governed doc's body (the shape
above, with the two fixture controls the block-2 selector now carries), the
rule stated once in `docs/contributing/docs-quality-system.md` and in the
release skill's step 3, and the 69 existing paragraphs moved verbatim to the
archive file the #2775 retirement created (or deleted, since each landing's PR
carries the same text — the owner's call). Two PRs if the owner wants the
migration apart from the guard. Off the money path.

**Verified at scan** (`e0617aa9f`):

- criterion grep → 69 paragraphs / 30 docs (narrow), 92 openers / 42 docs
  (wide); control 0 → 9 at `2f8a666cb^` → `2f8a666cb`, as above;
- routing: `scripts/docs/audit-staleness.mjs`, `docs/contributing/docs-quality-system.md`,
  `.agents/skills/release/SKILL.md`, `docs/architecture/00-overview.md` and
  the archive file → `(none)`; `.github/workflows/docs-audit.yml` → `full`
  (a workflow file routes everywhere); `scripts/docs/validate-frontmatter.mjs`
  → `(none)` by the classifier but **money-path** by the control globs
  (#2200), so a guard that lives in that file lands under the CASP playbook —
  a sibling script does not;
- money-path verdict: every file above `off`, except `validate-frontmatter.mjs`
  → `money-path`; control `sweep.ts` → `money-path`;
- mutation recipe → *unrun*: the guard it would mutate does not exist yet.

**Verification still needed.** The guard's self-test must drive the real CLI
with a positive control (a fixture doc carrying the shape must be refused, one
without it accepted), per the #2720 convention; the archive move is proven by
the byte-equality diff #2681 required of #2775; `served-docs.test.ts` stays
green on the four served docs.

### C2 — block 6's copy-lint perimeter command cannot see the SDK's top-level files, so eight scans' "unscanned" figure was 45 files short

**Opportunity and evidence.** The copy-lint half of block 6 lists candidate
files with `git ls-files 'packages/frontend/src/**/*.ts' 'packages/frontend/src/**/*.tsx' 'packages/sdk/src/**/*.ts'`.
A git pathspec `**/` needs a directory separator after it, so the pattern
matches nothing directly under `packages/sdk/src`:

```bash
git ls-files 'packages/sdk/src/**/*.ts' | grep -cE '^packages/sdk/src/[^/]+\.ts$'
# 0
git ls-tree -r --name-only origin/dev packages/sdk/src | grep -E '^packages/sdk/src/[^/]+\.ts$' | grep -vcE '\.test\.'
# 46 non-test files at the SHA (plus one at the frontend's top level, its middleware file)
```

The reference command, run as written → **66 unscanned / 4 with hits**, the
figure every entry since 2026-09-03 reports in this series (72 / 5 then). The
same filter over a list that includes the top level (`git ls-tree -r
--name-only origin/dev packages/frontend/src packages/sdk/src`, `.ts`/`.tsx`,
the same exclusions, minus `SCAN_FILES`) → **111 unscanned / 14 with hits**.
The 10 newly visible hit files carry 16 hits: **6 in agent-facing strings** —
tool descriptions in `packages/sdk/src/tools.ts:158` and
`packages/sdk/src/tool-descriptions.ts:261`, refusal text in
`packages/sdk/src/x402-protocol.ts:459`,
`packages/sdk/src/merchant-completion.ts:570` and
`packages/sdk/src/x402-funding-leg.ts:440`, a next-step message in
`packages/sdk/src/types.ts:2058` — and 10 in JSDoc, the documented
false-positive class. The lint's own `SCAN_FILES` names two files at that top
level (`skill-content.ts`, `agent-guidance.ts`), so the SDK's top level is
inside the lint's content class by the lint's own allowlist; the block's sample
simply never reached it.

This is the instrument class the 2026-10-30 C1 (#4576, the block-2 selector)
and the 2026-09-21 `set -f` lesson belong to: a block's own sample excluded
part of what it claimed to measure, and the figure was quoted as a baseline
for eight runs. No product incident is claimed.

**Expected benefit.** The block's figure says what it claims; the six
agent-facing strings become a visible decision (name the files in
`SCAN_FILES`, as #3882 did for six `src/lib` files, or exempt them with a
reason under `CONVENTION_EXEMPT`) instead of an absence.

**Approximate scope.** One PR to `.agents/skills/quality-scan/references/dimensions.md`:
replace the two `**` globs with a `git ls-tree` listing at the pinned SHA (the
block already pins the docs-boundary count that way), re-baseline at 111 / 14
with the split above, and add the one-line control (`… | grep -cE
'^packages/sdk/src/[^/]+\.ts$'` must be non-zero). Whether the six strings
join `SCAN_FILES` is the lint's decision under #2317 (never widen
`SCAN_DIRS`), recorded there — not part of this PR unless the owner says so.

**Verified at scan** (`e0617aa9f`):

- criterion → 0 of 46 top-level SDK files reached by the reference glob;
  66 / 4 as written, 111 / 14 corrected (commands above);
- routing: `dimensions.md`, `scripts/frontend-copy-lint.mjs`, the ledger →
  `(none)`; money-path verdict `off` for all three, control `sweep.ts` →
  `money-path`;
- mutation recipe → *unrun*: a reference command has no test to redden; the
  control line is the check.

**Verification still needed.** Run the corrected command at the next scan SHA
beside the old one and record both; if `SCAN_FILES` grows, run
`npm run -w packages/frontend copy:lint` (the lint's own job) and the lint's
self-test.

### Notes, not proposed

- **Block 8 prints three unmarked typed codes on agent payment routes**
  (`POST /machine-payments/send` 422 `rail_not_supported`,
  `POST /machine-payments/budget-precheck` 409 `budget_requires_recipient`,
  `POST /machine-payments/sweep/submit` 409 `balance_changed`) and five on the
  `GET …/sign-context` and `…/merchant-call-context` reads. The 2026-10-27
  baseline listed its 13 payment-route codes by count, not by name, and the
  issue it filed (#4468) names none of these three, so whether they were in
  that set is not determinable from the ledger; they are reported here by name
  so the next run can say. The typed-row total is unchanged at 142.
- **Four dialogs outside the shared Modal primitive still set `role="dialog"`** after the
  epic's "remaining bespoke dialogs" slice (#4566): the Receive dialog (its own
  design-system entry), the wallet button, the connect-flow close guard and
  the sidebar sheet. No cost evidence; the epic's own walkthrough rounds
  (#4601, #4602, #4607, #4608) are where that judgement is being made.
- **Three environment reds in the backend suite** are coverage limits, not
  findings: the caveat-enforcer contract test cannot reach `sepolia.base.org`
  through this container's proxy, and the loopback net test's IPv6 listen
  fails with `EAFNOSUPPORT` here.

## 3. Coverage record

All measurements at `e0617aa9f`; parentheses are the 2026-10-30 entry at
`99ef8d063`.

- **Sizing → examined.** The 09-22 command pinned with `git ls-tree`/`git show`:
  backend 121,063 source / 160,892 test lines (120,895 / 160,644); frontend
  78,593 / 86,898 (77,394 / 84,225); sdk 19,642 / 22,647; core 25,754 / 985;
  qa-agent 15,133 / 13,283; mcp-server 14,114 / 25,456; signer 5,564 / 9,363;
  connect 12,436 / 15,676; cli 3,207 / 3,609; ops 3,143 / 2,222; ui 2,822 /
  2,328 (2,603 / 2,057); mcp 2,817 / 5,038; demo-merchant-mcp 3,788 / 4,210.
- **Fat controllers → examined as a census.** 50 non-test route files, 4 at or
  above 1,000 lines; `grep -oE '\b(app|ownerApp)\.(get|post|put|patch|delete|route)\b'`
  over the 50 → 212 registrations; largest `routes/payments.ts` 1,572 lines
  (unchanged).
- **Block 1, guard falsifiability → examined.** The reference census script →
  **1** candidate guard file over 1 of the last 20 landings (the #4579 receipts
  landing; the #4577 landing is the 21st). Runner line: "1 census mutations
  (one per file, newest landing first) + 2 probes. **3 caught**, 0 survived, 0
  shadowed, 0 mutation-red, 0 refused, 0 not run." M1 (census): the receipt
  serializer emits one undeclared key → 2 of 65 red, the #4579
  emitted-vs-declared guard among them. P1 (second copy): the deprecated
  `parent_payment_id` alias emits null → 1 of 7 red, the real-DB join test
  (the mocked route suite's fixture row has no parent column and cannot see
  it). P2 (count-only): the compact skeleton's amount placeholder becomes a
  third description bar, four blocks still → 1 of 23 red — the pin reads the
  placeholder's column, so it is not count-only after all. Runner artefacts in
  `$SCRATCH/prove-red-2026-11-02-*`. The runner refused the first cells file
  (family `other` is not a census family) and nothing was mutated.
- **Block 2, contract-doc `covers:` → examined.** The front-matter selector
  (both fixture controls pass) → 7 contract docs; the loop under bash with
  `set -f` → **15 cited-but-not-covered across 5 of 7** (unchanged), every miss
  confirmed with `coupling-gate.mjs --strict --changed=<path>` naming the doc
  for none of the 15. `npm run docs:covers-gaps` → 124 pairs / 33 docs
  (unchanged), 104 governed docs; its standing warning on the two
  out-of-folder `archived` docs is the 2026-10-13 note.
- **Block 3, stale numbers → partial.** Positive control 3 / 3. The 25 newest
  shards (`2026-10-26-4429` … `2026-11-02-4601`), the reference's two `rg` lines
  → **13 figure lines, 2 with a command** (16 / 2); the two commanded lines are
  the 0.12.0 and 0.13.0 release shards' re-measured lines. Ledger
  re-derivations: `any` 39 (39); db-mock gauge 54 / 270 / 57 (unchanged);
  zod 0; guard scripts 78 (75 on 10-26), self-tests that never spawn 25 of 78
  (25 of 75).
- **Block 4, retired vocabulary → examined.** Positive control 36 shards; 196
  files, 47 historical / 149 live (unchanged); prose ratchet green at 32 hits /
  30 files; code half unchanged (two of the three x402 repository exports
  reach only their defining file and one qa-agent comment, the third only its
  defining file).
- **Block 5, merge-method drift → examined.** Since 2026-08-10T00:00:00Z →
  **282 merge-commit / 1,420 squash / 1,705 total** (282 / 1,396 / 1,681);
  since 2026-10-30T00:00:00Z → 0 / 29 / 29; the window 0 / 24. The newest
  merge-commit landing is still 2026-09-07. *First reading corrected:* the
  shallow clone read 0 / 50 / 50 — the 2026-10-13 lesson, repeated.
- **Block 6, nets with holes → examined, all four halves.** Copy lint by the
  reference command **66 unscanned / 4 with hits** (unchanged) — C2 is the
  corrected 111 / 14; money perimeter 32 verb files / 20 outside (unchanged);
  visual gate 15 exact routes of 27 (unchanged); pinned Markdown outside both
  docs boundaries 43 (unchanged); freshness-gate exit branches unchanged
  (`rg -n "Gap 1|#2164|qa-override|KNOWN LIMIT"` → lines 30, 41, 128, 131,
  150, 277, 284, 423, 493, 536, 540, 1080, 1090, 1102).
- **Block 8, refusal census → examined.** Backend suite under the recorder:
  549 files, 547 green, 2 red (the enforcer probe and the IPv6 loopback listen,
  both environment — notes), 6,921 tests (6,905 passed, 15 skipped, 1 failed),
  472 s wall; **2,203 rows; 1,614 error rows; 574 distinct keys; 142 typed
  rows reach `API_ERROR`** (142 after #4468) — 3 unmarked on agent payment
  routes, by name in the notes; 5xx answered transient 36; non-answers read
  as refusals 2 (the same two stub routes); SDK `new HavenApiError(` sites
  **31** (26 literal / 5 variable; 41 on 2026-10-27 — the ten fewer sites
  landed with #4516's retry-by-cause and the 0.12.0/0.13.0 releases, not
  re-traced one by one); both halves of the positive control passed.
- **Block 9, field round-trip → examined.** Emitted but never read **5** (the
  same five as after #4469: `mpp`, `spent_display`, `remaining_display`,
  `is_live`, `endpoint_host`); read but never emitted **13** (12 + the status
  route's `submission_outcome_pending`, emitted in source in a state the
  recorded tests did not reach — the known false-positive class); both halves
  of the positive control passed. The #4577 pair `parent_receipt_id` /
  `parent_payment_id` is emitted and read on both sides.
- **Incident clustering → examined.** Issues created since
  2026-10-30T00:00:00Z → **29** (4 open / 25 closed): the UX-consistency epic
  18 (#4560, 13 slices, 4 walkthrough rounds), the 2026-10-30 scan's five,
  release process 2, SDK/x402 3, the docs audit 1. Open PRs 1 (#4525). No
  untracked recurring mechanism.
- **Workflow archaeology → examined.** `ci.yml` newest 100 (2026-10-29T18:43Z →
  2026-11-02T14:54Z) → **77 success / 14 cancelled / 9 failure**; 5 with
  attempt > 1, all feature branches; `dev` 37 → 33 / 4 cancelled / 0 failure.
  Failed jobs over the 9 (job level, by the worker): Design visual regression
  7, Frontend checks 1 (plus its aggregate), Frontend browser smoke 1; 3 of the
  9 are one branch (#4602's) inside 20 minutes. qa-dev at the `money-flow`
  **job** level: 173 runs since 2026-10-30T00:00:00Z, all `success` at run
  level; money-flow **ran in 33 (33 success, every one on attempt 1/2, 17 of
  17 legs PASS), gate-skipped in 140**, 0 failures, no attempt 2/2 line in any
  log.
- **Comment archaeology → examined.** `git grep -n -w -E 'TODO|FIXME|HACK|XXX'
  -- 'packages/*/src/*'` → 0; control `import` → 2,223 files. Most-repeated
  source comment: 25 copies of one request-validation boilerplate line; the
  21-copy #1464 line is the 2026-10-26 note.
- **Cross-package duplication → partial.** One census only: the
  `pending_approval` literal sits in 20 non-test files across six packages;
  not read further.
- **Validation / contracts → partial.** Blocks 8 and 9 and the #4579 guard
  (M1); no shadow-residue census.
- **Data-layer coverage → partial.** The db-mock gauge, 549 backend files run
  against a real database for the recording, and P1 on the real-DB harness;
  no repository census.
- **Live exercise → not examined.** No dev, production, MCP or paid call.
- **Novelty.** The full ledger, `docs/bug-reports/`, and GitHub issue searches
  per candidate (open and closed; the `re-verification` searches return #2938,
  #4372 and #4459 as context, none as the item; the copy-lint searches return
  #3882 and the SCAN_FILES history, none naming the top-level gap). Bug-report
  bodies were not otherwise re-read.

## 4. Verification and limitations

- `git status --porcelain` empty before and after the census and the
  recording, apart from this report.
- The two red backend files are environment reds (notes); their tests are
  not claimed green.
- Block 1 exercised 1 of 1 census files plus two probes; the 20-landing
  sample held one money-path landing with test files.
- No claim is made about a live runtime, browser behaviour, or the 4 bespoke
  dialogs' intent.

## 5. Independent review

Pending — filled in when the `haven-reviewer` pass on this PR has bound its
verdict to the reviewed SHA.

Instrument lessons: the cloud clone is shallow (50 commits) — unshallow
before block 5, every time; a git pathspec `**/` never matches a top-level
file, so a `**` glob under a directory is a selector that silently drops that
directory's own files; the census runner takes `census` and the two probe
kinds only, so a backend cell outside the 20-landing sample is written as a
probe; the real-DB harness reads `DATABASE_URL` from the environment the
runner inherits; a container proxy that denies the Base Sepolia RPC and an
IPv6-less loopback each redden one backend file.
