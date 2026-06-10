# Haven AI Agent Workflow

This repo uses one main session as the captain and a few narrow subagents as specialists.

The captain is the main interactive session. It owns product judgment, git, shared files, final integration, and the branch or PR. Subagents are useful for isolated discovery, bounded implementation, and review.

## Default Delegation Policy

The captain decides whether the agentic flow is useful from the work itself. This document is the user's standing instruction to use subagents, delegated workers, and parallel delivery whenever the captain decides that is the best workflow. The user does not need to explicitly ask for agents, workers, subagents, or parallel delivery on every request.

For non-trivial feature delivery, UX feedback iteration, and bug fixing, use `haven-workflow-coordinator` by default before other agents. If the coordinator recommends explorer, worker, or reviewer agents, apply that plan without asking for another permission step. Inform the user briefly which agents are being used, what stays with the captain, and what checks are expected.

Skip subagents only when the work is trivial, when a tool or environment cannot support them, or when the coordinator decides the captain can deliver faster and safer alone. Do not say agents were skipped because the user did not explicitly ask for parallel agents.

## Recommended Sessions

Use one main Codex or Claude Code session per feature branch. Keep that session as the captain.

Open multiple full sessions only when the work is truly independent, such as separate branches or separate products. For one product feature, prefer one captain session with subagents.

## When To Skip The Agent Workflow

Keep tiny changes in the captain session when they are low risk:

- one file
- roughly fewer than 30 changed lines
- no behavior change
- no money movement or agent authority change
- no shared component, global style, package, lockfile, schema, or API contract change

Examples: copy fixes, small docs edits, a one-line display bug, or a local type cleanup. Even then, use judgment. If the tiny change touches money, permissions, approval states, or shared behavior, use the workflow.

## Review Lessons From Recent PRs

Use `docs/ai-review-patterns.md` as shared memory for recurring PR review issues that were relevant enough to fix.

Before final review, the captain should do a risk-specific self-check based on the changed surface:

- regulatory perimeter: for payment execution, agent authority, Safe setup, relaying, SDK payment APIs, x402/MPP, merchant, fiat/card, swap, yield, or advice surfaces, apply `docs/regulatory/casp-risk-guardrails.md`
- transactions and feeds: raw vs formatted values, totals, dedupe, pagination, source labels, and cross-surface consistency
- approvals and pending actions: status transitions, migrations or constraints, post-action copy, expiry, notification counts, and single vs multi-approval behavior
- send, receive, contacts, and other modals: primary action hierarchy, scroll, z-index, close behavior, typing behavior, duplicate handling, and network context
- hooks, APIs, and shared utilities: required vs optional arguments, caller audits, response shape changes, fallback values, and non-happy-path tests
- multi-entrypoint flows: shared verified state, payload shape, and tests across HTTP headers, MCP tool arguments, SDK helpers, direct APIs, and demo surfaces
- credential and setup surfaces: one-time credential visibility, modal reset behavior, in-flight action reset, identifier entropy, and setup-copy consistency
- generated artifacts: credential files, SDK examples, demo scripts, and skill bundles stay aligned with current Haven capabilities, env vars, product language, and regulatory guardrails

After a Claude or PR review, if a comment is both relevant and fixed, add the reusable pattern to `docs/ai-review-patterns.md`, the Captain Self-Check Preflight, and the reviewer prompt together. Do not add one-off preferences or obsolete implementation details.

Workers can implement narrow slices, but the captain owns cross-surface consistency, shared abstractions, PR shape, final review judgment, and deciding which review comments become durable workflow memory.

## Captain Self-Check Preflight

Before opening or pushing a non-trivial PR, the captain runs this preflight. Each item is one grep or one quick read. The list maps the recurring trap families from `docs/ai-review-patterns.md` to the smallest check that would have caught each of them on the first push.

Run only the items that match the changed surface. Skip the rest.

- **Numeric Formatters.** If the diff touches `*-format.ts`, or any file using `BigInt`, `toFixed`, `formatUnits`, or `parseUnits`: confirm the file has tests for negative inputs, zero, scientific-notation strings, and both the raw-bigint and already-decimal input shapes.
- **Counter And Summary Buckets.** If the diff adds a counter, summary line, or breakdown (`X received · Y sent · Z failed`): confirm there is a test with at least one row that could plausibly fall into multiple buckets (failed-outbound, failed-inbound).
- **Conditional Copy Predicates.** If the diff adds a string like `"This will replace…"`, `"Update budget"` vs `"Add budget"`, `"Resume"` vs `"Start"`: confirm there are tests for the no-match and exact-match branches of the predicate, and confirm the predicate matches on precise identity (token address or symbol), not on a broadened layout-driven boolean.
- **Async Hook Requests.** If the diff changes a hook that fetches keyed data (address, chain, agent id, filters, or enabled state): confirm late responses from older keys cannot overwrite current state, and add a staggered-resolution test for the smallest risky key change.
- **Signer Readiness Gates.** If the diff changes wallet, passkey, `useActiveSigner`, `useSafeOperationGate`, `OnchainActionGate`, `WalletButton`, or wallet-approval copy: confirm gated actions do not treat `address` or `isConnected` alone as signer readiness. EOA readiness must match the signer hook's `address && walletClient` requirement, and tests should cover address-present / walletClient-missing with a visible recovery action.
- **Animation Discipline.** If the diff adds or moves CSS animations: grep that every new keyframe rule is wrapped in `@media (prefers-reduced-motion: no-preference)`, that pre-existing animations getting a prominent placement are also gated, and that the className stack on the animated element does not toggle one animation class while another remains.
- **Inline Gate Placement.** If the diff renders `OnchainActionGate` or `NetworkGate`: confirm the notice is rendered **above** the action row, not inside the `flex-1` wrapper. Use `showNotice={false}` on the gate when rendering `<OnchainActionNotice />` separately.
- **Cross-Surface Display Drift.** If the diff changes a value rendered in 2+ surfaces (dashboard preview + detail card + agent page + transactions): confirm there is one shared formatter, that the input carries chain/token context, and that the API response includes the metadata each row needs.
- **Loading-State Inference.** If the diff infers onboarding or completion progress from a paginated preview list: reject and require an explicit `onboardingProgress.*` API field. Gate the dependent UI until **all** prerequisite hooks have resolved, not just the first one.
- **Multi-Entrypoint Parity.** If the diff changes a payment, x402/MPP, MCP, SDK, demo merchant, or hosted/local signing path: confirm every supported entrypoint uses the same validated payment state or has a parity test. Header, tool-argument, SDK helper, and direct API paths must not drift.
- **Credential And Modal Lifecycle.** If the diff changes one-time credentials, API key rotation, setup prompts, or modal actions: confirm plaintext credential state clears on close, in-flight flags reset on reopen, stale generated snippets cannot reappear, and failed actions do not leave a stuck spinner.
- **Identifier Entropy.** If the diff adds or changes a displayed key prefix, setup token prefix, invoice number, nonce, or visual identifier: confirm the displayed prefix has enough entropy for the population it identifies and has collision or duplicate handling where needed.
- **Credential Setup Copy.** If the diff changes setup copy, credential handoffs, signing-key guidance, or done-step instructions: confirm the copy is consistent across surfaces, leads with the user-facing safety property, and does not imply API credentials or Haven backend custody can spend.
- **Browser Or Headless Verification.** If browser verification is skipped for UI or routing changes: name the reason and add a headless equivalent that covers the skipped risk.

Run the matching items before invoking `haven-reviewer` so the reviewer finds fewer issues. If the reviewer surfaces a new trap family, add it to `docs/ai-review-patterns.md`, this preflight, and the reviewer agent's recurring-traps list together — the three should stay in sync.

If browser verification is skipped (preview environment unavailable, slow, flaky), pair the skipped visual check with at least one **headless equivalent** in vitest:

- Animation/style bugs: render assertion that the expected `className` is stable across state transitions.
- Cross-surface display drift: assertion that the same formatter is imported and produces the same output for the fixture.
- Loading-state flashes: assertion that the gated component does not render while any prerequisite hook is loading.

## Task Prompt Shape

When the user is planning work, help turn the request into this shape before implementation:

```text
Goal:
[What outcome should exist when this is done.]

Scope:
[What should be included.]

Out of scope:
[What should not be changed, even if nearby.]

PR shape:
[One PR / two PRs / roadmap first / follow-up PRs.]

Risk:
[Docs only / UI polish / shared behavior / money movement / agent authority / SDK or API contract.]

Workflow:
Use the Haven agent workflow. The captain owns product judgment, shared files, final integration, and merge-readiness judgment. Use subagents if they materially improve discovery, bounded implementation, or review.

Definition of done:
- PR opened
- relevant checks run
- review/risk summary included
- merge-readiness report included
```

Use this prompt shape especially when work could sprawl, when the user asks for a plan, or when multiple small PRs would be better than one broad branch.

## PR Closeout Contract

Every non-trivial PR should end with a concise closeout:

- changed files or surfaces
- workflow used, including agents used or skipped with reason
- checks run
- what was intentionally left out
- review status
- merge-readiness report

Use this merge-readiness format:

```text
Merge readiness:
- CI: passing / failing / pending
- Local checks: ...
- Review status: self-reviewed / reviewer-agent-reviewed / external reviewed / not reviewed
- Risk level: low / medium / high
- Why safe to merge: ...
- Residual risk: ...
- Recommended merge order: ...
```

When the user asks "is this safe to merge?", answer in this format. Do not treat green CI as the whole review for money movement, agent authority, generated credential artifacts, SDK payment APIs, x402/MPP, or shared contracts.

## Common PR Patterns

For broad cleanup or quality waves, prefer one or two focused PRs and then stop. If larger refactors remain, name them as a separate project rather than letting the cleanup wave expand.

For generated artifacts, pair implementation changes with output review. If SDK/API behavior, credential semantics, x402/MPP behavior, or product language changes, check generated credential files, `.env` examples, SDK snippets, demo scripts, and skill bundles.

## How To Create Or Invoke Agents

In Claude Code, project agents live in `.claude/agents/`. Restart Claude Code after adding or editing these files, or use `/agents` to manage them interactively. Invoke one explicitly with prompts like `Use the haven-explorer agent...`.

The `color:` fields in `.claude/agents/` are cosmetic Claude Code metadata. Codex and other tools can ignore them.

In Codex, keep the same mental model even when agents are not stored as `.claude/agents` files. Ask the main session to spawn a read-only explorer, a bounded worker, or a reviewer, and include the same ownership contract in the prompt.

Example:

```text
Use a read-only explorer agent to map the files and risks for [feature]. Then keep the main session as captain for the implementation plan and shared-file edits.
```

## Agents

### `haven-workflow-coordinator`

Use before any other agent at the start of non-trivial feature, UX iteration, or bug-fix work to choose the workflow, agent plan, file ownership boundaries, and expected checks.

Example:

```text
Use the haven-workflow-coordinator agent to choose the best agent plan for this feature. Return the work that should stay with the captain, proposed worker ownership boundaries, gravity files to avoid in parallel, expected checks, and risks.
```

### `haven-explorer`

Use for read-only mapping before a change.

Example:

```text
Use the haven-explorer agent to inspect the current agent budget UI and API flow. Do not edit files. Return relevant files, reusable components, test commands, and risks.
```

### `haven-ui-worker`

Use for one bounded frontend slice after assigning files.

Example:

```text
Use the haven-ui-worker agent to implement the empty and loading states for the agent budget panel.

Ownership:
- packages/frontend/src/components/haven/AgentBudgetPanel.tsx
- packages/frontend/src/components/haven/AgentBudgetPanel.test.tsx

Create new files only if they are listed above. Do not edit globals.css, Tailwind config, package files, shared UI primitives, or route shells. Report any shared change you need.
```

### `haven-backend-worker`

Use for one bounded backend, SDK, API, policy, or test slice.

Example:

```text
Use the haven-backend-worker agent to add validation for over-allowance payment requests.

Ownership:
- packages/backend/src/payments/paymentPolicy.ts
- packages/backend/src/payments/paymentPolicy.test.ts

Create new files only if they are listed above. Do not edit package files, lockfiles, or central shared types. Report any shared change you need.
```

### `haven-reviewer`

Use after implementation.

Example:

```text
Use the haven-reviewer agent to review the current diff for Haven product, UX, security, regression, and test risks. Findings first with file and line references.
```

## Default Feature Loop

1. Start from a clean branch.
2. Use `haven-workflow-coordinator` for non-trivial work to choose the agent plan and ownership boundaries. This is a default workflow decision, not something that depends on the user explicitly asking for parallel agents.
3. Use `haven-explorer` for terrain mapping unless the change is trivial.
4. Have the captain make or approve the implementation plan.
5. Use at most one or two workers in parallel, only with disjoint ownership.
6. Keep shared files with the captain.
7. Integrate after each meaningful slice.
8. Run relevant build or test checks.
9. Run the **Captain Self-Check Preflight** above for the surfaces the diff touches. Pair any skipped browser verification with a headless equivalent vitest.
10. Ask `haven-reviewer` for a final diff review when the change touches user-facing UX, money movement, agent authority, shared behavior, SDK/API contracts, generated artifacts, or meaningful risk.
11. Let the captain fix final issues, commit, push, and open the PR.
12. Add the PR closeout contract and merge-readiness report before calling the work complete.
13. If external review finds a relevant issue that gets fixed, update the reusable review pattern memory when the issue is likely to recur. Keep `docs/ai-review-patterns.md`, the Captain Self-Check Preflight, and the reviewer agent's recurring-traps list in sync.

## Files The Captain Should Usually Own

Avoid parallel edits to:

- `package.json`
- lockfiles
- `packages/frontend/src/app/globals.css`
- `packages/frontend/tailwind.config.js`
- shared UI primitives
- route and layout shells
- generated files
- central API clients or central shared types

If a worker needs one of these, it should report the need and let the captain make the change.

## Worktree Guidance

For a single Haven feature, prefer one branch and one captain session. Subagents should usually work inside that branch with narrow file ownership.

Use separate worktrees only when work can ship independently:

- two unrelated feature branches
- a spike that might be thrown away
- a risky refactor separate from product work
- long-running CI/debug work while product implementation continues

Avoid worktrees for multiple agents editing the same feature surface. That usually delays conflicts instead of removing them.

## Common Captain Instructions

Paste this after any task-specific template below, or tell the agent to use `docs/ai-agent-workflow.md` when working inside this repo.

```text
Use the defined Haven agents to deliver this in the best way.

You are the captain. Own product judgment, implementation strategy, shared files, gravity files, git hygiene, final integration, and verification.

Follow the Haven agent workflow:

1. If the work is trivial, keep it in the captain session and explain why.
2. For non-trivial work, use haven-workflow-coordinator before any other agent to choose the agent plan, ownership boundaries, and expected checks. Do this by default; do not wait for the user to explicitly request agents or parallel workers.
3. Use haven-explorer for read-only discovery before implementation unless the change is trivial.
4. Decide whether this should stay in the captain session or be split across subagents.
5. If using workers, define explicit file ownership before they edit anything.
6. Use workers only for clean, disjoint implementation slices.
7. Workers may create new files only when those files are explicitly listed in their ownership scope.
8. Keep shared files in the captain session unless there is a strong reason not to.
9. Do not allow multiple agents to edit the same file or edit gravity files in parallel.
10. Ask workers to report needed shared changes instead of making them.
11. Integrate each slice before starting broad follow-up work.
12. Run relevant tests, type checks, builds, or browser checks when practical.
13. Use haven-reviewer for a final diff review when the change touches user-facing UX, money movement, agent authority, shared behavior, SDK/API contracts, generated artifacts, or meaningful risk.

Gravity files the captain should usually own:
- package files
- lockfiles
- global styles
- Tailwind config
- shared UI primitives
- route and layout shells
- generated files
- central API clients
- central shared types

For UI work, enforce the Haven UI instructions from AGENTS.md:
- read the required UX and design docs
- inspect `/design-system` if it exists
- reuse existing primitives and Haven-domain components
- do not invent new card styles, spacing systems, shadows, radius, or typography unless necessary
- include empty, loading, error, and success states when applicable
- make money movement and agent authority clear
- use Haven product language
- hide technical wallet details from primary UX unless the surface is explicitly advanced or developer-facing
- review copy against the UX copy guidelines
- check mobile and desktop layouts when practical
- use `docs/ai-review-patterns.md` for known reviewer traps before final review
- use `docs/regulatory/casp-risk-guardrails.md` for payment, Safe, relayer, SDK payment API, x402/MPP, merchant, fiat/card, swap, yield, or advice work

Before implementation, briefly tell me:
- which agents you will use, if any
- which work stays with the captain
- any worker file ownership boundaries
- what checks you expect to run
- whether browser verification, headless verification, generated artifacts, or CASP/MiCA guardrails apply

Then proceed with the work unless you find a real blocker. This update is informational, not a request for permission to use the agentic workflow.

Before calling the PR ready, include:
- changed surfaces
- workflow used, including agents used or skipped with reason
- checks run
- browser verification or headless equivalent
- generated artifact and credential handoff impact
- CASP/MiCA guardrail status when relevant
- what was intentionally left out
- review status
- merge-readiness report with risk level, residual risk, and recommended merge order if multiple PRs are open
```

## Feature Delivery Prompt Template

Use this when you want the main session to act as captain and choose the right agents without you manually assigning them.

```text
Here is a new feature I want to build:

[Describe the feature, user problem, desired behavior, and any constraints.]

[Paste the Common Captain Instructions here, or say: Use docs/ai-agent-workflow.md and follow the Common Captain Instructions.]
```

## UX Feedback Iteration Prompt Template

Use this when you have feedback from yourself, users, design review, demos, screenshots, recordings, or product critique, and you want the main session to improve an existing flow.

```text
I want to improve the UX of this Haven flow:

[Name the flow, screen, route, or user journey.]

Here is the feedback/input:

[Paste feedback, notes, user quotes, screenshots, review comments, demo observations, or your own critique.]

Desired outcome:

[Describe what should feel clearer, faster, calmer, more trustworthy, more fintech-grade, or easier to complete.]

For the UX synthesis, tell me briefly:
- what feedback themes you found
- what product problems you think they reveal
- what you will change now
- what you are intentionally leaving out

Evaluate the changed flow against these questions:
- Is the user's next action obvious?
- Is the screen calm and scannable?
- Is money movement or agent authority clear?
- Is the risk/approval state honest without being alarming?
- Can the user pause, revoke, reject, stop, or recover where relevant?
- Does the copy use user-facing Haven language?
- Does the layout hold up on mobile and desktop?
- Are loading, empty, error, and success states handled?

[Paste the Common Captain Instructions here, or say: Use docs/ai-agent-workflow.md and follow the Common Captain Instructions.]
```

## Bug Fix Prompt Template

Use this when you have a bug report, failed test, console error, production issue, QA note, screenshot, or user-reported broken behavior, and you want the main session to analyze and fix it.

```text
I want to fix this Haven bug:

[Describe the broken behavior.]

Bug report / evidence:

[Paste user report, steps to reproduce, expected vs actual behavior, screenshots, logs, console errors, stack traces, failing test output, affected route, browser/device, account state, or environment.]

Desired outcome:

[Describe the correct behavior and any constraints, such as preserving existing UX/API behavior, avoiding schema changes, or keeping the fix small.]

For the bug triage, tell me briefly:
- what appears broken
- how you will reproduce or verify it
- likely root cause area
- expected checks

While fixing:
- prefer the smallest change that addresses the root cause
- avoid broad refactors unless the bug requires one
- preserve existing product language and design system patterns
- do not mask errors silently
- keep structured API errors where relevant
- never expose technical wallet details in primary UX unless the surface is explicitly advanced, account detail, transaction detail, or developer-facing

Before calling the work complete, report:
- root cause
- fix summary
- files changed
- verification run
- any residual risk or follow-up worth tracking

[Paste the Common Captain Instructions here, or say: Use docs/ai-agent-workflow.md and follow the Common Captain Instructions.]
```

## Good Worker Contract

```text
You own only:
- [file]
- [file]

You may create new files only if they are listed above.

Do not edit:
- package files
- lockfiles
- global styles
- Tailwind config
- shared UI primitives
- route shells
- files owned by another worker

Do not run git mutation commands. The captain owns branch, commit, push, and PR work.

If you need a shared change, report it instead of making it.
```
