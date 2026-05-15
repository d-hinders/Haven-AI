# Haven Codex Instructions

## Product Context

Haven is an agentic stablecoin payment wallet. Users create or link a Haven account, add funds, and give AI agents constrained spending ability through agent rules and budgets. Product UX must feel like modern fintech: calm, clear, and honest about spending control.

## Required Reading For UI Work

Before changing product UI, read these sources in order:

1. `docs/UX_GUIDELINES.md` for product doctrine, IA, money movement, accessibility, and closeout checks.
2. `docs/design_system/DESIGN_SYSTEM.md` for tokens, typography, cards, buttons, motion, and visual constraints.
3. `docs/design_system/UX_COPY_GUIDELINES.md` for user-facing wording and banned technical language.
4. `docs/ux/haven-screen-recipes.md` for repeatable screen structures.
5. `docs/ux/haven-design-review.md` before finishing UI work.

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

## UI Closeout

Before completing UI work:

- Reuse shared primitives and Haven-domain components where possible.
- Check mobile and desktop layouts.
- Include empty, loading, error, and success states when the screen can enter them.
- Review copy against `docs/design_system/UX_COPY_GUIDELINES.md`.
- Review the changed UX against `docs/ux/haven-design-review.md`.
- Run relevant frontend tests or build checks when practical.

## Agentic Workflow

When a user asks to build a feature, improve a UX flow from feedback, or fix a bug from a report, use `docs/ai-agent-workflow.md`.

Agentic delivery is the default decision path for non-trivial Haven work. The user does not need to explicitly ask to "use agents", "use workers", or "use parallel agents" on each request. Act as the captain, decide whether the agentic flow is useful from the task shape and risk, and proceed with it when it is the better workflow:

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
