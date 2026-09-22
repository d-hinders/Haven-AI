---
owner: "@AntonioSaaranen"
status: current
covers:
  - packages/backend/src/infra/repositories/smart-accounts.ts
  - packages/backend/src/infra/repositories/agent-labels.ts
  - packages/backend/src/infra/repositories/__tests__/smart-accounts.test.ts
  - packages/backend/src/infra/repositories/accounting-webhook-deliveries.ts
  - packages/backend/src/infra/repositories/README.md
  - packages/backend/src/routes/user-accounts.ts
  - packages/backend/src/routes/agent-labels.ts
  - packages/backend/src/routes/__tests__/accounting-webhooks.test.ts
  - packages/backend/src/db/migrations/__tests__/092_accounting_webhook_deliveries.test.ts
  - scripts/branch-hygiene.mjs
  - scripts/ci/change-classifier.mjs
  - scripts/lint-request-schemas-baseline.json
  - scripts/lint-next-steps-baseline.json
  - scripts/vitest/assert-fresh-dist.mjs
  - scripts/lib/lint-escapes.mjs
  - packages/frontend/src/components/AgentPanel.tsx
  - packages/qa-agent/src/run.ts
  - scripts/ci/routing-matrix.mjs
  - .github/root-guard-ownership.json
  - scripts/lint-next-steps.mjs
  - scripts/lint-wire-types.mjs
  - scripts/check-dist-freshness.mjs
  - scripts/docs/coupling-gate.mjs
  - scripts/ci/baseline-push-followup.mjs
  - scripts/ci/baseline-push-followup.test.mjs
  - scripts/ci/baseline-audit.mjs
  - .github/workflows/update-visual-baselines.yml
  - packages/frontend/e2e/product-routes.visual.spec.ts
  - packages/mcp-server/src/tools-contracts.test.ts
last-verified: "2026-09-22"
---

# Quality scan 2026-09-22 — whole repo, weighted to the least recently scanned surfaces

Scope (owner request 2026-09-22, no scope named): the whole repository. The
three previous runs (2026-09-13, 09-17 and 09-21) covered the agent surface
under the 2026-09 mandate, so this run puts its sample on the surfaces the
ledger shows least recently scanned: the backend data layer and the
accounting module, the CI and reporting scripts read as instruments, and
the frontend, CLI and connect packages. Measured on `origin/dev` @
`fd7b1289` (2026-09-22, after #3225) by the captain and three read-only
workers, each in its own detached worktree removed with a plain
`git worktree remove` afterwards. Real-database runs used a disposable local
database, dropped afterwards. No live call was made, nothing was filed, and
nothing was pushed except this branch.

The rules merged earlier the same day in #3224 apply: this report is
reviewed before it is presented, instruments run the way CI runs them, and
scoped counts come from the instrument, not from a hand count. §5 lists
five places where one of our own instruments gave a wrong reading during
this run.

## 1. Structural finding

**F1 — The visual-baseline net cannot tell "the screen changed on purpose"
from "a failing comparison was re-blessed".**

*Pattern.* A baseline PNG changes by one of two paths, and neither path
requires anything to justify the change:

- The *Update visual baselines* dispatch
  (`.github/workflows/update-visual-baselines.yml`). Its default
  `mode=changed` rewrites exactly the baselines whose comparison fails, so it
  selects on the regression signal itself. `expected` is optional under
  `changed`; when it is given, it records what the author believes moved, so
  an unrecognised regression gets declared as intended.
- A manual commit. Example: #2471, `test(frontend): refresh design system
  visual baselines`, which carries no audit trailer. No gate checks where a
  PNG came from.

Nothing reads what a changed baseline carries with it:

- `git grep -l haven-design-reviewer fd7b1289 -- scripts .github` → 1 file,
  the pull-request template.
- The workflow's audit trailer (`Regenerated with --update-snapshots=…;
  baselines moved: …`) is written but never read: only its writer and the
  writer's test reference it.
- The workflow keeps a diff image only when a comparison fails
  (`visual-regression-diffs`, `if: failure()`). After a re-bless the
  comparison passes, so no diff image is kept.
- On a bot push, the sticky comment from
  `scripts/ci/baseline-push-followup.mjs` (`buildComment`) says the baselines
  are "**correct and already pushed**" and "Nothing about the images is
  wrong", and `baseline-push-followup.test.mjs` pins that sentence. The
  workflow has no basis for either statement. It posted that comment on
  #3222's regressed baselines.
- *Design visual regression* is not among `dev`'s 15 required checks; it is
  required on `main` (`gh api repos/d-hinders/Haven-AI/rules/branches/main`).
  From reading the workflow (not executed): `main` compares against the
  baselines committed at the promotion head, so it re-confirms a re-blessed
  baseline rather than catching it.

*Measured* (at `fd7b1289`):
- `git log --first-parent fd7b1289 --since=2026-09-01T00:00:00Z --format=%h
  -- packages/frontend/e2e/__screenshots__/ | wc -l` → **35** landings
  touch a baseline, of 444 first-parent landings in the window.
- **24** of the 35 modify an existing baseline (git status `M`).
- **17** of the 35 carry a design-review verdict line in the PR body: 15
  passed or cleared, 2 recorded findings (#3057, #2450). This is a hand
  classification. A regex pass over the bodies
  (`design-reviewer|design review|design pass|design-lens`) found the
  candidates, and each hit was then read.
- 6 were skipped or still pending at merge: #3205, #2816, #2650, #2470,
  #2471 and #2331.
- **12** have no design-review line at all. One of them, #2643, is a CLI fix
  that re-blessed `agentpanel-empty-onboarding-prompt-desktop.png`.
- Of the 24 that modify an existing baseline, 12 carry a verdict. Since
  2026-09-18, 1 of 9 baseline landings carries one (#3199).

*Demonstrated cost:*
- **#2217 / #2218 (2026-08-30).** A dispatch silently re-blessed a baseline
  that was not failing. It was caught only because all 22 blob hashes were
  audited by hand; #2218 records that "Nothing in the workflow's output, the
  PR diff review, or CI would have distinguished it". #2218 closed the
  `all`-mode half. Under `mode=changed`, a failing baseline is still
  re-blessed with nothing asking why.
- **#3167 → #3197.** A known cosmetic regression (an empty labels wrapper,
  a gap of about 6 px on unlabelled cards) was "Blessed as-is in the #3167
  PR" because reverting it there "would redden CI's Design visual regression
  against the blessed baselines". It was tracked separately and fixed in
  #3201. This bless was deliberate and recorded. It shows the mechanism
  working as built: once blessed, the regression is the baseline, and the
  gate defends it.
- **#3222 (open, 2026-09-22).** The Status and Budget filters disappeared,
  and `agents-list-filtered-mobile.png` and `agents-list-mobile.png` were
  re-committed to match. At the reviewed head `cf8e720c`, *Frontend checks*,
  *Design visual regression* and *Lint* were all green. Only the design
  review caught it.
- Tracking: `gh issue list --state all --search` for "bless", "blessed",
  "baseline regression", "re-committed baseline" and "baseline diff review"
  → no open issue.

*Why it changes how contributors work:* moving an existing baseline would
require a stated reason for each moved image and a design-review verdict
that names it. Today, a green comparison after a regeneration is taken as
evidence that the pictures are right.

*Disjoint slices (proposed; subject to the owner's decision):*
1. A gate that reads the audit trailer: every modified baseline needs a
   declared reason and a design-review verdict naming it. Files:
   `scripts/ci/` plus the workflow step that calls it.
2. The bot-push follow-up comment stops asserting the images are correct,
   and its pinned test changes with it
   (`scripts/ci/baseline-push-followup.mjs` and its test).
3. The regeneration run publishes a before/after image for every
   baseline it rewrites (workflow artifact), so the reviewer has something
   to look at. Files: `.github/workflows/update-visual-baselines.yml` only.
4. The design-reviewer brief gains a baseline-diff step
   (`.claude/agents/haven-design-reviewer.md`; it mentions baselines 0
   times today).
Whether *Design visual regression* should also be required on `dev` is an
owner decision, not a slice.

## 2. Improvement candidates (one PR each unless stated) — pending the owner's word

**C1 — Three repository writes take `userId` but scope only by row id, so
tenancy rests on a route pre-check in another file.**

- *Evidence at `fd7b1289`:*
  - `setDefaultAccountForUser` runs `SET_ACCOUNT_DEFAULT_SQL`
    (`UPDATE smart_accounts SET is_default = true … WHERE id = $1`).
  - `deleteAccountForUser` runs `ORPHAN_AGENTS_FOR_ACCOUNT_SQL`
    (`… WHERE account_id = $1`) and `DELETE_USER_ACCOUNT_SQL`
    (`DELETE FROM smart_accounts WHERE id = $1`). Both are in
    `packages/backend/src/infra/repositories/smart-accounts.ts`.
  - `replaceAgentLabels` runs `REPLACE_LABELS_FOR_AGENT_SQL` and
    `INSERT_LABEL_ASSIGNMENT_SQL`, keyed by `agent_id` alone
    (`packages/backend/src/infra/repositories/agent-labels.ts`). It checks
    that the labels belong to the caller, but never checks the agent.
  - The ownership checks sit in `packages/backend/src/routes/user-accounts.ts`
    and `packages/backend/src/routes/agent-labels.ts`.
- *Real-database probe* (a disposable test calling each function with a
  second user's `userId`, removed afterwards):
  - Control: `renameAccountForUser`, whose SQL is user-scoped, returned
    `null` and the name was unchanged.
  - `deleteAccountForUser` returned `true`. The victim's account row was
    gone and the victim's agent had `account_id: null`.
  - `setDefaultAccountForUser` left the victim with two accounts marked
    `is_default: true`.
  - `replaceAgentLabels` put the attacker's label on the victim's agent.
- *The route pre-checks are load-bearing and tested.* Disabling each one
  turns a test red: the two account routes through a mocked pool, the labels
  route on the real database ("expected 200 to be 404"). So nothing is
  reachable today. The repository layer is simply not a backstop.
- *A test pins the unscoped shape as correct:*
  `infra/repositories/__tests__/smart-accounts.test.ts` ("clear is scoped to
  the user, set is by id") asserts the SET's parameters are `['safe-1']`,
  against a mock executor.
- *It contradicts the stated convention.*
  `packages/backend/src/infra/repositories/README.md` rule 3 makes tenant
  scoping a required parameter, and rule 6 says guards travel with the
  write they protect.
- *Cost and history:*
  - The same shape was found in PR #3222 today (review S1: the probe moved
    another user's agent).
  - #988 moved these writes into the repository verbatim. Its acceptance
    criterion was "A test asserts cross-tenant access returns empty/rejects
    for each scoped function"; the tests it added for these two functions use
    a mock executor.
  - #1208 had already named the missing cross-tenant test as a class.
- *Census, for scale* (worker instrument `sql-census.mjs` + `classify.mjs`
  over the 66 non-test files under `infra/repositories/**`,
  `modules/accounting/**` and `routes/accounting*.ts`; not committed):
  - 168 mutating statements, 112 scoped by a principal column in SQL and
    56 not.
  - Each of the 56 was bucketed by what enforces tenancy instead:
    - 19 system-only callers
    - 17 ids from an already-scoped read
    - 7 public or ownerless tables
    - 6 where the row is the principal itself
    - 4 setup-token capabilities
    - 3 request-supplied ids with the check in another file (C1)
  - Not traced: the 45 statements scoped by `agent_id` only, apart from the
    labels pair.
  - Positive control: grep agrees on 40 `INSERT INTO` and 10 `DELETE FROM`.
- *Benefit:* a cross-tenant write needs two defects instead of one. The
  repository then enforces its own README.
- *Scope:* one PR. Add `AND user_id = $n` (or a join on `agents.user_id`)
  to the five statements, fix the test that pins the unscoped shape, add
  real-database cross-tenant tests, and optionally ratchet the census under
  `scripts/ci/`.
- *Verification still needed:* the real-database cross-tenant tests
  themselves; a trace of the 45 `agent_id`-only statements.
- *Tracking:* none. No issue names any of the three functions.

**C2 — Two of #3019's acceptance criteria for the Accounted webhook
receiver are met by tests that cannot fail.**

- *Trailing slash.* In
  `packages/backend/src/routes/__tests__/accounting-webhooks.test.ts`, the
  loop `for (const suffix of ['', '/'])` uses `suffix` only in the test's
  title; `post()` always uses the default path. `404` is also in the allowed
  set. Deleting the trailing-slash route survives 19/19. A scratch test
  posting to `…/<token>/` got 200 on the clean tree and 404 with the
  mutation.
- *Dedupe.* `recordWebhookDelivery` in
  `packages/backend/src/infra/repositories/accounting-webhook-deliveries.ts`
  decides `inserted` from `r.rows.length > 0`. Forcing it to `true`
  survived the whole backend suite: 4,204 passed, 3 failed, and the three
  are the local 5 s timeouts from §4, which fail on the clean tree too. The
  route test mocks the repository, and the 092 migration test pastes its own
  `INSERT` instead of importing the statement — the "by import, never by
  paste" failure the repositories README (rule 4) warns about.
- *Tracking:* #3019 is open and names both criteria ("including the
  trailing-slash variant"; "Real-DB test: the deliveries table rejects a
  replayed id"). So this is a correction to tracked work, not a new item.
  Proposed: a comment on #3019, not a new issue.
- *Benefit:* the provider auto-disables a subscription on a 3xx or 410.
  The trailing-slash criterion exists to stop that, and today nothing
  enforces it.

**C3 — `scripts/branch-hygiene.mjs` measures a history that no longer
records what it counts, and prints the target state.**

- *Evidence.* It counts `Merge branch 'dev' into <b>` subjects in `dev`'s
  first-parent history. Since the squash-only "Dev merge" ruleset
  (2026-09-07), those commits are squashed away before they reach `dev`.
  `node scripts/branch-hygiene.mjs --since … --until …`:

  | Window | Resyncs | Printed verdict |
  |---|---|---|
  | 08-10→08-20 | 31 | |
  | 08-20→09-01 | 199 | |
  | 09-01→09-08 | 43 | |
  | 09-08→09-23 | 0 | "✓ One branch per PR, each cut fresh. This is the target state (#1500)." |

- *The resyncs did not stop.* `gh api
  repos/d-hinders/Haven-AI/pulls/<n>/commits` over 200 of the 259 PRs merged
  into `dev` since 2026-09-08 → **17** resync commits in **13** PRs. Example:
  #3196 has two, both `Merge remote-tracking branch 'origin/dev' into …`.
- *Where it is relied on:* `docs/contributing/branch-and-release-flow.md`
  still names this command as the number that says whether the
  branch-freshness practice is working, with zero as the target.
- *Cost:* the hazard it measures is #1366 (a conflicting PR runs no
  checks, so an armed auto-merge never fires).
- *Scope:* one PR. Count resyncs from each merged PR's own commits, and
  refuse a window that contains no merge-shaped commit at all rather than
  print ✓.
- *Tracking:* none.

**C4 — Files that a gated job reads, but that the change classifier routes
nowhere, so the required per-package check passes as "skipped".**

- *Evidence* (`classifyChangedFiles([f])` from
  `scripts/ci/change-classifier.mjs`):
  - These route to no surface:
    - `.env.example` (backend env drift test)
    - `scripts/lint-request-schemas-baseline.json` (Backend job)
    - `scripts/lint-next-steps-baseline.json` (Backend, MCP, MCP server and
      Signer jobs)
    - `scripts/vitest/assert-fresh-dist.mjs` (test setup for connect,
      mcp-server and qa-agent)
    - `scripts/lib/lint-escapes.mjs` (the frontend job's `design:lint`)
  - Positive control: the backend package's entry-point source file → `code,backend`.
  - None of the five appears in `.github/root-guard-ownership.json` or
    `scripts/ci/routing-matrix.mjs`. The matrix documents other unrouted
    files (the Node version pin, the code-owners file, the git ignore file and the Dockerfile) as known
    gaps.
  - Over every tracked file: 749 of 2,603 route nowhere, and 149 of those
    are not docs or images.
- *Demonstrated* (each behind a `cp` backup, restored byte-identical):
  - Removing `PORT=` from `.env.example` classifies as 1 path and 0
    surfaces, while the drift test goes from 5 passed to 1 failed.
  - Lowering one count in the request-schemas baseline classifies the
    same, while `npm run lint:request-schemas` exits 1.
  - Either PR would merge green and leave the next backend PR red.
- *Cost:* no incident found. All 37 `dev` landings that touched
  `.env.example` since 2026-07-01 also changed routed code. The precedents
  for the shape are #2727/#2719 (a stale copy carried until an unrelated PR
  tripped it) and the reason the #1624 ownership manifest exists.
- *Scope:* one PR. Add these inputs to the ownership manifest next to the
  guards that read them.
- *Tracking:* none.

**C5 — Two required-job ratchets pass when their scan targets disappear,
and so do their own self-tests.**

- *Evidence* (each target moved aside, the command CI runs, then restored
  with an identical `git status --porcelain -uall`):
  - `npm run -s lint:next-steps` (`scripts/lint-next-steps.mjs`) with all 5
    targets hidden → `✓ … (0 allowed by baseline)`, exit 0, and no file
    count printed. `npm run -s lint:next-steps:test` → pass 10 / fail 0.
    Positive control: an unnamed `buildAgentGuidance({ action: 'retry' })`
    makes it exit 1.
  - `npm run -s lint:wire-types` (`scripts/lint-wire-types.mjs`) with
    `src/hooks` and `src/types` hidden → `0 … across 0 file(s)`, ✓, and it
    advises `--update`, which would lock in the zero.
    `lint:wire-types:test` → 29 / 0. The code says this is intended ("a
    scan dir that does not exist yet is not an error").
  - Contrast: `dep-lint` also passes on its own with `packages/core/src`
    renamed, but its self-test catches that (`the scan actually reaches
    packages/core`), so CI covers it.
- *Remedy already in the repo:* copy-lint's `SCAN_DIRS entry matched no
  source files` refusal (#2317).
- *Scope:* one PR. Each script refuses a scan that read 0 files; its
  self-test pins the refusal.
- *Prior art:* the 2026-09-15 ledger entry refused design-lint's instance
  of this as a one-PR fix. These two are different scripts, so this is not
  a re-surface.
- *Tracking:* none.

**Notes, below the bar (not proposed for filing):**
- *Facets pinned only by pixels.* A stable empty facet list passed from
  `AgentPanel` (#3222's shape, replayed on `dev`) survives all 100 test
  files / 1,082 tests under `src/components` and `src/app`. The
  `?status=active` capture in `packages/frontend/e2e/product-routes.visual.spec.ts`
  anchors on the "Agents" heading only. #3222's round-3 head adds a test
  that keeps the built-in facets; if it lands, this closes.
- *Webhook token lookup.* It has two clauses (`secrets_ciphertext IS NOT
  NULL`, `status <> 'disconnected'`), and each survives deletion on its own
  (37/37) because disconnect sets both in one statement. No state was found
  that separates them; the search was not exhaustive.
- *`check:dist` wording.* `npm run check:dist`
  (`scripts/check-dist-freshness.mjs`) in a fresh checkout with no `dist/`
  prints `✓ dist is current for: sdk, signer, mcp`. It prints the same for
  a package that does not exist. The code means to ignore a missing dist;
  only the message is false.
- *One real CI flake.* `packages/mcp-server/src/tools-contracts.test.ts`
  timed out at 5000 ms once (run 35436827209, `release/0.4.0-alpha.0`,
  2026-09-19). No issue tracks it.

## 3. Re-checked and unchanged (so they are not mistaken for new findings)

- Parked-run re-runs after bot baseline pushes: 9 of the 10 `ci.yml` runs
  with `run_attempt > 1` had attempt 1 at `conclusion: action_required`,
  triggered by `github-actions[bot]`. The 2026-09-17 entry recorded this
  mechanism ("parked-run re-runs after bot baseline pushes").
- The CASP-guardrails contract's 6 uncovered cited paths and the x402
  sequence doc's 3 (§4, block 2) were recorded on 2026-09-15 and
  2026-09-21.
- The two docs that `npm run docs:covers-gaps` reports as outside the
  governed set (`docs/contributing/code-quality-loop.md`,
  `docs/operations/session-rail-vendor-ops.md`) are `status: archived`
  redirect stubs that the script names on purpose.

## 4. Coverage record (block → examined / partial / not examined → command → result)

All at `fd7b1289`.

- **Sizing** → examined.
  - Command: `git ls-files -z packages/<p>/src`, filtered to
    `.ts|.tsx|.mjs`, split on `.test.|__tests__|.spec.`, then `xargs -0 cat
    | wc -l` (source / test lines):

    | Package | Source | Test |
    |---|---|---|
    | backend | 77,152 | 95,359 |
    | frontend | 50,187 | 44,347 |
    | sdk | 11,548 | 13,353 |
    | mcp-server | 7,760 | 14,898 |
    | connect | 11,389 | 14,047 |
    | core | 17,442 | 191 |
    | qa-agent | 7,306 | 5,229 |
    | demo-merchant-mcp | 3,741 | 4,042 |
    | signer | 3,536 | 5,190 |
    | cli | 2,567 | 2,416 |
    | mcp | 1,959 | 3,691 |

  - The same command over `git archive 89fadec0` gives backend 69,517 /
    83,443, exactly the 2026-09-15 figures. So the instrument matches, and
    the one-week delta is +7,635 source (+11 %) and +11,916 test (+14 %).
  - Largest source growth, by net lines:

    | Directory | Net lines |
    |---|---|
    | `modules` | +3,357 (accounting/Accounted leads) |
    | `infra` | +1,094 (the merchants repository leads) |
    | `db` | +920 (migration 088) |
    | `routes` | +834 |
    | `openapi` | +654 (`request-validation.ts` is new, 735 lines) |

  - Largest non-generated file: `openapi/spec.ts` at 9,607 lines (09-15:
    9,042). `core` is almost entirely the generated `api-types.ts` (16,925
    lines).
- **Block 1 (guard falsifiability)** → examined, over the reference's
  budget of 5, across two non-money samples. The census script is scoped to
  money paths, so both samples were chosen by hand.
  - Accounting: 8 mutations on 6 guards of the #3196 receiver (`7f17c9f3`)
    → 4 caught, 4 survived (C2 ×2, and the token-lookup note ×2).
  - connect / cli / frontend: 12 mutations → 11 turned tests red, 1
    survived (the facets note). One of the 11 (an inline `[]` for the
    default facets) went red, but not on the condition it was meant to
    test. Every mutated file was restored byte-identical.
- **Block 2 (`covers:` completeness)** → examined.
  - The reference's loop found 8 contract docs and 19 misses. Two of the 19
    are glob strings quoted in prose, not files.
  - Each remaining miss was confirmed with
    `node scripts/docs/coupling-gate.mjs --strict --changed=<path>` →
    **17** that the gate does not name.

    | Doc | Misses | Status |
    |---|---|---|
    | CASP guardrails | 6 | recorded 09-15 |
    | dev-environment | 4 | the reference records 4 at `893d74f6` (5 cited, 1 covered) |
    | x402 sequence | 3 | recorded 09-21 |
    | docs-quality system | 2 | |
    | package-dev-channel | 2 | its two package READMEs |
    | runtime-compatibility (C1 on 09-21) | 0 | down from 7 |

  - The 2026-09-15 figure of 47 was taken without `set -f` and is not
    comparable.
  - `npm run docs:covers-gaps` → 138 baselined pairs across 36 docs
    (09-15: 146 / 37).
- **Block 3 (stale numbers)** → examined.
  - The 25 newest CASP shards hold 12 figure-bearing lines, and 0 of them
    quote a command. The count is `rg -c`, which prints nothing for zero.
  - Re-derivations:
    - `any`: 24 (23 at `89fadec0`). Of the 24 lines only 6 are code — see
      §5.
    - db-mock gauge: 54 / 273 / 57 (09-15: 54 / 280 / 57).
- **Block 4 (retired vocabulary)** → examined, using the reference's
  corrected exclusion.
  - 191 files: 46 historical, 145 live. This equals the corrected
    `e42ed68f` reading.
  - Positive control: 36 shards.
  - Code half: `failPendingX402Intent` appears only in its defining file.
    `recordX402Signature` and `confirmX402Intent` appear in their defining
    file plus `packages/qa-agent/src/run.ts`.
  - `npm run lint:retired-rail-prose` → green, below baseline.
- **Block 5 (merge-method drift)** → examined.
  - Since `2026-09-15T00:00:00Z`: 0 merge-commit landings, 122 squash, 122
    total. Clean.
  - Since `2026-08-10T00:00:00Z`: 282 merge-commit and 693 squash of 978
    subjects. The 282 are 4 sync-backs and 278 wrong-method landings.
  - The newest landing the block counts as wrong-method is #2646
    (2026-09-07). It is a sync-back from `main` under a `codex/sync-…`
    prefix, which the block's `sync/*` rule does not recognise. The newest
    feature branch among them is #2626 (the same day). 2026-09-07 is the
    day the squash-only "Dev merge" ruleset (22449193) was created.
- **Block 6 (nets with holes)** → partial.
  - Covered: every required check on `dev` (15 contexts, ruleset
    18021461 "Haven automerge rules") was read for skip paths.
  - C4 and C5 are the undocumented ones. The documented ones (skipped job
    counts as success, #1030 / #1624; the coupling gate satisfied by any
    doc edit or a `satisfied-by` shard) are not reported.
  - The visual net is F1.
  - Not taken: copy-lint, the money perimeter and the docs boundary.
- **CI scripts as instruments on empty input** → examined, 30 of 41.
  - 7 more were read but not run. Not examined: `claim-collision`,
    `audit-staleness`, `generate-api-types --check` and
    `verify-connect-bundle`.
  - 8 give a clean verdict on empty input:
    - 2 are correct (`change-classifier`, `baseline-audit`).
    - 5 hide that nothing was read: `branch-hygiene` (C3),
      `lint:next-steps` and `lint:wire-types` (C5), `dep-lint` (its
      self-test covers it in CI) and `check:dist` (wording only).
    - 1 is correct in CI mode but hides it given an explicit empty
      `--changed=` (the coupling gate; deliberate, #1337).
  - The rest refuse with exit 1 or 2. Positive control: `money-path-classify`
    as it was at `c7d0431d` reproduces its old `0 of 0 … not money-path`,
    exit 0.
- **Tenant scoping in SQL** → partial (C1). All 56 unscoped statements were
  bucketed. The 45 statements scoped by `agent_id` only were not traced,
  apart from the labels pair.
- **Incident clustering** → examined.
  - `gh issue list --state all --search 'created:>=2026-09-15'` → 111
    issues (99 closed / 12 open), taken around 21:05Z. A later re-run also
    counts issues filed since.
  - Every open one belongs to a tracked epic or a pending decision: #3016,
    #3019, #3028, #3031, #3032, #3119, #3130, #3164, #3181, #3193, #3195
    and #3223.
  - No untracked cluster.
- **Workflow archaeology** → examined.
  - `gh run list --workflow ci.yml --limit 200` (2026-09-19T08:36Z →
    09-22T21:07Z): 10 with `attempt > 1`, 23 failures (0 on `dev`), 19
    cancelled.
  - Failed jobs across the 32 failed or re-attempted runs:

    | Job | Failures |
    |---|---|
    | Lint, Type-check & Build | 12 |
    | Design visual regression | 9 |
    | Backend checks | 6 |
    | Install-path smoke | 3 |
    | Frontend checks | 2 |
    | Frontend browser smoke | 2 |
    | Repo CI config checks | 1 |

  - `qa-dev.yml`, last 40 runs: 40 / 40 success.
  - The three 5 s timeouts seen locally (`transactions-export-csv` ×2 and
    `x402-binding-signer-import-graph`) appear in 1 of the 32 failed logs,
    and that hit is a db-harness "slow" notice, not a timeout. So they are
    a local-machine effect, not a CI flake class.
- **Comment archaeology** → examined.
  - `rg -c -w 'TODO|FIXME|HACK|XXX' packages/*/src` with tests excluded →
    0.
  - Including tests, `git grep -c -w` gives 2. That is the positive
    control: the instrument can find a hit.
- **Live exercise** → not examined. No surface in this sample needed a live
  call, and none was authorised.

## 5. Instrument lessons from this run

Each is a reading that would have entered this report wrong.

- **`rg` in a `bash -c` loop.** `rg` exists on this machine only as a
  shell function of the zsh session; `bash -c` has no `rg` on its PATH. The
  reference's guard (`command -v rg … || … stop`) stopped the block-2 loop
  exactly as #3224 intended. Workaround: the rg-derived lists were taken in
  zsh and written to files, and the loops ran in bash.
- **`\b` in `git grep -E`.** `git grep -E '\bTODO\b'` reads 0 against a
  true 1 on macOS; `-w` is the portable form.
- **Word-splitting in the first sizing pass.** It iterated
  `for f in $files` in zsh, which does not word-split, and produced all
  zeros and "File name too long". A bash rerun then exited having printed
  only its header. The figures above come from the third, `xargs -0` form,
  checked against the 09-15 figures at `89fadec0`.
- **The coupling gate on a non-existent path.** It prints `no covered docs
  implicated` for a path that does not exist, so a typo in block 2's
  confirmation step would confirm a miss falsely. Every path confirmed here
  came from `git ls-files`.
- **The `any` meter in block 3.** It is mostly prose: of 24 lines, 6 are
  code `any` (`rails/delegation-rail.ts` ×5, `mcp/src/server.ts` ×1), and
  the rest are English ("any long-lived", "as anything"). The recorded trend
  14 → 18 → 23 → 24 is not a code trend. The reference's regex should
  target type positions.

## 6. Decisions requested

1. **F1:** file as an epic with the four slices above, or narrow it to a
   candidate (for example slices 1 and 2 only)?
2. **C1–C5:** file each as its own issue? C2 is proposed as a comment on
   #3019 instead of a new issue.
3. Should the §5 instrument lessons (the gate on a non-existent path, the
   `any` regex) go into the quality-scan reference in the ledger PR, or
   separately?
