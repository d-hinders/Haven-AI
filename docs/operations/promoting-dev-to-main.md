---
owner: "@d-hinders"
status: current
covers:
  - .github/workflows/dev-gate.yml
  - .github/workflows/publish.yml
  - .github/workflows/qa-dev.yml
  - .github/workflows/qa-live.yml
  - docs/operations/dev-environment.md
last-verified: "2026-09-07" # #2633: EDITED, scope = the "Required checks are green" item under § *Open and review the PR*, split in two. It named `dev-gate` and stopped; the bar is now written out as a list — 19 required contexts, the 15 shared with `dev` plus `gate`, `qa-freshness`, **Design visual regression** and **Frontend browser smoke**, the last two added to ruleset 18134280 on 2026-09-07 by epic #2632's owner step O2 — with the note that `main` is now the only branch still requiring an up-to-date head, since O1 removed that policy from the shared ruleset. Numbers point at the inventory in `../contributing/autonomous-pr-loop.md` step 3 rather than being restated. Verified against `gh api repos/d-hinders/Haven-AI/rulesets`. Scope: that ONE item. NOT re-verified: the QA, migration, sweep-floor, env, npm or post-merge verification items. Prior: #2615: EDITED, scope = ONE new checklist item in § *Merge, deploy, and verify prod*, naming the production RPC variable set and the trap that produced the issue — `RPC_URL` reads as "RPC is configured" in a variable list and covers Gnosis (100) only, which the delegation rail does not use. The evidence standard is stated as the ABSENCE of the new boot warning in the deploy log rather than the presence of a variable in the Railway dashboard, matching what #2511 used one environment over: a dashboard read is a name-level observation, the boot log is the process saying what it resolved. The defaults in the table are read off `packages/backend/src/config.ts` on this branch, where each literal now lives in exactly one place (the `warnPublicRpc` call sites). NOT a claim that the variable IS set in production — it was not on 2026-09-07, that is the open operator step on #2615, and this item is written as the check rather than as a state. Scope: that ONE item. NOT re-verified: the migration bullet, the npm checklist, the rollback item, the smoke-hostname section, or any `covers:` target. Prior: #2421: the **npm** checklist item re-read against `.github/workflows/publish.yml`, which this PR changes. It still holds as written for the promotion: the prod path is version-gated, derives the tag from the version (`alpha`/`latest`) and reports per-package outcomes (#1159). What the item did not say, and now does, is that the SAME workflow gained a second channel — a push to `dev` publishes `0.0.0-dev.*` snapshots under the `dev` dist-tag — which changes nothing about this checklist, because a snapshot can reach neither `alpha` nor `latest` and a promotion cannot publish one. Scope: that ONE checklist item; the migration, sweep-floor, env and QA items were NOT re-verified in this pass. Prior: #2150: the "Migration availability" bullet re-read against the migration runner on this branch — the hand-run out-of-band pre-build is no longer the only way to get `CREATE INDEX CONCURRENTLY` past the runner's `BEGIN`/`COMMIT`, so it is demoted to a fallback behind the in-repo `transactional = false` opt-out, and the deploy-verification step gains the one failure state the opt-out introduces (a migration left `status = 'running'`, which stops the backend booting until an operator acts). Scope: those two bullets only — QA, npm, rollback and the merge-commit rule were not re-verified. Prior: #2151: the migration checklist re-read for hot-table lock availability; adds the lock-duration question and its pre-build/low-traffic mitigations. Prior: re-verified for #1266 demo merchant x402 settlement selection/canary posture
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
      `qa-override`.
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
