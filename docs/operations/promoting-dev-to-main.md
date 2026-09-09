---
owner: "@d-hinders"
status: current
covers:
  - .github/workflows/dev-gate.yml
  - .github/workflows/publish.yml
  - .github/workflows/qa-dev.yml
  - .github/workflows/qa-live.yml
  - docs/operations/dev-environment.md
  - scripts/release-scope.mjs
last-verified: "2026-09-09"
---

# Promoting `dev → main` (production release)

Merging `dev → main` deploys to **production** (Railway + Vercel) and, if the
batch includes a version bump, publishes the npm packages. It is a deliberate,
human-run step — the prod circuit-breaker that sits in front of everything the
loop and contributors merged into `dev`. Run it on a cadence, not per-merge.

Only `dev` (or a `hotfix/*` branch) may open a PR into `main` — the
[`dev-gate`](../../.github/workflows/dev-gate.yml) workflow enforces it. For the
branch model that feeds `dev`, see
[`../contributing/pr-workflow-checklist.md`](../contributing/pr-workflow-checklist.md);
for how the environments are wired, see
[`dev-environment.md`](./dev-environment.md).

## Before opening the promotion PR

- [ ] `dev` CI is green, and the **dev environment is healthy** — the Railway/
      Vercel dev deploys are live with no errors in recent logs.
- [ ] Manually dispatch **QA — money-flow (dev)** from `dev` and confirm all
      scenarios pass, or link and assess every known failure. See
      [`agent-qa.md`](./agent-qa.md) for secrets, funding, commands, and result
      interpretation.
- [ ] Run **QA — live smoke (dev)** against the branch-tracking `dev` preview (the canonical dev URL in [dev-environment.md](dev-environment.md)) and review
      its Playwright artifact if it fails.
- [ ] The change set has **soaked on `dev`** — exercise the key flows against the
      dev URL (login, balances, one x402 / payment happy path).
- [ ] **Docs-visible CLI changes get a release, paired with the promotion.** When
      the batch changes an agent-facing surface that names a CLI command only a
      tagged build has — the runbook (`/for-agents.md`, `haven guide`) and the
      well-known manifest naming CLI commands as `@<channel>`
      ([#2617](https://github.com/d-hinders/Haven-AI/issues/2617)) — a
      `release:bump` must follow (or be paired with) the `dev → main`
      promotion, so the `alpha`/`latest` dist-tags catch up with what the docs
      tell agents to run. Do **not** move `latest` by hand; the bump and the
      publish workflow own it. Without this, an agent following the runbook to
      the letter resolves the command to a dist-tag that predates the change.

- [ ] **Re-measure the release scope, here at the door.** `publish.yml` rebuilds
      the tarballs from **`main`'s tree at promotion time**, not from the bump
      commit — so anything merged to `dev` since the bump publishes inside this
      release whether or not the release record names it.

      ```sh
      npm run release:scope        # origin/main..origin/dev
      ```

      Compare the shipped delta against the CASP shard for this version and amend
      the shard if they disagree. The script reads what ships from each package's
      built sourcemaps and `files` field. Build first (`npm run build`) — it
      **refuses** (exit 2) rather than guessing when a package is unbuilt, and a
      refusal means "measure again", never "clean".

      An **exit 1** is different and must not be read as a refusal: the delta WAS
      measured, but one or more source files could not be classified. Only one of
      the three causes it prints is a stale build; the other two are benign and a
      rebuild will not change them. Read the list and decide, rather than
      rebuilding reflexively. Do not hand-count the diff
      ([#2724](https://github.com/d-hinders/Haven-AI/issues/2724)).

## The promotion window: `dev` is held

From the moment the promotion PR is **opened** until it **merges**, `dev` is
held: do not merge feature or release PRs into `dev` during the window
([#2725](https://github.com/d-hinders/Haven-AI/issues/2725)). Nothing
technically enforces this — GitHub will happily accept dev merges — which is
exactly why it has to be written down.

The reason the window exists is the shape of the promotion PR: its **head is
the `dev` branch**, not a pinned SHA. Anything merged to `dev` while the PR is
open moves that head and becomes part of the promotion, at three costs:

1. **All 19 required contexts on `main` go pending again** and must re-run
   green before the promotion can merge.
2. **`qa-freshness` re-evaluates coverage, not just recency**: a new commit
   touching a money-path file the green QA run did not cover turns the gate
   red, and clearing it takes another dispatched money-flow run.
3. **The promoted scope silently changes** — the release-record trap
   [#2724](https://github.com/d-hinders/Haven-AI/issues/2724) documents: the
   tarballs are built from `main`'s tree at promotion time, so the extra
   commits publish inside this release whether or not the release record
   names them.

A code-owner-gated promotion can also sit waiting on a human for an unbounded
time — reviews are not on a CI clock — so the window is routinely **longer
than the CI duration suggests**. Plan the hold around that, not around the
green checks.

**If something must land on `dev` anyway**, treat it as reopening the
preparation rather than an exception to ride through: re-measure the release
scope (the item above), re-dispatch **QA — money-flow (dev)**, and expect a
full re-run of the required contexts.

**The hold lifts the moment the promotion merges.** The tarballs were built
from `main` at that point, so subsequent merges to `dev` only deploy to the
dev environment and publish `0.0.0-dev.*` snapshots under the `dev` dist-tag —
neither can reach the released version (see the *npm* item above for the
channel split).

## Open and review the PR (base `main`, head `dev`)

- [ ] Skim the **cumulative diff since the last promotion**. Since #1024 removed
      the in-session money-path pause, this is the **only** human look at
      money-path changes before prod — read it as such. Confirm nothing changes
      *who can move funds* or *auto-execute vs. queue* unintentionally.
- [ ] **Money-flow QA coverage is now checked automatically** ([#1030](https://github.com/d-hinders/Haven-AI/issues/1030)):
      `qa-freshness` fails if any money-path file changed after the newest green
      `qa-dev` run, naming the offending commits. You no longer have to verify
      this by hand — if the gate is green, the run covered the money path. If it
      fails, re-run *QA — money-flow (dev)* rather than reaching for
      `qa-override`. Read the result at the **`money-flow` job's** conclusion,
      never the run's: a run the post-deploy gate skipped still concludes
      `success` at run level, so a green tick in the Actions list can mean
      nothing ran ([#2725](https://github.com/d-hinders/Haven-AI/issues/2725);
      the gate's semantics live in
      [`agent-qa.md`](./agent-qa.md) § *Automation & gating*).
- [ ] **Migrations:** list every migration included since the last promotion.
      Confirm each is **forward-only / safe on existing rows**, and that a
      **prod DB snapshot** exists before they run on deploy.
- [ ] **Migration availability:** does any migration build an index, rewrite a
      table, or otherwise hold a lock on a hot table? If so, record the expected
      lock duration and mitigation. Since #2150 the first choice is in the repo,
      not in an operator's hands: a migration that declares
      `export const transactional = false` runs outside the runner's
      transaction, so it can build with `createIndexConcurrently()` and block no
      writes at all. Read `packages/backend/src/db/migrate.ts`'s header before
      accepting one — it trades rollback for detection. The older mitigations
      remain the fallback for a migration that does **not** declare it:
      pre-build the index under the same name, out of band with
      `CREATE INDEX CONCURRENTLY`, so the deploy's `IF NOT EXISTS` is a no-op,
      or use a low-traffic deployment window.
- [ ] **No dev-only config leaks into prod:** production leaves
      `NEXT_PUBLIC_HAVEN_ENV` unset (no `DEV` badge) and keeps its own
      secrets / relayer key / RPCs (these live on the platforms, not in code —
      just confirm nothing dev-specific was hardcoded).
- [ ] **Sweep recovery floor:** set the production backend's
      `SWEEP_MIN_USDC=0.01` (or remove any legacy `1` override), redeploy, and
      verify the effective value before relying on the code default. For the
      exact recovery proof, use the operator sequence in
      [`agent-qa.md`](./agent-qa.md): prepare a delegate holding exactly
      `10000` atomic USDC, sign only through the local signer, submit, and
      confirm the delegate is drained to the Haven wallet.
- [ ] **npm:** if the batch includes a version bump, `publish.yml` publishes on
      merge — confirm the version and the intended dist-tag (`alpha` vs `latest`),
      then read the run's **per-package summary table**: a package can fail while
      the others publish (#1159), so green-except-one is a real outcome, not a
      binary.
      Since [#2421](https://github.com/d-hinders/Haven-AI/issues/2421) the same
      workflow also publishes `0.0.0-dev.*` snapshots under a separate `dev`
      dist-tag on pushes to `dev`. That is a different channel and changes
      nothing in this checklist: a snapshot can reach neither `alpha` nor
      `latest`, and this promotion cannot publish one.
      Since [#2647](https://github.com/d-hinders/Haven-AI/issues/2647) the move
      of `latest` onto what was just published is a **second job**,
      `promote-tags`, so there are two outcomes to read, not one. A green
      publish with a red `promote-tags` means the versions are live under
      `alpha` while `latest` still points at the previous release — check
      `npm view @haven_ai/<pkg> dist-tags` before calling the promotion done.
      The usual cause is the job's npm token (expires 2026-12-06, npm caps
      these at 90 days); the fix is to renew it and re-run that job, never to
      cut another version.
- [ ] **The prod bar is green.** A promotion PR must satisfy **19** required
      contexts: the 15 that every PR into `dev` also meets, plus four required on
      `main` only —
      - `gate` — refuses anything but `dev` / `hotfix/*`;
      - `qa-freshness` — refuses without a green money-flow run covering the
        promoted money-path code (the item above);
      - **Design visual regression** — required here since 2026-09-07
        ([#2632](https://github.com/d-hinders/Haven-AI/issues/2632)), replacing the
        blocking role it used to play on `dev` PRs;
      - **Frontend browser smoke** — required here since the same change.

      `main` is also the only branch still requiring the head to be up to date,
      so a `BEHIND` promotion PR must be brought forward before it can merge.
      The per-branch inventory and the `gh api` command that produced it are in
      [`../contributing/autonomous-pr-loop.md`](../contributing/autonomous-pr-loop.md#one-time-github-setup-required)
      step 3.
- [ ] **Sweep the docs staleness audit** ([#2645](https://github.com/d-hinders/Haven-AI/issues/2645), "Docs staleness audit (weekly)" — one standing issue that `docs-audit.yml` rewrites every Monday). Open it and give every `current`-status doc it ranks one of three dispositions — the same three as [`ship-next` § *Filing bar*](../../.agents/skills/ship-next/SKILL.md#filing-bar-2767) (#2767): **fix** it (here or in a follow-up PR you open), **drop** it with the reason recorded in this promotion PR, or **file** it only when it clears the bar (a doc claim on its own does not — fix or drop). Contract docs cannot reach here — the coupling gate blocks them on the PR that made them stale — so what this sweeps is the *non-contract* drift that is allowed to accumulate on `dev` between promotions, which is exactly the class no per-PR gate is watching. `archived` and `research` docs are not ranked and need no disposition (#2638). An empty or unchanged report is a valid outcome; say so rather than leaving the item silently unticked.
- [ ] A code-owner approval is present if the batch touches an owned path
      (migrations / release tooling / CODEOWNERS).

## Merge, deploy, and verify prod

- [ ] Merge the promotion PR **with a merge commit** (`gh pr merge --merge`),
      never squash. A squash-promotion puts a history-less copy of the batch on
      `main`; the moment `dev` refactors any of those files, the next promotion
      PR goes DIRTY with mass conflicts (this happened with #1152 → #1172, and
      took a `-s ours` reconcile merge, #1173, to repair).
- [ ] Watch the **prod deploys** finish (Railway backend / MCP, Vercel frontend)
      and confirm the **migrations applied cleanly** to the prod DB. A backend
      that refuses to boot with *"Migration … was left INCOMPLETE by an earlier
      run"* means a **non-transactional** migration (#2150) died part-way: its
      statements were not rolled back, and the error itself carries the two
      recovery statements. Do not restart hoping it clears — it will not, by
      design. Decide from the schema whether to finish it by hand or undo it,
      then run the matching statement.
- [ ] **Read the boot log for RPC warnings (#2615).** The backend now warns once
      per unset public-RPC default, and the evidence standard is the ABSENCE of
      that line in the deploy log — not the presence of the variable in the
      Railway dashboard. A dashboard read is a name-level observation; the boot
      log is the process saying what it resolved.

      The production variable set, and the trap in it:

      | Variable | Chain | Unset means |
      |---|---|---|
      | `RPC_URL` | Gnosis (100) | shared public `https://rpc.gnosischain.com` |
      | `RPC_URL_BASE` | Base **mainnet** (8453) | shared public `https://mainnet.base.org` — **real money** |
      | `RPC_URL_BASE_SEPOLIA` | Base Sepolia (84532) | shared public `https://sepolia.base.org` |

      **`RPC_URL` alone does not configure Base.** It reads like "RPC is
      configured" in a variable list and covers Gnosis only — chain 100, which
      the delegation rail does not use. That is the exact shape production was
      found in on 2026-09-07 (#2615): `RPC_URL` present, `RPC_URL_BASE` absent,
      every mainnet settlement, account deploy and caveat-enforcer read going
      through a shared unauthenticated node with no signal of any kind. Dev had
      the identical shape before #2511.

      Use a key distinct from the dev/QA ones, so usage is attributable and
      either can be rotated alone.

- [ ] **Prod smoke:** load the prod app (no `DEV` badge), check login + balances,
      and run one small real payment / x402 happy path as a canary.
- [ ] Watch prod error logs for a few minutes. If anything is off, **roll back**
      (Railway redeploy-previous / Vercel instant rollback) and, if a migration is
      implicated, restore from the pre-deploy snapshot.

## Run the prod smoke on the right hostname

Vercel lists **three** hostnames under the Production environment. Two are
production; one is a trap:

| Hostname | What it actually serves |
|---|---|
| `haven-ai-frontend.vercel.app` | Production deployment → **prod backend** ✅ |
| `haven-ai-frontend-daniels-projects-f3327ba2.vercel.app` | Same production deployment → **prod backend** ✅ |
| `haven-ai-frontend-git-main-…vercel.app` | **Not production** → dev backend ⚠️ |

The third is the *branch alias* for `main`, and a branch alias always points at
the newest deployment **of that branch, whatever its environment**. On
2026-07-12 someone re-deployed `main`'s tip commit and the redeploy landed as a
**Preview** deployment — so it was built with Preview-scope env vars (dev
backend, `DEV` badge) and it took the alias. Verified 2026-08-06: its
`/api/chains` returns the dev backend's response while both production
hostnames return the prod backend's.

Nothing is misconfigured — Production tracks `main`, the domain is connected to
the Production *environment* rather than pinned to a deployment, and
`NEXT_PUBLIC_API_URL` is scoped to both Production and Preview. It is one stray
deployment holding a confusing name.

- **Never "Promote to Production" that deployment.** It was built with Preview
  env vars, so promoting it would point the production domain at the **dev
  backend** and switch on the dev-only flags.
- **Resolved 2026-08-06** by deleting the stray Preview deployment (Deployments →
  filter `main` → the "Redeploy of…" row → ⋯ → Delete). The `-git-main-` hostname
  now returns `DEPLOYMENT_NOT_FOUND` rather than falling back to the production
  deployment, and Vercel's *Branch link for main* is `haven-ai-frontend.vercel.app`
  — so the confusing hostname is simply gone. Verified: both production
  hostnames still serve the prod backend.
- If it ever reappears, the cause is the same — a Preview deployment on `main`
  taking the branch alias — and so is the fix. Smoke prod on
  `haven-ai-frontend.vercel.app` regardless.

Separately: `main` has not moved since **2026-06-26**, so production is a long
way behind `dev`. That is a promotion backlog, not a deploy bug — the pipeline
below is wired correctly and will deploy whatever you merge.
