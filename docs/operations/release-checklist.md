---
owner: "@d-hinders"
status: current
covers: []  # narrative — list the code paths this doc describes, one per line
last-verified: "2026-10-29"
---

# Release checklist

One page, for a human: every step below can be done by **any of the three
maintainers** (@d-hinders, @AntonioSaaranen, @PhilipEriksson — owner decision
2026-10-09, #3798) — except starting the optional eval step's approval, which
only the owner can give and which never holds a release. The canonical detail
lives in
[`promoting-dev-to-main.md`](promoting-dev-to-main.md),
[`branch-and-release-flow.md`](../contributing/branch-and-release-flow.md) §
*Promotion to production* and the `release` skill — read those when a step is
unclear; this page is the order, not the reasoning.

1. **Ask an agent session to release** (or run the `release` skill yourself):
   it cuts the version bump, opens the release PR **into `dev`** and runs the
   preflight. Confirm you actually want the release — cutting and shipping are
   two decisions. Before the bump is cut, decide **once** which open PRs into
   `dev` that touch a published package are in or out — the scope freeze,
   announced on the release PR and #3193.
2. **Approve the release PR** (or have the agent session's independent
   reviewer do it). Merge it into `dev` — a squash, like every `dev` PR. If the
   `Haven AI / dev` deployment for the merge SHA is not live 8 minutes after
   the merge, it looks stalled — a Railway redeploy is the remedy.
3. **Hold `dev` while the promotion PR is open.** No merges to `dev` until the
   promotion lands: its head is the `dev` branch, and every merge moves it,
   dismisses approvals and re-runs checks. The PR also carries an **Owed at this
   release** section — the issues filed under the
   [`Next release` convention](../contributing/branch-and-release-flow.md#promotion-to-production-dev--main)
   that this promotion carries, each linked as `Refs #<n>`.
4. **When migrations are in range — code-owner approval** from someone other
   than the PR's author (`packages/backend/src/db/migrations/*.ts` is the one
   hard-gated path). Request it when opening, not when it blocks.
5. **When migrations are in range — prod DB snapshot, recommended, not a
   gate.** Take one before the migrations run on deploy when the plan allows
   it. The current Railway plan shows a Backups tab but cannot create new
   backups, so skipping it is allowed (owner decision, 2026-10-23). Say on
   the promotion PR which you did. Without a snapshot nothing undoes a
   migration that applies and writes wrong data, and a `transactional =
   false` migration (see the `migrate.ts` header) does not roll back even
   when it fails. So the forward-only / safe-on-existing-rows review carries
   that risk. Run any data precondition a migration states (for example a
   duplicate check before a new unique index) against prod before merging.
   See `promoting-dev-to-main.md` § *Migrations*.
6. **Optional, non-blocking: run the agent evals.** Start a run from the
   Actions tab or with
   `gh workflow run agent-evals.yml --repo d-hinders/Haven-AI --ref dev -f suite=full`
   (`-f suite=subset`, or `-f tasks=<ids>` for an exact list). The job sits
   behind the owner-approved `agent-evals` environment, so **only the owner can
   approve it** — that approval is the one step here a maintainer cannot do for
   another. It **never blocks a release**: the workflow is manual-only, is not a
   required check and is not wired into `dev-gate.yml`, so a red, skipped or
   unapproved run holds nothing. A **second full run in one budget period exits
   3** and reports "not run" — a full run drains the eval agent's period budget
   on purpose, so wait for the refill (or start a new period on the dev
   dashboard) before running again. Details:
   [`agent-evals.md`](agent-evals.md) § *Running the suite*.
7. **Click Merge.** Any of the three maintainers: the ordinary **Merge pull
   request** button, **merge commit** form, in the web UI (`gh pr merge
   --merge` from a terminal works too). The PR showing as BEHIND `main` is
   expected — merge it anyway; there is no sync-back to undo it. A promotion
   PR opened before its required checks and code-owner approval are in shows
   only **Update branch** and **Enable auto-merge**, with no merge button —
   that is the gate working, not a blocker: never **Update branch** a
   promotion (that is the forbidden sync-back); wait for checks and approval
   and the merge button appears. Never squash
   a promotion. `qa-override` is a maintainer decision, not owner-only: decide
   before opening and apply the label at open (a later label needs a
   close/reopen to be re-read) — it is never an agent's call.
8. **Check the npm dist-tags** — all five packages on **both** `alpha` and
   `latest`, polled for several minutes (the registry lags; a single early
   read looks exactly like a stranded tag):

   ```sh
   for p in sdk signer mcp connect cli; do npm view @haven_ai/$p dist-tags --json; done
   ```

   A green publish with `latest` unmoved is a red `promote-tags` job — re-run
   that one job, never cut another version.
9. **Run the closeout log check** and paste its block onto the promotion PR.
   It binds the evidence to the promotion's merge SHA: the deployment's
   identity must equal that SHA, both boot markers (`Database migrations
   complete`, `Haven backend running on port`) must be present in that
   deployment's log, and the unset-public-RPC warning must be absent. A
   non-transactional migration that died part-way names its own recovery
   statements — do not restart hoping it clears. If the script cannot run for
   you, the manual check in `promoting-dev-to-main.md` § *Merge, deploy, and
   verify prod* reaches the same verdict in the Railway web UI.
10. **Real-payment canary.** The prod smoke's canary is a real payment through
   the funded prod wallet — an operator step, never reported done while
   outstanding.
11. **Work the owed issues.** Every issue the promotion PR lists under *Owed at
    this release* is worked now: record the result on the issue, remove
    `operator-verify` and close it. An issue whose prerequisite did not reach
    prod is carried to the next promotion, with the reason recorded on the
    issue. The promotion is not closed out while one is open and not carried.
    The convention and its selector are
    [`branch-and-release-flow.md` § *Promotion to production*](../contributing/branch-and-release-flow.md#promotion-to-production-dev--main).

The full prod smoke (the closeout log check and its manual fallback, the
error-log watch, the rollback path) is `promoting-dev-to-main.md` § *Merge,
deploy, and verify prod* — the merge is not the finish.
