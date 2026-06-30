---
owner: "@d-hinders"
status: current
covers:
  - .github/workflows/publish.yml
  - scripts/release-bump.mjs
  - .agents/skills/**
  - .claude/agents/**
  - .claude/commands/**
last-verified: "2026-06-30"
---

# Haven Codex Instructions

## Product Context

Haven is an agentic stablecoin payment wallet. Users create or link a Haven account, add funds, and give AI agents constrained spending ability through agent rules and budgets. Product UX must feel like modern fintech: calm, clear, and honest about spending control.

## Required Reading For UI Work

Before changing product UI, read these sources in order:

1. `docs/product/README.md` for product doctrine, IA, money movement, accessibility, and closeout checks.
2. `docs/product/design-system.md` for tokens, typography, cards, buttons, motion, and visual constraints.
3. `docs/product/copy-guidelines.md` for user-facing wording and banned technical language.
4. `docs/product/screen-recipes.md` for repeatable screen structures.
5. `docs/product/design-review.md` before finishing UI work.

If `/design-system` exists, inspect it before editing UX and reuse the visual language shown there.

## UI Implementation Rules

- Inspect existing primitives in `packages/frontend/src/components/ui` and Haven-domain components in `packages/frontend/src/components/haven` before creating new UI.
- Prefer composition over new visual patterns. Do not invent new card styles, spacing systems, shadows, radius, or typography unless the existing system cannot express the need.
- Use the v2 tokens from `packages/frontend/src/app/globals.css` and Tailwind aliases from `packages/frontend/tailwind.config.js`.
- Do not install or introduce a second UI framework for ordinary product work.
- Keep domain components small and grounded in real Haven flows. Avoid building theoretical component inventory.
- Product UI should say `Haven account`, `Haven wallet`, `agent rules`, `agent budget`, `approve actions`, and `connect your agent`.
- Hide Safe, module, relayer, signer, owner, transaction hash, and raw address detail from primary UX unless the surface is explicitly advanced, account detail, transaction detail, or developer-facing.

## Money And Risk Clarity

Every screen that moves money or changes agent authority must make these clear:

- Who can spend?
- From which Haven wallet?
- How much?
- On what or for whom?
- When is approval required?
- What happened already?
- How can the user pause, revoke, reject, or stop it?

## CASP / MiCA Guardrails

Before changing payment execution, agent authority, Safe setup, relaying, SDK payment APIs, x402/MPP flows, merchant-facing demos, fiat/card surfaces, swaps, yield, or treasury features, read `docs/regulatory/casp-risk-guardrails.md`.

Hard product and architecture rule: Haven is non-custodial smart account software. Haven must not hold user or agent private keys, make API credentials sufficient to spend, rely on off-chain policy as the real spend control, alter signed payment intent, operate swaps/ramps/fiat/card/merchant settlement/yield/advice flows without review, or prevent users from accessing and revoking Safe permissions outside Haven.

Apply these guardrails to generated artifacts too: SDK examples, credential files, agent handoff docs, demo scripts, and skill bundles must not imply Haven holds funds, controls keys, transfers money on the user's behalf, or makes API credentials sufficient to spend.

## UI Closeout

Before completing UI work:

- Reuse shared primitives and Haven-domain components where possible.
- Check mobile and desktop layouts.
- Include empty, loading, error, and success states when the screen can enter them.
- Review copy against `docs/product/copy-guidelines.md`.
- Review the changed UX against `docs/product/design-review.md`.
- Run relevant frontend tests or build checks when practical.
- Run the **Captain Self-Check Preflight** in `docs/contributing/ai-agent-workflow.md` for the surfaces the diff touches (numeric formatters, counter/summary stats, conditional copy, animations, inline gates, cross-surface values, paginated-list-derived progress).
- If browser verification is skipped (preview environment unavailable, slow, flaky), add at least one **headless equivalent** in vitest:
  - Animation/style bugs: assert the expected `className` is stable across state transitions.
  - Cross-surface display drift: assert the same shared formatter is imported and produces the same output for the fixture.
  - Loading-state flashes: assert the gated component does not render while any prerequisite hook is loading.

## PR Closeout And Merge Readiness

When opening or reviewing a non-trivial PR, report merge readiness explicitly instead of relying on green CI alone:

- CI status
- local checks run
- review status, including whether a reviewer agent or external review covered the diff
- risk level: low, medium, or high
- why it is safe to merge
- residual risk or follow-up
- recommended merge order when multiple PRs are open

Green CI is necessary but not sufficient for changes that touch money movement, agent authority, generated credential artifacts, SDK payment APIs, x402/MPP flows, or shared contracts.

## Releasing npm Packages

`@haven_ai/sdk`, `signer`, `mcp`, and `connect` publish to npm automatically when a version bump lands on `main` (the **Publish packages** workflow). Never run `npm publish` by hand, and never hand-edit package versions or cross-package dep pins — run `npm run release:bump -- <version>`, which updates them atomically and verifies the connect bundle, then open a PR and merge. `mcp-server`/`backend`/`frontend` are not npm-published. Details: `scripts/README.md` and the README's "Releasing npm packages" section.

## Agentic Workflow

When a user asks to build a feature, improve a UX flow from feedback, or fix a bug from a report, use `docs/contributing/ai-agent-workflow.md`.

Portable Haven workflows live under `.agents/skills/`. Client-specific command and agent definitions are adapters to that canonical layer; do not duplicate workflow policy in an adapter.

Agentic delivery is the default decision path for non-trivial Haven work. This file is the user's standing instruction to use subagents, delegated workers, and parallel agent work whenever the captain decides that is the best workflow. The user does not need to explicitly ask to "use agents", "use workers", or "use parallel agents" on each request. Act as the captain, decide whether the agentic flow is useful from the task shape and risk, and proceed with it when it is the better workflow:

- Use the roles in `.agents/skills/haven-agent-workflow/` for coordination, exploration, bounded implementation, and review.
- Use `haven-workflow-coordinator` to choose the workflow, agent plan, file ownership boundaries, and expected checks when the work is non-trivial.
- Use `haven-explorer` for read-only discovery before implementation unless the change is trivial.
- Use `haven-ui-worker` and `haven-backend-worker` only for clean, bounded, disjoint implementation slices.
- Keep shared files, gravity files, git hygiene, final integration, and product judgment in the captain session.
- Use `haven-reviewer` for final product, UX, security, regression, and test review when the change touches user-facing UX, money movement, agent authority, shared behavior, or meaningful risk.
- Briefly tell the user which agents will be used and why, but do not ask for permission unless there is a real blocker, destructive action, credential risk, or tool limitation.

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
