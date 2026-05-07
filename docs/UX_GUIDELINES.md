# Haven UX Guidelines

This is the durable product UX entrypoint for Haven. Read it together with the current design-system and copy docs:

- Visual system: [DESIGN_SYSTEM.md](./design_system/DESIGN_SYSTEM.md)
- UX copy: [UX_COPY_GUIDELINES.md](./design_system/UX_COPY_GUIDELINES.md)
- Redesign implementation history: [REDESIGN_HANDOFF.md](./design_system/REDESIGN_HANDOFF.md)

When these docs overlap, use this order of authority:

1. `UX_COPY_GUIDELINES.md` for user-facing wording and terminology.
2. `DESIGN_SYSTEM.md` for visual tokens, components, layout, and interaction styling.
3. This file for product doctrine, IA, accessibility, and money-movement UX rules.

The old dark app system is retired. Do not extend old dark token patterns, gradient buttons, glow shadows, or dark modal surfaces unless a future design-system doc explicitly reintroduces them.

---

## 1. Product Doctrine

Haven is a fintech product for agent payments. Every UX decision should reinforce three truths:

1. **The user stays in control.** Haven helps users approve and automate payments within rules; it must not imply Haven can move money on its own.
2. **Agents are constrained actors.** Agents have budgets, rules, and credentials. They are not wallets and should not be described as having unrestricted access.
3. **Trust is built in small moments.** Loading states, empty states, review screens, and errors should be calm, specific, and useful.

Use technical infrastructure terms only when they add transparency for a technical or advanced context. Product surfaces should lead with what the user understands and controls.

---

## 2. Language

The source of truth for copy is [UX_COPY_GUIDELINES.md](./design_system/UX_COPY_GUIDELINES.md). Keep these high-level rules in mind:

| Prefer | Avoid in product UI |
|---|---|
| Haven account, account | Safe, smart account, smart wallet |
| Haven wallet | deployed Safe, smart contract wallet |
| Sign in, approve actions | signer, owner type |
| Agent rules, agent budgets | policy engine, spending policy |
| Credential | generate credentials, hand/drop credential |
| Network | chain, blockchain |

Exceptions are allowed in advanced disclosures, protocol pages, developer docs, and block-explorer/Safe transaction links where the technical name is the point.

Voice rules:

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
- Every "View all" must resolve to a real page and preserve useful filters in the URL.
- Empty states need a clear next action.
- Reused concepts should share components. Transaction lists, action buttons, modals, and empty states should not fork visually without a reason.

---

## 4. Visual System

Use [DESIGN_SYSTEM.md](./design_system/DESIGN_SYSTEM.md) for exact tokens and classes.

Core rules:

- Page backgrounds use the v2 light system.
- Primary buttons use solid brand color: `bg-[var(--v2-brand)]` with `hover:bg-[var(--v2-brand-strong)]`.
- No gradient buttons. The brand gradient is reserved for a single hero accent phrase.
- Cards are white with `border-[var(--v2-border)]`, v2 radius, and the v2 card shadow.
- Modals use white surfaces and a darkened blurred backdrop.
- Avoid old dark app classes for new work: `bg-gray-*`, `text-gray-*`, dark-only `zinc` surfaces, glow shadows, and white alpha borders.
- Use semantic colors only for their meaning: success, warning, danger.

Before shipping a UI change, compare it against an existing v2 screen with the same density and intent.

---

## 5. Component Patterns

### Buttons

- Primary: solid brand, white text, v2 button shadow.
- Secondary/ghost: white background, subtle border, dark text.
- Destructive: danger color and explicit verb label.
- Loading buttons keep their dimensions and clearly indicate work is in progress.

### Cards And Rows

- Cards should not be nested inside other cards unless there is a clear tool or modal boundary.
- Clickable rows should be links when they navigate.
- Hover feedback should be subtle but visible on cards and rows that can be clicked.
- Data-dense cards should use compact headings and avoid hero-scale type.

### Modals

- Modal body should fit within the viewport and scroll internally when needed.
- Close affordances: close button, Escape, and backdrop click unless an irreversible signing/execution step is running.
- Backdrop should blur and slightly darken the page so the modal stands out on white surfaces.
- Never nest modals. Use inline confirmation panels or close the parent before opening a confirm dialog.

### Forms

- Every input has a visible label.
- Validation messages sit close to the field and tell the user how to recover.
- Amounts use tabular numerals and include the token symbol.
- Address fields accept valid `0x` addresses and should trim pasted whitespace.
- Review screens must summarize what will happen before money moves.

---

## 6. Money Movement

Every payment or account-changing action needs a review moment that answers:

- What amount or rule is changing?
- Which account is involved?
- Which network is involved?
- Who or what receives the payment?
- Who approves or signs?
- What happens next if more approvals are needed?

Rules:

- Never imply Haven has custody.
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
- Respect `prefers-reduced-motion` for decorative animation.

---

## 8. Responsive Rules

- Mobile uses one column.
- Tablet can use two columns where content density allows.
- Desktop should preserve readable max widths; do not stretch cards beyond useful scan width.
- Touch targets should be at least 44px on mobile.
- Tables may scroll horizontally; ordinary page layouts should not.
- Text must not overlap controls or overflow buttons.

---

## 9. Closeout Checklist

Use this checklist before calling a redesign slice done:

- `rg -n "from-indigo-500 to-violet-600|bg-gradient-to-r from-indigo|bg-gray-|text-gray-|dark:" packages/frontend/src`
- `rg -i "policy engine|safe deployed|relayer|generate credentials|hand the credential|drop the credential" packages/frontend/src/app packages/frontend/src/components`
- Check primary authenticated routes: Dashboard, Transactions, Agents, Agent detail, Accounts, Account detail, Approvals, Contacts, Settings.
- Check unauthenticated routes: Home, How it works, Protocols, Login, Signup, Onboarding.
- Run frontend tests and production build.
- Open at least one mobile-width and one desktop-width viewport for any route with layout changes.
