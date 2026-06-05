# Haven Code Quality Loop

Last updated: 2026-06-05

## Current Run

- Branch: `codex/quality-wallet-readiness-validation`
- PR target: chain-scope Safe details and wallet approval readiness.
- Why this target: it is a narrow wallet/account readiness hardening item that uses known Haven wallet chain IDs for Safe details on money/authority surfaces and makes the connected setup's Haven wallet and network the source of truth for approval readiness, signer gating, public client selection, displayed wallet context, and approval submission. It does not change custody, Safe ownership, signer authority, payment execution, production chain/token config, or public SDK/API shape.
- Files touched: `packages/backend/src/routes/safe-details.ts`, `packages/backend/src/routes/__tests__/safe-details.test.ts`, `packages/frontend/src/hooks/useSafeDetails.ts`, `packages/frontend/src/hooks/__tests__/useSafeDetails.test.ts`, `packages/frontend/src/components/ConnectAgent2Modal.tsx`, `packages/frontend/src/components/__tests__/ConnectAgent2Modal.test.tsx`, `packages/frontend/src/components/CreateAgentModal.tsx`, `packages/frontend/src/components/DashboardSendModal.tsx`, `packages/frontend/src/components/ApprovalQueue.tsx`, `packages/frontend/src/components/AgentPanel.tsx`, `packages/frontend/src/app/(authenticated)/dashboard/DashboardClient.tsx`, `packages/frontend/src/app/(authenticated)/accounts/[safeId]/AccountDetailClient.tsx`, `packages/frontend/src/app/(authenticated)/agents/[agentId]/AgentDetailClient.tsx`, `.claude/agents/haven-reviewer.md`, `docs/ai-agent-workflow.md`, `docs/ai-review-patterns.md`, and this loop file.

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
- Planned current PR: chain-scoped Safe details and connected setup approval readiness prevent stale selected-wallet state or late Safe-detail responses from driving wallet approval and other money/authority readiness paths.
- Prior roadmap exists at `docs/plans/code-quality-roadmap.md`; use this file as the running handoff for the small-PR quality loop going forward.

## Deferred Items

- x402/generic machine-payment consolidation: defer because it crosses idempotency, approval-state, expected-context binding, and multi-entrypoint behavior.
- Broader payment state rewrite, DB migrations, custody/signing semantics, Safe ownership assumptions, production chain/token config, and protocol compatibility changes need separate review.

## Known Baseline Notes

- Baseline checks from this run before implementation:
  - `npm run test -w packages/frontend -- ConnectAgent2Modal.test.tsx` passed.
- Do not run package tests/typecheck/build in parallel when they trigger `npm --prefix ../sdk run build`; the SDK clean build can race on `packages/sdk/dist`.
- Existing untracked directory `docs/plans/haven-landing-audit-2026-06-04/` was present before this run and is unrelated.

## Recommended Next Target

After this PR merges, choose a narrow P0 chain-scoped balance/funding readiness target: backend `/balances/:safeAddress` and frontend balance aggregation currently key primarily by address/symbol, so same-address multi-chain wallets or overlapping token symbols can stale or collapse funding readiness. Keep it validation/test-focused; defer `/portfolio` and broader account detail consolidation unless a tiny shared helper is unavoidable.
