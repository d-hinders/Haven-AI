---
owner: "@d-hinders"
status: current
covers: []  # narrative — list the code paths this doc describes, one per line
last-verified: "2026-10-13"
---

# Release checklist

One page, for a human: every step below can be done by **any of the three
maintainers** (@d-hinders, @AntonioSaaranen, @PhilipEriksson — owner decision
2026-10-09, #3798). The canonical detail lives in
[`promoting-dev-to-main.md`](promoting-dev-to-main.md),
[`branch-and-release-flow.md`](../contributing/branch-and-release-flow.md) §
*Promotion to production* and the `release` skill — read those when a step is
unclear; this page is the order, not the reasoning.

1. **Ask an agent session to release** (or run the `release` skill yourself):
   it cuts the version bump, opens the release PR **into `dev`** and runs the
   preflight. Confirm you actually want the release — cutting and shipping are
   two decisions.
2. **Approve the release PR** (or have the agent session's independent
   reviewer do it). Merge it into `dev` — a squash, like every `dev` PR.
3. **Hold `dev` while the promotion PR is open.** No merges to `dev` until the
   promotion lands: its head is the `dev` branch, and every merge moves it,
   dismisses approvals and re-runs checks.
4. **When migrations are in range — code-owner approval** from someone other
   than the PR's author (`packages/backend/src/db/migrations/*.ts` is the one
   hard-gated path). Request it when opening, not when it blocks.
5. **When migrations are in range — prod DB snapshot** must exist before the
   migrations run on deploy (see `promoting-dev-to-main.md` § *Migrations*).
6. **Click Merge.** Any of the three maintainers: the ordinary **Merge pull
   request** button, **merge commit** form, in the web UI (`gh pr merge
   --merge` from a terminal works too). The PR showing as BEHIND `main` is
   expected — merge it anyway; there is no sync-back to undo it. Never squash
   a promotion. `qa-override` is a maintainer decision, not owner-only: decide
   before opening and apply the label at open (a later label needs a
   close/reopen to be re-read) — it is never an agent's call.
7. **Check the npm dist-tags** — all five packages on **both** `alpha` and
   `latest`, polled for several minutes (the registry lags; a single early
   read looks exactly like a stranded tag):

   ```sh
   for p in sdk signer mcp connect cli; do npm view @haven_ai/$p dist-tags --json; done
   ```

   A green publish with `latest` unmoved is a red `promote-tags` job — re-run
   that one job, never cut another version.
8. **Confirm the migrations applied** in the Railway deploy log (and watch the
   Vercel frontend deploy). A non-transactional migration that died part-way
   names its own recovery statements — do not restart hoping it clears.
9. **Real-payment canary.** The prod smoke's canary is a real payment through
   the funded prod wallet — an operator step, never reported done while
   outstanding.

The full prod smoke (boot-log check, error-log watch, rollback path) is
`promoting-dev-to-main.md` § *Merge, deploy, and verify prod* — the merge is
not the finish.
