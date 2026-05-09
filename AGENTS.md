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

## UI Closeout

Before completing UI work:

- Reuse shared primitives and Haven-domain components where possible.
- Check mobile and desktop layouts.
- Include empty, loading, error, and success states when the screen can enter them.
- Review copy against `docs/design_system/UX_COPY_GUIDELINES.md`.
- Review the changed UX against `docs/ux/haven-design-review.md`.
- Run relevant frontend tests or build checks when practical.
