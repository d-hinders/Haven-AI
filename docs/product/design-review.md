---
owner: "@d-hinders"
status: current
covers:
  - docs/product/README.md
  - docs/product/design-system.md
  - docs/product/copy-guidelines.md
  - docs/product/screen-recipes.md
  - docs/contributing/ai-agent-workflow.md
  - docs/regulatory/casp-risk-guardrails.md
  - packages/frontend/src/app/globals.css
  - packages/frontend/tailwind.config.js
  - packages/frontend/src/app/**
  - packages/frontend/src/components/**
last-verified: "2026-06-29"
---

# Haven AI UX Review

Use this checklist before finishing any Haven UI task. It is written for AI implementers and reviewers, so each item should be checked against the actual changed screen, not just the code diff.

## Product Clarity

- The screen has one obvious primary action.
- The user can tell what happens next.
- First-run or onboarding-adjacent screens show one active next action and the
  minimum context needed for it. A compact sequence may show later steps when
  they remain subordinate or locked; normal dashboard density, empty management
  panels, and competing CTAs stay hidden.
- Money-moving or authority-changing screens answer:
  - Who can spend?
  - From which Haven wallet?
  - How much?
  - On what or for whom?
  - When is approval required?
  - What happened already?
  - How can the user pause, revoke, reject, or stop it?
- Agent authority is described as constrained by `agent rules` or an `agent budget`.
- Haven never appears to have custody or unrestricted spending authority.
- Payment and authority copy follows `copy-guidelines.md`. It says whether a
  user-held or agent-held key signs, distinguishes API identity from payment
  authority, and never implies an API key or Haven backend can spend.
- Payment execution, agent authority, credentials, Safe setup, relaying, SDK
  payment APIs, x402/MPP, merchant, fiat/card, swap, yield, treasury,
  reporting/accounting, tax, and advice surfaces also pass
  `casp-risk-guardrails.md`.

## Visual System

- Existing primitives in `packages/frontend/src/components/ui` are reused before adding new styles.
- Haven-domain components in `packages/frontend/src/components/haven` are reused for agent budget, wallet identity, approvals, and risk explanations.
- Authenticated pages use `PageHeader` unless the route has a deliberate special layout.
- Dashboard compact previews use `TransactionActivityRow`. Semantic transaction
  lists, including card/compact account and agent histories, use the appropriate
  `TransactionsTable` variant.
- Cards, buttons, inputs, shadows, radii, and typography match `docs/product/design-system.md`.
- `Card elevation="raised"` is used only for prominent page-anchor surfaces, not ordinary cards.
- The shared `Card` primitive's implemented `anchor` elevation is used only as
  a restrained tinted secondary focal tier. The static `design-system.md` card
  table does not yet list this implemented tier; verify it against the live
  `/design-system` reference and do not invent additional elevations.
- Inputs use the shared `Input` primitive for visible borders, focus, validation, Max/Paste actions, and helper text.
- Skeleton loading uses `Skeleton` rather than inline pulse divs.
- Toast and Tooltip are used through shared primitives, not one-off floating elements.
- Amounts, addresses, percentages, counters, step numbers, and numeric metadata
  use `.v2-tabular`.
- No new gradient buttons, glow shadows, dark app surfaces, or one-off card styles were introduced.
- Dense app surfaces use compact headings and readable spacing, not marketing hero typography.
- No first-paint, staggered, or page-level decorative entrance motion was added.
  Allowed animation declarations/classes are gated by
  `prefers-reduced-motion: no-preference`.

## Copy And Terminology

- Primary product UI uses `Haven account`, `Haven wallet`, `agent rules`, `agent budget`, `connect your agent`, and `approve actions`.
- Technical terms are hidden unless the surface is advanced, account detail, transaction detail, or developer-facing.
- Error copy explains the next useful action.
- Empty states include a clear next step.
- Loading states preserve layout and do not look broken.
- Changed strings were read against `copy-guidelines.md`, not accepted merely
  because similar shipped copy exists.

Run these checks when relevant:

```sh
rg -i "policy engine|safe deployed|relayer|allowance module|session key|owner type|enroll signer|generate credentials|hand the credential|drop the credential|Haven gave.*private key|Haven (signs|settles|signed)" packages/frontend/src/app packages/frontend/src/components
rg -n "bg-gradient-to-r from-indigo|from-indigo-500 to-violet-600|bg-gray-|text-gray-|dark:" packages/frontend/src/app packages/frontend/src/components
```

Any remaining matches should be deliberate technical disclosure, developer copy, tests, or legacy content outside the touched surface.

## Responsive And States

- Mobile uses one column and does not hide the money/risk summary.
- Primary and risk-bearing mobile touch targets are at least 44px. Visually
  compact controls use an expanded hit area and adequate separation.
- Text does not overflow buttons, cards, rows, or modal panels.
- Empty, loading, error, success, and long-content states are handled when the screen can enter them.
- Modal and overlay flows support dialog semantics, labelled titles, focus trap, focus return, Escape, and focus-visible states unless an irreversible execution step intentionally blocks dismissal.
- Loading regions that replace meaningful content use `role="status"`, `aria-busy`, and `aria-live` when practical.
- Toasts supplement visible state and use the correct live-region tone.
- Tooltips are available on hover and focus, and do not hide essential instructions.
- Transaction tables preserve mobile readability and expose `aria-sort` on sortable headers.

## Final Verification

- Inspect `/design-system` when adding or changing shared UI patterns.
- Check at least one desktop and one mobile viewport for changed screens.
- Run relevant frontend tests or `npm run build -w packages/frontend` when practical.
- Run the matching Captain Self-Check Preflight items before final review.
- If browser verification is skipped, record why and name the headless-equivalent
  test that covers the skipped risk.
- Review generated credential and handoff artifacts and CASP/MiCA status when
  the changed surface affects them.
- Run `haven-reviewer` for user-facing, money, authority, shared-behavior, or
  meaningful-risk changes.
- Run `haven-doc-reviewer` when changed paths match document `covers:` mappings,
  and resolve stale claims before the PR.
- Report changed surfaces, workflow/agents used, CI, local checks, browser or
  headless verification, generated-artifact and CASP impact, intentionally
  excluded work, review status, risk level, merge rationale, residual risk, and
  recommended merge order when multiple PRs are open.
- For table changes, verify amount sorting uses raw values rather than formatted strings.
- For app-shell changes, verify sidebar active state, Approvals badge, TopBar
  back links, environment badge, network switcher, skip link, and mobile
  navigation.
- For animation/style changes, verify the class remains stable across state
  transitions and reduced-motion behavior is covered.
