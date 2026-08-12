---
owner: "@d-hinders"
status: current
covers:
  - .github/workflows/**
  - .github/pull_request_template.md
  - package.json
  - .agents/skills/haven-agent-workflow/references/reviewer.md
  - .agents/skills/haven-agent-workflow/references/design-reviewer.md
last-verified: "2026-08-09" # #1227: lint:db-mocks added to the Backend/API verification row
---

# PR Workflow Checklist

Use this checklist for feature branches so PRs stay mergeable, reviewable, and deployable.

## Branch Model

> Canonical reference: [`branch-and-release-flow.md`](branch-and-release-flow.md) — the full dev → prod lifecycle, issue closing, and prod-promotion tracking. The summary below is the gist.

Haven uses a `dev` integration branch in front of `main`:

- **Feature work flows `feature/* → dev → main`.** Branch from `dev`, open your
  PR into `dev`, and let it merge there once green. `dev` is the shared
  integration branch and deploys to the **dev environment** (Railway + Vercel).
- **`dev → main` is a separate promotion step** (a human-opened PR). Merging to
  `main` deploys to **production** — follow the
  [`dev → main` promotion checklist](../operations/promoting-dev-to-main.md).
- **`hotfix/* → main` is the only direct-to-`main` path**, for emergency fixes
  that can't wait for the dev cycle.
- The **`dev-gate`** workflow (`.github/workflows/dev-gate.yml`) enforces this:
  only `dev` or `hotfix/*` may merge into `main`. A `feature/*` PR aimed at
  `main` will fail the gate — retarget it to `dev`.

Throughout this checklist, "the base branch" means **`dev`** for normal feature
work (and `main` only for a `hotfix/*`).

## Before You Start

- Branch from `dev` unless the work truly depends on another unmerged branch.
- Keep the branch scoped to one shippable outcome.
- For non-trivial feature, UX feedback, or bug-fix work, use `docs/contributing/ai-agent-workflow.md` before implementation and decide the captain, explorer, worker, and reviewer shape up front.
- If the work touches payments, agent authority, Safe setup, relaying, SDK payment APIs, x402/MPP, fiat/card, swaps, merchant flows, yield, or advice, read `docs/regulatory/casp-risk-guardrails.md` first.
- If the work spans backend, frontend, and migrations, ask whether it should be split into multiple PRs first.
- If the change touches migrations, assume merge risk is high and keep the branch short-lived.

## Preferred PR Shape

- Prefer direct-to-`dev` PRs over stacked PRs for product features.
- Prefer 1 focused feature per PR.
- Prefer follow-up PRs over one large “finish everything” branch.

Good split examples:

- PR 1: backend endpoint or data model
- PR 2: frontend UI that consumes it
- PR 3: polish, onboarding, or follow-up flows

## During Development

- Open the PR early, even if it starts as draft.
- Sync with `dev` regularly if the repo is moving.
- Rebuild after each `dev` sync, not just at the end.
- Call out risky files in the PR description:
  - migrations
  - auth
  - shared hooks
  - shared UI components
  - top-level routes

## Before Requesting Review

- Merge or rebase the latest `dev` into the branch.
- Confirm the branch still builds locally.
- Run the relevant local checks from the command guide below.
- Confirm the PR target is `dev` (or `main` only for a `hotfix/*`).
- Confirm migrations are uniquely ordered and named.
- Confirm payment-related changes preserve the CASP guardrails: no Haven-held user or agent keys, no API-key-only payment authority, no off-chain-only spend control, no mutation of signed amount/token/recipient/route, and no unreviewed swap, ramp, fiat, card, merchant settlement, yield, or advice functionality.
- Complete the PR template sections for changed surfaces, workflow used, agents used or skipped, local checks, browser or headless verification, generated artifacts, CASP/MiCA guardrails, review status, and merge readiness.
- Include a merge-readiness section using the template below for non-trivial PRs.
- Run the **Captain Self-Check Preflight** in `docs/contributing/ai-agent-workflow.md` for the surfaces the diff touches.
- If browser verification is skipped for UI, routing, modal, setup-flow, or animation work, add the smallest headless equivalent that covers the skipped risk and name it in the PR.
- For frontend diffs touching a rendered route or a shared primitive, attach rendered-screen evidence (`npm run screenshot -w packages/frontend -- <routes>`, desktop + mobile PNGs) and get a `haven-design-reviewer` pass over the screenshots in addition to `haven-reviewer` — a finding from either pauses auto-merge (`ship-playbooks/frontend.md`).
- If the PR adds a `ui/` or `haven/` primitive, document it on `/design-system` in the same PR — the *Design-system coupling (strict)* check blocks on a missing showcase entry — on every PR, however it was opened ([#1023](https://github.com/d-hinders/Haven-AI/issues/1023)) — and a sticky comment explains the finding. Check locally with `npm run design:coupling -w packages/frontend -- --strict`; escape: `// design-system-exempt: <reason>`.
- If SDK/API behavior, credential semantics, x402/MPP behavior, setup prompts, or product language changes, review generated credential files, `.env` examples, SDK snippets, demo scripts, and skill bundles.
- Use `haven-reviewer` before requesting review when the change touches user-facing UX, money movement, agent authority, shared behavior, SDK/API contracts, generated artifacts, or meaningful risk.
- If this PR includes a follow-up commit that fixes a bug the original commits introduced, the fix commit must include the smallest regression test (typically a vitest case) that would have caught it. If no such test is practical, document why in the commit body. Every recent "Address reviewer findings" commit that compounded into durable quality landed 2–4 targeted vitest cases alongside the fix.

## Before Merging

- Re-check that the PR has no conflicts with `dev`.
- **Diagnosis rule (#1366): "only the labeler ran" on a push means the PR is
  CONFLICTING** — GitHub silently creates NO `pull_request`-triggered check
  runs when the merge commit cannot be built, while `pull_request_target`
  workflows (the labeler) still run on the base ref. It looks exactly like
  stalled checks or a GitHub outage. Check
  `gh pr view <n> --json mergeStateStatus` FIRST, never the GitHub status
  page; an empty retrigger commit will not help — resolve the conflict.
  Corollary: check `mergeStateStatus` BEFORE arming auto-merge; on `DIRTY`,
  merge `dev` into the branch first.
- Re-check that the branch still builds after the latest `dev` sync.
- Re-run the relevant local checks if the branch changed after review.
- If the PR started stacked, re-open or retarget it so the final merge path is into `dev`.
- Verify that merging this PR will trigger the expected deployment branch.
- For money movement, agent authority, SDK payment APIs, generated credential artifacts, x402/MPP, or shared contract changes, confirm a risk-specific review happened even if CI is green. The `money-path` label selects the `ship-playbooks/money.md` bar (characterization tests first, CASP guardrails) but does not pause the merge (#1024); DB migrations are hard-gated by an independent code-owner review, and `dev → main` promotion is gated on a green money-flow QA run that covers the promoted money-path code (#1030).
- If the PR intentionally changes what `/design-system` renders, regenerate the visual-regression baselines via the *Update visual baselines* workflow_dispatch on the PR branch (never commit macOS-rendered baselines), and confirm the *Design visual regression* check is green on the head SHA before calling the PR shipped.

## Merge Readiness Report

Use this in PR descriptions, final Codex/Claude handoffs, and "is this safe to merge?" answers:

```md
## Merge Readiness
- CI: passing / failing / pending
- Local checks: [commands run, or "not run" with reason]
- Review status: self-reviewed / reviewer-agent-reviewed / external review / not reviewed
- Risk level: low / medium / high
- Why safe to merge: [short reason]
- Residual risk: [none, or concrete follow-up]
- Recommended merge order: [if multiple PRs are open]
```

Green CI is necessary but not sufficient for risk-bearing work. The merge-readiness report should say why the branch is safe, not only that checks passed.

## Local Check Commands

Use the smallest reliable set that matches the change.

| Change type | Commands |
| --- | --- |
| Docs, prompts, or PR template only | `git diff --check` and `npm run docs:check` (front-matter + `covers` globs + agent-skill alignment) |
| Any source file | `npm run docs:coupling` — the strict contract-doc gate, keyed on **code**, so the docs row above never covers the pure-code PR that needs it |
| Payment, Safe, relayer, SDK payment APIs, or agent authority | Relevant package checks plus the checklist in `docs/regulatory/casp-risk-guardrails.md` |
| Backend/API | `npm run typecheck -w packages/backend`, `npm run test -w packages/backend`, `npm run lint:deps` (dependency boundaries, #982), and `npm run lint:db-mocks` (positional DB-mock ratchet, #1227) |
| Frontend unit/UI | `npm run typecheck -w packages/frontend`, `npm run design:lint -w packages/frontend`, `npm run lint:copy`, `npm run test -w packages/frontend`, and `npm run build -w packages/frontend` |
| SDK | `npm run typecheck -w packages/sdk`, `npm run test -w packages/sdk`, and `npm run build -w packages/sdk` |
| Cross-package or release-risk | `npm run quality` |
| Browser UX or routing | Relevant unit/build checks plus `npm run test:e2e:desktop -w packages/frontend` when the local Playwright server is working |

Notes:

- `npm run quality` means typecheck, unit tests, and builds across workspaces.
- Docs-only CI treats Markdown, agent-skill instructions, client adapters, and `.github/pull_request_template.md` as non-code, with one exception: editing `CLAUDE.md` runs the backend suite, because `packages/backend/src/docs-drift` pins the CLAUDE.md API table and chain registry to backend code. Editing `.github/workflows/*.yml` triggers full workflow checks.
- Frontend ESLint (`next lint`) is still not a required gate because it currently prompts for ESLint setup; add it only after a dedicated non-interactive lint migration. The blocking frontend gates that DO exist are design-lint (part of *Frontend checks*), the *Banned product-copy terms* copy lint (#902), and the *Design visual regression* job (#897) — both shrink-only-baseline lints fail on NEW violations only.
- The backend gate is stricter than the frontend baselines: **dependency-boundary lint** (#982, absolute since #999), a blocking step inside *Backend checks* enforcing `docs/architecture/10-module-boundaries.md` with **no baseline at all** — it fails on ANY violation. Fix the boundary; a reviewed, deliberate exception uses an inline `// dep-lint-exempt: <concrete reason>` comment on the offending import. `no-circular` can never be waived.
- Auto-merge is gated by the required checks in the **"Haven automerge rules"** ruleset (per-surface checks plus *Design visual regression* and *Banned product-copy terms*) — see `docs/contributing/autonomous-pr-loop.md` §One-time setup. A "blocking" job not in that list is advisory in practice.
- Every PR also gets two sticky comments: doc↔code coupling (docs whose `covers:` match changed code the PR didn't touch — update the flagged doc in the same PR) and design-system coupling. The doc↔code comment is advisory **except** for docs marked `contract: true`, which the separate *Contract-doc coupling* check blocks on (#646). Reproduce it locally with `npm run docs:coupling` — the bare `node scripts/docs/coupling-gate.mjs` always exits 0 and will not tell you what CI says.
- Playwright desktop smoke is useful but currently known to be unreliable in some local environments; call out skipped or failed browser checks in the PR description.

## Team Habits That Help

- Keep feature branches short-lived.
- Avoid letting PRs sit unmerged while related work lands in the same files.
- Treat migrations as coordination points, not routine files.
- Prefer making the smallest deployable slice first.
- If a branch starts getting broad, stop and split it before review gets deep.
- For cleanup waves, prefer one or two low-risk PRs and then stop. Move larger refactors into a new explicit project.
- For generated files or handoff artifacts, review the generated output whenever SDK/API behavior or product capabilities change.

## Questions To Ask Up Front

- Should this branch come from `dev` or is there a real dependency?
- Can this be split into backend and frontend PRs?
- Does this add or modify a migration?
- Which files are most likely to conflict with in-flight work?
- What is the smallest version we can merge safely this week?
- Does this change require generated docs, SDK examples, credential handoffs, or workflow prompts to be updated?
- Does this expose the same behavior through multiple entrypoints, such as HTTP headers, MCP tool arguments, SDK helpers, direct APIs, or demo scripts?
- If an agent or credential modal is involved, what clears one-time key state and in-flight action state on close, reopen, rotation, or revocation?

## Quick Copy-Paste Checklist

- [ ] Branch from `dev`
- [ ] Scope is one shippable outcome
- [ ] Draft PR opened early
- [ ] Synced with `dev` recently
- [ ] Relevant local checks run
- [ ] Migrations are uniquely ordered
- [ ] PR target is `dev` (or `main` for a `hotfix/*`)
- [ ] Conflicts with `dev` checked before merge
