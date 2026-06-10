# Haven Agentic Workflow Audit

Last updated: 2026-06-02

## Summary

Haven has a strong agentic delivery model: one captain session, read-only discovery, bounded workers, gravity-file ownership, risk-specific review, and explicit merge-readiness reporting. The model is good, but recent PRs show that too much still depends on manual memory.

This audit starts with docs, prompt, and PR-template quick wins only. It does not change runtime code, product UI, SDK APIs, database schema, or the Connect Agent 2 product implementation.

## Recent PR Lessons

- #221 exposed an entrypoint-parity gap: the x402 header path verified payment, but the MCP tool-handler path still looked only at tool arguments. Payment, MCP, SDK, and HTTP surfaces need shared verified state or parity tests whenever one entrypoint changes.
- #225 and #226 exposed credential modal lifecycle issues: one-time key state, in-flight rotation state, stale comments, and visual key-prefix entropy were not caught by the first feature pass.
- #227 used the right fallback pattern for skipped browser verification: focused headless Vitest coverage documented the populated and empty last-activity states when browser verification was skipped.
- #229 split Connect Agent 2 into architecture, backend pairing, local connector, runtime install, frontend flow, wallet activation, manual fallback, and rollout closeout. That product work should stay on the issue sequence rather than being folded into workflow cleanup.

## Current Strengths

- The captain/subagent split is clear: the captain owns product judgment, shared files, git, final integration, and PR readiness.
- Gravity files are named and protected from parallel worker edits.
- The reviewer prompt and Captain Self-Check Preflight already share core recurring traps.
- CI routes changed surfaces across frontend, backend, SDK, MCP, hosted MCP server, and signer packages.
- PR closeout guidance already asks for local checks, review status, risk level, residual risk, and merge order.

## Current Gaps

- Before this audit, there was no repository PR template, so merge-readiness fields were easy to omit.
- Workflow rules are duplicated across `AGENTS.md`, `docs/ai-agent-workflow.md`, and `.claude/agents/*`, which makes drift likely.
- Reviewer-agent usage is documented but not consistently forced in PR descriptions for UX, money movement, agent authority, SDK/API contracts, generated artifacts, or shared behavior.
- Review feedback does not have a strong enough capture loop. Durable lessons should be added to `docs/ai-review-patterns.md`, the Captain Self-Check Preflight, and `.claude/agents/haven-reviewer.md` together.
- The preflight did not explicitly name multi-entrypoint parity, one-time credential lifecycle, identifier entropy, credential setup copy, or skipped-browser/headless-equivalent checks.

## Quick Wins Implemented By This Track

- Add `.github/pull_request_template.md` so every PR starts with changed surfaces, workflow used, agents used or skipped, checks, browser/headless verification, generated-artifact impact, CASP/MiCA guardrail status, and merge readiness.
- Add the new recurring trap families to the review memory and mirror them in the captain preflight and reviewer prompt.
- Tighten workflow docs and agent prompts so non-trivial work starts with coordination, uses read-only discovery unless trivial, delegates only disjoint file ownership, and requires reviewer coverage for risk-bearing diffs.
- Keep Connect Agent 2 as product work tracked by #229 through #237.

## Connect Agent 2 Workflow Boundary

Use this sequence for the product-facing setup work:

1. #230: architecture, state machine, and custody contract.
2. #231 and #232: backend pending setup APIs and local connector CLI may proceed in parallel only after #230 defines interfaces.
3. #233 and #234: runtime install/probes and frontend setup flow may proceed after pairing/runtime contracts are stable.
4. #235 and #236: wallet approval/activation and manual fallback follow after the happy path is proven.
5. #237: end-to-end tests, docs, rollout gates, and risk closeout.

Do not invent Connect Agent 2 API shapes inside workflow cleanup PRs. Interface decisions belong in the architecture and implementation issues above.
