# Haven Code Quality Loop

Last updated: 2026-06-05

## Current Run

- Branch: `codex/quality-agent-budget-policy-consistency`
- PR target: prevent list-level agent budget edit/revoke actions from using the currently selected Haven wallet for agents that belong to a different wallet, and make agent detail use stored wallet chain identity when auth state is missing that wallet.
- Why this target: it is the narrowest high-value P0 found in the agent budget/policy audit. `AgentPanel` renders agents across wallets while reading Safe details, signer state, and on-chain allowances from the active wallet. Without a guard, inline edit/revoke controls could prepare an agent budget update or revoke against the wrong Safe/chain. This PR keeps pause/resume available, moves off-wallet budget/revoke management to the agent detail page, and makes the detail page fall back to the agent row's stored `safe_address + safe_chain_id`. It does not change custody, Safe ownership, signer authority, payment execution, backend payment policy, database schema, production chain/token config, protocol behavior, SDK shape, or API authority.
- Files touched: `packages/frontend/src/components/AgentPanel.tsx`, `packages/frontend/src/components/__tests__/AgentPanel.test.tsx`, `packages/frontend/src/app/(authenticated)/agents/[agentId]/AgentDetailClient.tsx`, `packages/frontend/src/app/(authenticated)/agents/[agentId]/__tests__/AgentDetailClient.test.tsx`, and this loop file.

## Priority Backlog

- P0: Agent payment flow state hardening, especially x402/MPP idempotency, retry, approval-resume, and terminal-state behavior.
- P0: Agent credential handoff safety, including local credential file validation and secret redaction in generated artifacts, logs, errors, and tests.
- P0: Wallet/account setup readiness checks, including network, Safe deployment, funding, and chain/token mismatch handling.
- P0: Agent budget and policy flow consistency across allowance creation, remaining budget display, pause/revoke, and on-chain/account state.
- P1: Backend/API validation, error responses, logging safety, and shared response type coverage.
- P1: Test infrastructure reliability, especially avoiding hidden clean-build races and making local gates match CI.

## Completed Areas

- PR #258: machine-payment one-shot signature recording no longer sets `submitted` before RPC execution; regression coverage asserts pre-RPC SQL/call order and records `submitted_at` only when a tx hash exists.
- PR #259: x402 amount validation rejects hex, scientific notation, signed, negative, zero, blank, and whitespace-wrapped atomic values before payment work begins.
- PR #260: MPP demo challenge validation rejects invalid `expiresAt` timestamps before authorization, allowance, hash, or execution helpers run.
- PR #261: MCP split credential loading rejects mismatched `agent_id`, `safe_address`, `delegate_address`, `chain_id`, and `network` metadata before returning a merged credential.
- PR #262: signer credential loading accepts only positive integer `chain_id` / `HAVEN_CHAIN_ID` values and rejects malformed present values without leaking delegate key material.
- PR #263: env-based SDK/Python runtime examples reference `HAVEN_API_KEY` / `HAVEN_DELEGATE_KEY` but no longer echo raw credential values in comments.
- PR #264: generated handoff and skill-bundle tests assert reusable examples, skill descriptors, package metadata, and zip paths remain free of raw credential values.
- PR #265: chain-scoped Safe details and connected setup approval readiness prevent stale selected-wallet state or late Safe-detail responses from driving wallet approval and other money/authority readiness paths.
- PR #266: chain-scoped balance and portfolio reads prevent duplicate-address Safes and overlapping token symbols from driving wrong funding readiness or account totals.
- PR #267: chain-scoped transaction/activity reads prevent duplicate-address Safes from fetching, deduping, previewing, or labeling activity against the wrong chain.
- PR #268: x402/payment-history enrichment resolves and applies agent/payment labels by Safe and chain identity instead of transaction hash alone.
- PR #269: temporary frontend x402 bridge was retired, and agent activity feeds publish stored payment/approval Safe identity instead of an agent's current Safe.
- Planned current PR: list-level agent budget edit/revoke actions are active-wallet scoped, and agent detail uses stored wallet chain identity when auth state is missing that wallet.
- Prior roadmap exists at `docs/plans/code-quality-roadmap.md`; use this file as the running handoff for the small-PR quality loop going forward.

## Deferred Items

- x402/generic machine-payment consolidation: defer because it crosses idempotency, approval-state, expected-context binding, and multi-entrypoint behavior.
- Broader payment state rewrite, DB migrations, custody/signing semantics, Safe ownership assumptions, production chain/token config, and protocol compatibility changes need separate review.
- Broader x402/payment-history consolidation remains deferred.
- Backend allowance input normalization and terminal-state mutation guards remain a good follow-up, but this PR stays focused on frontend wallet-context authority actions.

## Known Baseline Notes

- Focused checks after implementation:
  - `npm run test -w packages/frontend -- AgentPanel.test.tsx AgentDetailClient.test.tsx EditAgentModal.test.tsx` passed.
- Full local gates after implementation:
  - `npm run test -w packages/frontend` passed with the known `useAgentLastSeen.test.ts` React `act(...)` warning.
  - `npm run typecheck -w packages/frontend` passed.
  - `npm run build -w packages/frontend` passed with existing optional wallet dependency warnings from MetaMask/WalletConnect packages.
  - `npm run test -w packages/backend -- agents.test.ts machine-payments.test.ts x402.test.ts` passed.
  - `git diff --check` passed.
- Explorer agent pass recommended the current smallest PR: block inline budget edit/revoke for off-active-wallet agents in `AgentPanel`, and make agent detail use stored `safe_chain_id` when `user.safes` is missing the wallet.
- Captain self-check covered CASP guardrails, active-wallet action gating, async hook keying, cross-surface budget display drift, UI copy, secret leakage, and test sufficiency; browser verification is covered by focused headless vitest regressions for the changed action and chain-fallback states.
- Reviewer agent found no blocking issue and flagged one `safe_id: null` future-shape edge case; the active-wallet predicate now falls back to stored Safe address plus chain before allowing inline budget/revoke actions.
- Do not run package tests/typecheck/build in parallel when they trigger `npm --prefix ../sdk run build`; the SDK clean build can race on `packages/sdk/dist`.
- Existing untracked directory `docs/plans/haven-landing-audit-2026-06-04/` was present before this run and is unrelated.

## Recommended Next Target

After this PR merges, choose a narrow backend validation target for owner-side agent allowance mirror writes: normalize `token_address`, `token_symbol`, `allowance_amount`, and `reset_period_min`; reject impossible AllowanceModule values such as zero, scientific/hex/signed amounts, uint96 overflow, and uint16 reset overflow; and block budget mirror mutations for revoked/pending agents. Keep it validation-only and defer broader payment-state rewrites.
