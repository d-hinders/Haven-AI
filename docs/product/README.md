---
owner: "@d-hinders"
status: current
covers:
  - AGENTS.md
  - docs/product/copy-guidelines.md
  - docs/product/design-system.md
  - docs/product/screen-recipes.md
  - docs/product/design-review.md
  - docs/regulatory/casp-risk-guardrails.md
  - packages/frontend/src/app/globals.css
  - packages/frontend/tailwind.config.js
  - packages/frontend/src/app/**
  - packages/frontend/src/components/**
  - packages/frontend/src/hooks/useEscapeToClose.ts
last-verified: "2026-06-29"
---

# Haven Product & UX Guide

This is the durable product UX entrypoint for Haven and the index for the `docs/product/` folder. Read it together with the current design-system and copy docs:

- Visual system: [design-system.md](./design-system.md)
- UX copy: [copy-guidelines.md](./copy-guidelines.md)
- Screen recipes: [screen-recipes.md](./screen-recipes.md)
- UI review checklist: [design-review.md](./design-review.md)
- Redesign implementation history (archived): [../archive/redesign-handoff.md](../archive/redesign-handoff.md)

When these docs overlap, use this order of authority:

1. `copy-guidelines.md` for user-facing wording and terminology.
2. `design-system.md` for visual tokens, components, layout, and interaction styling.
3. This file for product doctrine, IA, accessibility, and money-movement UX rules.
4. `screen-recipes.md` for repeatable product structures and `design-review.md` for closeout review.

The old dark app system is retired. Do not extend old dark token patterns, gradient buttons, glow shadows, or dark modal surfaces unless a future design-system doc explicitly reintroduces them.

---

## 1. Product Doctrine

Haven is a fintech product for agent payments. Every UX decision should reinforce three truths:

1. **The user stays in control.** Haven helps users approve and automate payments within rules; it must not imply Haven can move money on its own.
2. **Agents receive narrow authority, not unrestricted wallet access.** Haven-supported Safe funding follows explicit agent rules. An agent-held signing key may also control a temporary, pre-existing, or residual agent-wallet balance, so recovery and sweep controls must remain clear.
3. **Trust is built in small moments.** Loading states, empty states, review screens, and errors should be calm, specific, and useful.

Use technical infrastructure terms only when they add transparency for a technical or advanced context. Product surfaces should lead with what the user understands and controls.

### First-Run Simplicity

Brand-new users should not see the full operational dashboard until it helps
them. A first-run state should lead with one balance or account status, one
active setup action, and only the context needed to take that action. A compact
setup sequence is acceptable when exactly one step has a CTA. Other steps may
show their independently computed status but remain non-actionable until their
prerequisites make them current.

Avoid showing competing analytics cards, empty management panels, transaction
previews, multiple simultaneous CTAs, account/network summaries, or risk
explainers all at once just because those components exist. Add detail
progressively inside the relevant action flow, detail page, modal, or after the
user dismisses setup.

---

## 2. Language

The single source of truth for terminology and user-facing wording is [copy-guidelines.md](./copy-guidelines.md) — read it start to finish before writing any product string. The full preferred/avoided term mapping lives there; it is intentionally **not** duplicated here so the two never drift.

High-level voice rules:

- Plain, direct, quiet.
- No exclamation marks or emoji in product UI.
- No disabled control should look enabled.
- "Coming soon" is acceptable when a feature is intentionally not live.
- Error copy should explain the next useful action, not expose raw system detail.

---

## 3. Information Architecture

- Collection routes are plural: `/accounts`, `/agents`, `/contacts`, `/transactions`.
- Detail routes use an id: `/accounts/[safeId]`, `/agents/[agentId]`.
- Legacy singular collection routes should redirect to the plural route.
- Navigation items are stable nouns. Actions such as Send, Receive, Add funds, and Approve live inside the relevant screen.
- Authenticated pages use the shared shell: sidebar navigation, TopBar breadcrumbs/back links on detail routes, and a PageHeader in the page body.
- Every "View all" must resolve to a real page and preserve useful filters in the URL.
- Empty states need a clear next action.
- Reused concepts should share components. Transaction lists, action buttons, modals, and empty states should not fork visually without a reason.

---

## 4. Visual System

Use [design-system.md](./design-system.md) for exact tokens and classes.

Core rules:

- Page backgrounds use the v2 light system.
- Primary buttons use solid brand color: `bg-[var(--v2-brand)]` with `hover:bg-[var(--v2-brand-strong)]`.
- No gradient buttons. The brand gradient is reserved for the app wordmark and one restrained hero accent phrase.
- Flat cards are white with `border-[var(--v2-border)]`, v2 radius, and the v2 card shadow.
- Raised cards are prominent white page anchors such as the dashboard balance hero and account total balance.
- Other elevations already present in the shared `Card` primitive, including
  the restrained tinted `anchor` tier, must match the live `/design-system`
  reference and remain secondary to the page's primary anchor. The static
  `design-system.md` card table does not yet document `anchor`; treat that as
  documentation debt, not permission to invent another tier.
- Modals use white surfaces and a darkened blurred backdrop.
- Avoid old dark app classes for new work: `bg-gray-*`, `text-gray-*`, dark-only `zinc` surfaces, glow shadows, and white alpha borders.
- Use semantic colors only for their meaning: success, warning, danger.
- Use `.v2-tabular` on financial values, counters, percentages, addresses, and other numeric strings that need visual stability.

Before shipping a UI change, compare it against an existing v2 screen with the same density and intent.

---

## 5. Component Patterns

### Buttons

- Primary: solid brand, white text, v2 button shadow.
- Secondary/ghost: white background, subtle border, dark text.
- Destructive: danger color and explicit verb label.
- Loading buttons keep their dimensions and clearly indicate work is in progress.

### Page Headers

- Authenticated pages use `PageHeader`.
- One h1 per page. Use the PageHeader action slot for page-level CTAs.
- Detail pages rely on TopBar back links; do not duplicate a second large back affordance unless the workflow needs it.
- Do not use marketing hero type on dashboards, tables, settings, or operational views.

### Cards And Rows

- Cards should not be nested inside other cards unless there is a clear tool or modal boundary.
- Clickable rows should be links when they navigate.
- Hover feedback should be subtle but visible on cards and rows that can be clicked.
- Data-dense cards should use compact headings and avoid hero-scale type.

### Tables And Activity

- Full `/transactions` history uses the semantic full-page `TransactionsTable`.
- Sortable headers need `aria-sort` and clear labels.
- Amount sorting must use raw numeric values, not formatted strings.
- Account and agent detail pages may use the card/compact `TransactionsTable`
  variants for scoped, sortable histories.
- Short non-sortable previews such as Dashboard use `TransactionActivityRow`.
- Mobile table views should collapse secondary metadata while preserving the
  direction, activity/movement, amount, and external detail link. Date may move
  to a detail surface.

### Modals

- Modal body should fit within the viewport and scroll internally when needed.
- Close affordances: close button, Escape, and backdrop click unless an irreversible signing/execution step is running.
- Backdrop should blur and slightly darken the page so the modal stands out on white surfaces.
- Modals must use dialog semantics, labelled titles, focus trap, and focus return after close.
- Never nest modals. Use inline confirmation panels or close the parent before opening a confirm dialog.

### Forms

- Every input has a visible label.
- Validation messages sit close to the field and tell the user how to recover.
- Use the shared `Input` primitive for borders, focus rings, helper text, invalid states, and field-local actions.
- Use `MaxButton` and `PasteButton` for amount and address fields when those actions are available.
- Amounts use tabular numerals and include the token symbol.
- Address fields accept valid `0x` addresses and should trim pasted whitespace.
- Review screens must summarize what will happen before money moves.

### Loading And Feedback

- Use `Skeleton` instead of inline pulse divs.
- Loading regions that replace meaningful content should preserve approximate dimensions and use `role="status"`, `aria-busy="true"`, and `aria-live="polite"` where practical.
- Use toasts for short feedback after actions such as copy, save, send, or retry.
- Toasts should supplement visible state. If the user needs to fix something, keep the error next to the relevant field or panel.
- Tooltips can clarify truncated values or icon-only controls, but they must not contain essential instructions or money/risk information.

---

## 6. Money Movement

Every money-moving or agent-authority-changing action needs a review moment that
answers:

- Who can spend?
- What amount or rule is changing?
- Which Haven wallet and agent wallet, if any, are involved?
- Which network is involved?
- Who or what receives the payment?
- Who approves or signs?
- What happened already?
- What happens next if more approvals are needed?
- How can the user pause, revoke, reject, stop, recover, or sweep funds?

Rules:

- Never imply Haven has custody.
- Distinguish Safe funding constrained by on-chain agent rules from funds already
  controlled by an agent-held signing key.
- Always show network context in signing and transaction review surfaces.
- Results for on-chain actions include an externally verifiable link.
- High-risk or destructive actions require confirmation.
- Secrets shown once must say they cannot be shown again.
- If a wallet is required and not connected, disable the action and explain how to continue.
- Passkey-device limitations should be clear without sounding like a failure.

---

## 7. Accessibility

- All interactive elements are keyboard reachable.
- Use semantic HTML first: buttons for actions, links for navigation.
- Icon-only controls need `aria-label`.
- Focus-visible rings are required on focusable controls.
- Text contrast must meet WCAG AA.
- Escape closes modals and dropdowns unless an execution step intentionally blocks dismissal.
- Loading, saving, sending, and error statuses should be announced with appropriate live regions when practical.
- Toasts use live regions: polite for informational/success feedback, assertive for errors.
- Tooltips must be available on keyboard focus when they explain a focusable control or truncated value.
- Use `aria-busy` around loading regions that replace page content.
- Preserve the skip link to `main#main-content` in the authenticated shell.
- Respect `prefers-reduced-motion` for decorative animation.

---

## 8. Responsive Rules

- Mobile uses one column.
- Tablet can use two columns where content density allows.
- Desktop should preserve readable max widths; do not stretch cards beyond useful scan width.
- Primary and risk-bearing touch targets should be at least 44px on mobile.
  Visually compact controls need an expanded hit area and enough separation to
  remain reliable by touch.
- Tables may scroll horizontally; ordinary page layouts should not.
- Text must not overlap controls or overflow buttons.

---

## 9. Closeout Checklist

Use [design-review.md](./design-review.md) before calling any UI change done.
At minimum:

- `rg -n "from-indigo-500 to-violet-600|bg-gradient-to-r from-indigo|bg-gray-|text-gray-|dark:" packages/frontend/src`
- `rg -i "policy engine|safe deployed|relayer|allowance module|session key|owner type|generate credentials|hand the credential|drop the credential|Haven gave.*private key|Haven (signs|settles|signed)" packages/frontend/src/app packages/frontend/src/components`
- Inspect `/design-system` before changing shared UI patterns.
- Check every changed route plus every shared consumer of changed components;
  do not rely on a frozen route inventory.
- Run frontend tests and production build.
- Open at least one mobile-width and one desktop-width viewport for any route
  with layout changes. If browser verification is skipped, state why and add a
  named headless-equivalent test for the skipped risk.
- For transaction/history work, verify semantic table behavior, mobile collapse, sorting labels, and raw-value amount sorting.
- For modal or feedback work, verify focus trap, focus return, Escape behavior, toast placement, and inline error states.
- Run the matching Captain Self-Check Preflight items from
  `docs/contributing/ai-agent-workflow.md`.
- Review changed strings against `copy-guidelines.md`; apply CASP/MiCA guardrails
  to payment, authority, credential, x402/MPP, fiat, swap, yield, treasury, and
  reporting/accounting surfaces.
- Review generated credential and agent-handoff artifacts when relevant, then
  run `haven-reviewer` and report CI, local checks, review status, risk, and
  residual risk.
- Run `haven-doc-reviewer` when changed paths match any document's `covers:`
  mapping, and resolve stale claims before opening the PR.

Known implementation gap: the shared `Button` primitive's common small/default
sizes are 36px and 40px high. Until those controls or their hit areas are
updated, verify mobile placement and spacing explicitly; do not treat the
current dimensions as the target standard for primary or risk-bearing actions.
