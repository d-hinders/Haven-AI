# Haven — UX Guidelines

Durable design rules for the Haven app. These are the *rules we've decided on*. New screens, components, and copy must follow them; deviations need an explicit reason recorded in the PR.

Companion doc: [`UX_AUDIT.md`](./UX_AUDIT.md) — the living backlog of places where the app currently diverges from these rules.

---

## 0. Product doctrine

Haven is a **money product for non-custodial smart accounts**. Every UX decision is subordinate to three product truths:

1. **Non-custodial is the feature.** Always reinforce "Haven never holds signing authority" in signing contexts. Never show copy that implies Haven moves funds on its own.
2. **Agents are constrained actors, not wallets.** UI for agents is a *policy* UI, not a wallet UI. Spending limits, recipients, expiries — those are the nouns.
3. **Trust is built in small moments.** Every error message, every loading state, every confirmation dialog either deposits or withdraws trust. Aim for deposits.

---

## 1. Language & terminology

One product vocabulary. Use these exact terms.

| Use | Not |
|---|---|
| **Account** (or **Haven account**) in user-facing UI | "Safe", "Safe smart account", "smart wallet" |
| **Safe smart account** in technical/advanced disclosure | ambiguous "Safe" |
| **Signing wallet** for the EOA connected via RainbowKit | "Wallet", "MetaMask", "connected wallet" |
| **Agent** | "Bot", "AI", "Service account" |
| **Policy** for agent limits / rules | "Permissions", "Rules", "Config" |
| **Approval queue** for human-in-the-loop payments | "Pending", "Inbox" |
| **Payment** for outbound transfers executed by Haven | "Transaction" (reserve for on-chain records) |
| **Network** for chain | "Chain", "Blockchain" — only in technical disclosure |

### Voice rules

- **Plain, direct, quiet.** No exclamation marks. No emoji in product UI. No "Let's…" / "Woohoo" / "Great!".
- **Sentences, not jargon.** "Transfer to agent. 50 USDC." not "Outgoing Internal Tx".
- **Error copy is the user's friend, not the system's.** Bad: `Error: 500`. Good: *"We couldn't reach the network. Try again in a moment."*
- **Never promise what we don't do.** If a feature is planned, label it **Coming soon** — not "Soon". Never show a disabled control that looks enabled.

### Capitalisation

- **Title Case** for navigation, page headings, section headings.
- **Sentence case** for subtitles, helper text, form labels, button copy over 2 words.
- Buttons ≤ 2 words: Title Case ("Send", "Add Account"). Buttons > 2 words: sentence case ("Create policy", "Deploy smart account").

---

## 2. Information architecture

- **Nav items are stable nouns.** Dashboard, Accounts, Agents, Contacts, Settings. Don't add verb-y items ("Send", "Approve") — those are actions on nouns.
- **One source of truth per concept.** Recent transactions live on Dashboard AND Account detail. They must render identically (same row component). When a new surface shows the same data, it uses the existing component or the component gets promoted to a shared primitive.
- **Dead ends are forbidden.** Every empty state has a primary action. Every error state has a retry. Every "View all" resolves to a real page.
- **Routes are plural for collections, singular-with-id for detail.** `/accounts` list; `/accounts/[safeId]` detail. Never ship singular-collection routes like `/account`.

---

## 3. Visual system

The canonical visual system lives in [`docs/design_system/DESIGN_SYSTEM_V2.md`](./design_system/DESIGN_SYSTEM_V2.md).
Use the tokens and component patterns defined there for new marketing work and for the ongoing app migration. Any old dark-app token references in this document are historical and should not be extended.

---

## 4. Component patterns

### 4.1 Cards & list rows

- Left-aligned label/title, right-aligned amount/action.
- Row height is `py-3` minimum on data-dense lists; `py-4` on primary cards.
- Hover: `bg-white/[0.02]` → `bg-white/[0.04]`, `border-white/[0.06]` → `[0.12]`.
- Clickable rows are `<a>` or `<Link>` — never `<div onClick>`. If the row has a primary destination, the whole row is a link; interior actions are nested `<button>`s with `stopPropagation`.

### 4.2 Empty states

The standard empty state has:

1. Dashed border on a `surface-1` card (`border-dashed border-white/[0.08]`).
2. Short, human headline (e.g. *"No agents yet."*).
3. One-line subhead describing the value proposition.
4. Primary CTA (button for destructive/multi-step actions; link for simple nav).
5. Optional secondary "How it works" outlined button.

No illustrations. No mascots.

### 4.3 Loading states

Three shapes, each with a fixed meaning:

| Shape | Use |
|---|---|
| **Skeleton** (`animate-pulse` rectangles) | List data loading from server |
| **Pulsing indigo dot + text** ("Loading…") | Whole-route transitions, dynamic imports |
| **Spinner** (animated ring) | In-flight actions inside a modal/button |

Never use a spinner for a route load. Never skeleton a single value.

### 4.4 Error states

- **Inline error** (red-400 text under the offending field) for form validation.
- **Card-level error + Retry button** for data fetches that fail.
- **Toast** (see 4.7) for transient async errors (network drop mid-session).
- **ErrorBoundary fallback** for unhandled render errors — must stay inside the design system; no out-of-palette colors.

### 4.5 Modals

- Mounted into a portal; backdrop `bg-black/60 backdrop-blur-sm`.
- Max width: `max-w-lg` (forms), `max-w-2xl` (multi-step / review), `max-w-xl` (confirm).
- Always `max-h-[90vh] overflow-y-auto` on the body.
- Close affordances: top-right ✕ button **and** click-outside **and** Escape key. All three.
- Focus trap inside the modal while open; return focus to the trigger on close.
- Never nest modals. If you need a confirm-inside-a-modal, use an inline confirm panel, not a second overlay.

### 4.6 Multi-step flows

Multi-step modals (SendModal, CreateAgentModal, AddSafeModal deploy) follow:

1. Named steps in state (`'form' | 'review' | 'executing' | 'result'`). No numeric step indices in UI logic.
2. Header shows current step label, not a progress bar percentage.
3. Primary button label reflects the *next* action ("Review" → "Send" → "Done"), not the current state.
4. `executing` state is non-dismissible. User cannot close the modal mid-transaction.
5. `result` state shows outcome + link to block explorer (success) or error copy + retry (fail).

### 4.7 Toasts (global)

- Single global toast container, top-right on desktop, bottom on mobile.
- Max 3 concurrent. New toasts push old ones off.
- Durations: success 4s, info 6s, error sticky until dismissed.
- Content: one line, optional one action ("Undo", "View"). Never a form.
- `aria-live="polite"` container; errors use `aria-live="assertive"`.

### 4.8 Confirm dialogs

Destructive actions (reject payment, remove Safe, revoke agent, delete contact) require a styled confirm modal — **never** `window.confirm` or `window.alert`.

- Title describes the action: *"Revoke this agent?"*
- Body states the consequence in plain language + whether it's reversible.
- Primary button is red (`bg-red-500 hover:bg-red-400`) and labels the action verb ("Revoke agent"), not "Confirm".
- Cancel button is secondary (transparent).
- Escape = cancel.

---

## 5. Forms

- Every input has a visible `<label>` with `htmlFor`.
- Placeholders are examples, not labels. If there's no natural example, omit.
- Validation fires on blur first, then on every change *once the field has been touched*. Don't flash errors on first focus.
- Error text is red-400, sits under the field, is prefixed with the problem not the field name: *"Must be at least 12 characters"*, not *"Password: invalid"*.
- Passwords: `type="password"` + `autoComplete="current-password"` (login) / `"new-password"` (signup) + visibility toggle.
- Amount inputs: right-aligned, tabular-nums, with the asset symbol as an adornment on the right.
- Address inputs: accept checksummed `0x…`, ENS `*.eth`, Basenames `*.base.eth`. Trim whitespace on paste.
- `<Enter>` submits the form unless the focused element is a textarea or multi-select.

---

## 6. Money, addresses, networks

### Amounts

- Use a single `formatTokenAmount(raw: bigint, decimals: number, locale?: string)` helper. No ad-hoc `Number(x) / 1e6` arithmetic in components.
- Display up to 4 significant decimals for balances, 2 for fiat-equivalent, exact for confirmation screens.
- Thousands separator from the user's locale (`Intl.NumberFormat`).
- Zero renders as `0.00`, not `0` — except on empty-state headers.

### Addresses

- Truncate as `0xabcd…wxyz` (6+4). Full address visible in a tooltip on hover and copyable.
- Contacts and resolved ENS/Basenames show the **name** with the short address in a muted second line.
- Never show a raw un-truncated address inline in body text.

### Networks

- Render with `<NetworkPill chainId={...} />` — name + color dot. No chain id numbers in user-facing UI.
- Every signing context states which network the action is on: *"Send on Base"*, *"Deploy on Gnosis Chain"*.
- Never hardcode a chain assumption in copy. Gas token, block explorer URL, and chain name come from the `chains.ts` registry.

### Time

- Relative (`"2m ago"`, `"3h ago"`, `"Yesterday"`) for recent (< 7 days).
- Absolute localized date (`"Apr 14, 2026"`) for older.
- On hover, always show the exact timestamp in the tooltip.
- Single `timeAgo(date)` helper; no per-component reimplementations.

---

## 7. Accessibility (non-negotiable)

- **Every interactive element is keyboard reachable.** Tab order follows visual order.
- **Focus-visible ring** on every focusable element: `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]`.
- **Color contrast ≥ WCAG AA.** `text-zinc-500` on `surface-base` is the minimum for small text; `text-zinc-700` is decorative only.
- **Icon-only buttons carry `aria-label`**. `title` alone is not enough.
- **Escape closes modals and dropdowns.** Always.
- **Skip-to-content link** at the top of `<main>`.
- **`aria-live` regions** for status (saving, sending, approved). `polite` by default; `assertive` only for errors requiring attention.
- **Semantic HTML first:** `<button>` for buttons, `<a>` for navigation, headings in order.
- **Reduced motion:** respect `prefers-reduced-motion` — disable pulse/ping animations.

---

## 8. Security & trust UX

Rules for every place money moves:

1. **Show what will happen before it happens.** Review step lists amount, recipient (with resolved name), network, gas payer, and policy match.
2. **Say who signs.** "Your signing wallet will be asked to sign" before the wallet popup appears.
3. **Never imply Haven has custody.** No "Haven will send…" copy. Always "Your account will send…" or "You will sign to send…".
4. **Externally verifiable links are required** on every on-chain action result: block explorer link, Safe transaction link.
5. **Reveal-once secrets** (agent API keys, private keys): show once, with copy button, with an explicit "I've saved this" checkbox before the user can move on. Never re-display.
6. **Destructive actions** require a typed confirmation for the highest-stakes ones (remove last Safe, revoke an agent with active allowance). A click is not enough.
7. **Session length** is visible in Settings. A sensitive action (password change, owner change, high-value send) re-prompts for signature even if the session is valid.
8. **Raw error messages never reach the user.** Map technical errors to human copy; log the raw for debugging.

---

## 9. Agent UX (domain-specific)

- An agent is introduced in the UI as *"an actor with a budget"* — that framing must survive every screen.
- The default preset for a new agent is **conservative** (small daily limit, short expiry). Opinionated defaults prevent accidents.
- Policy editing uses plain-language summaries above the inputs: *"This agent can spend up to 50 USDC per day, expiring in 7 days."*
- Allowance progress bars escalate color at 40% (amber) and 75% (red). The number is always visible with the bar.
- The activity feed and the approval queue are the two places to build operator trust. They must always be reachable in ≤ 2 clicks from Dashboard.
- An agent that has expired or been revoked is shown **struck through with a reason**, not hidden. Auditability wins over tidiness.

---

## 10. Responsive rules

| Breakpoint | Behavior |
|---|---|
| `< 640px` | Single column everywhere. Sidebar collapses into hamburger. Modals full-height. Bottom-aligned toasts. |
| `640–1024px` | 2-column where data allows (Dashboard). Sidebar still hidden under hamburger. |
| `≥ 1024px` | Full layout: persistent sidebar, 2/3 + 1/3 Dashboard grid. |
| `≥ 1536px` | Max content width `max-w-7xl` — don't stretch card content beyond readability. |

- Touch targets ≥ 44×44 on mobile.
- No horizontal scroll except in explicit tables with `overflow-x-auto`.

---

## 11. Performance & perceived speed

- Route transitions show the pulsing-dot indicator within 100ms of navigation start.
- Data fetches over 300ms show a skeleton.
- No layout shift when data loads — skeletons match final dimensions.
- Modal open/close animations ≤ 150ms. Page transitions are instant.
- Don't block the UI on secondary data (e.g. USD prices). Show the primary value, hydrate the derived one.

---

## 12. Copy library (reusable strings)

Keep these exact strings. Don't paraphrase them across screens.

- Non-custody banner: *"Haven never holds signing authority. Your account signs every transaction."*
- Signing wallet prompt: *"Your signing wallet will be asked to approve this."*
- Agent created, key shown: *"Save this API key now. You won't be able to see it again."*
- Reject payment confirm: *"Reject this payment? The request will be cancelled and the agent will be notified."*
- Revoke agent confirm: *"Revoke this agent? Its API key will stop working immediately. This cannot be undone."*
- Remove Safe confirm: *"Remove this account from Haven? Funds on-chain are unaffected. You can re-import it later."*
- Empty dashboard: *"No activity yet. Send, receive, or add an agent to get started."*
- Network error: *"We couldn't reach the network. Check your connection and try again."*

---

## 13. Decision log (how we extend these guidelines)

- New pattern? First check whether an existing primitive covers it.
- If not, propose it in a PR that (a) adds the component, (b) documents it in this file, (c) migrates at least one existing usage to prove the API.
- A guideline only enters this doc when it has been applied in production at least once.
- Deprecations go in `UX_AUDIT.md` first, get replaced over at least one release, and are struck through here with the replacement linked.

---

_v1 — seeded from `UX_AUDIT.md` v1._
