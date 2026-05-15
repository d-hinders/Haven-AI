# PR Workflow Checklist

Use this checklist for feature branches so PRs stay mergeable, reviewable, and deployable.

## Before You Start

- Branch from `main` unless the work truly depends on another unmerged branch.
- Keep the branch scoped to one shippable outcome.
- If the work touches payments, agent authority, Safe setup, relaying, SDK payment APIs, x402/MPP, fiat/card, swaps, merchant flows, yield, or advice, read `docs/regulatory/casp-risk-guardrails.md` first.
- If the work spans backend, frontend, and migrations, ask whether it should be split into multiple PRs first.
- If the change touches migrations, assume merge risk is high and keep the branch short-lived.

## Preferred PR Shape

- Prefer direct-to-`main` PRs over stacked PRs for product features.
- Prefer 1 focused feature per PR.
- Prefer follow-up PRs over one large “finish everything” branch.

Good split examples:

- PR 1: backend endpoint or data model
- PR 2: frontend UI that consumes it
- PR 3: polish, onboarding, or follow-up flows

## During Development

- Open the PR early, even if it starts as draft.
- Sync with `main` regularly if the repo is moving.
- Rebuild after each `main` sync, not just at the end.
- Call out risky files in the PR description:
  - migrations
  - auth
  - shared hooks
  - shared UI components
  - top-level routes

## Before Requesting Review

- Merge or rebase the latest `main` into the branch.
- Confirm the branch still builds locally.
- Run the relevant local checks from the command guide below.
- Confirm the PR target is `main` if the work is meant to deploy after merge.
- Confirm migrations are uniquely ordered and named.
- Confirm payment-related changes preserve the CASP guardrails: no Haven-held user or agent keys, no API-key-only payment authority, no off-chain-only spend control, no mutation of signed amount/token/recipient/route, and no unreviewed swap, ramp, fiat, card, merchant settlement, yield, or advice functionality.
- Confirm the PR description explains:
  - what changed
  - what was intentionally left out
  - what reviewers should focus on

## Before Merging

- Re-check that the PR has no conflicts with `main`.
- Re-check that the branch still builds after the latest `main` sync.
- Re-run the relevant local checks if the branch changed after review.
- If the PR started stacked, re-open or retarget it so the final merge path is into `main`.
- Verify that merging this PR will trigger the expected deployment branch.

## Local Check Commands

Use the smallest reliable set that matches the change.

| Change type | Commands |
| --- | --- |
| Docs or prompt-only | `git diff --check` |
| Payment, Safe, relayer, SDK payment APIs, or agent authority | Relevant package checks plus the checklist in `docs/regulatory/casp-risk-guardrails.md` |
| Backend/API | `npm run typecheck -w packages/backend` and `npm run test -w packages/backend` |
| Frontend unit/UI | `npm run typecheck -w packages/frontend`, `npm run test -w packages/frontend`, and `npm run build -w packages/frontend` |
| SDK | `npm run typecheck -w packages/sdk`, `npm run test -w packages/sdk`, and `npm run build -w packages/sdk` |
| Cross-package or release-risk | `npm run quality` |
| Browser UX or routing | Relevant unit/build checks plus `npm run test:e2e:desktop -w packages/frontend` when the local Playwright server is working |

Notes:

- `npm run quality` means typecheck, unit tests, and builds across workspaces.
- Frontend lint is not a required gate yet because `next lint` currently prompts for ESLint setup. Add lint only after a dedicated non-interactive lint migration.
- Playwright desktop smoke is useful but currently known to be unreliable in some local environments; call out skipped or failed browser checks in the PR description.

## Team Habits That Help

- Keep feature branches short-lived.
- Avoid letting PRs sit unmerged while related work lands in the same files.
- Treat migrations as coordination points, not routine files.
- Prefer making the smallest deployable slice first.
- If a branch starts getting broad, stop and split it before review gets deep.

## Questions To Ask Up Front

- Should this branch come from `main` or is there a real dependency?
- Can this be split into backend and frontend PRs?
- Does this add or modify a migration?
- Which files are most likely to conflict with in-flight work?
- What is the smallest version we can merge safely this week?

## Quick Copy-Paste Checklist

- [ ] Branch from `main`
- [ ] Scope is one shippable outcome
- [ ] Draft PR opened early
- [ ] Synced with `main` recently
- [ ] Relevant local checks run
- [ ] Migrations are uniquely ordered
- [ ] PR target is the deploy branch
- [ ] Conflicts with `main` checked before merge
