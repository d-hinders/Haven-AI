# Haven redesign — implementation handoff

This file is historical project context for the v2 redesign migration. The migration phases are complete; use it only when you need to understand why specific implementation choices were made.

**Reference:**
- Production marketing routes: `/`, `/how-it-works`, `/protocols/x402`, and `/protocols/mpp`
- Design system: `docs/design_system/DESIGN_SYSTEM.md`
- **Copy (authoritative):** `docs/design_system/UX_COPY_GUIDELINES.md` — read this before touching any user‑facing string
- Product doctrine + IA + accessibility: `docs/UX_GUIDELINES.md`

**Status:** Phase 0, Phase 0.5, Phase 1, Phase 2, and Phase 3 are implemented. New work should start from `UX_GUIDELINES.md`, `DESIGN_SYSTEM.md`, and `UX_COPY_GUIDELINES.md`.

**Original order of work:** Phase 0 → Phase 1 (marketing) → Phase 2 (app) → Phase 3 (cleanup).

---

## Phase 0 — Small "pop" bumps before graduation

These are tiny tweaks the user asked for after approving the v2 direction. Do them first, in the mockup namespace, so we ship a slightly more energetic version.

### Task 0.1 — Bump hero mesh saturation by ~10%
**File:** `packages/frontend/src/components/marketing/v2/V2HeroBackdrop.tsx`
- Indigo blob: `0.45` → `0.55` opacity
- Pink blob: `0.45` → `0.55`
- Cyan blob: `0.40` → `0.50`
- Amber blob: keep — already a quiet accent

**Acceptance:** open `/design/v2`, the hero has visibly more colour in the corners without losing the white reading surface around the headline.

### Task 0.2 — Add a soft brand‑tinted hover lift to all `V2Card` instances
**File:** `packages/frontend/src/components/marketing/v2/V2Card.tsx`
- Add a `hover` prop (default `true`). When true, append `hover:shadow-[0_8px_24px_-12px_rgba(16,24,40,0.12)] transition-shadow duration-200`.
- Hero‑level cards (flow card, code block) keep their custom shadows — pass `hover={false}`.

**Acceptance:** every card lifts subtly on hover. No double shadows on the homepage flow card.

### Task 0.3 — Brand‑tinted accent on eyebrows for color‑band sections
**File:** `packages/frontend/src/app/design/v2/page.tsx`
- The Policy Engine band's eyebrow ("Policy engine") is currently `text-pink-300`. Change to a softer `text-fuchsia-200` and add a small leading dot (`<span className="w-1.5 h-1.5 rounded-full bg-fuchsia-300 inline-block mr-2" />`) for visual rhythm with the rest of the page.

**Acceptance:** eyebrow on the dark band reads consistently with the light eyebrows but adapted for the surface.

### Task 0.4 — Slow drift on hero mesh (very subtle)
**File:** `packages/frontend/src/app/design/v2/v2.css`
- Add a `@keyframes v2-mesh-drift` that translates ±2% over 18s, ease‑in‑out, infinite alternate. Apply to `V2HeroBackdrop`'s outer wrapper via a class.
- Wrap in `@media (prefers-reduced-motion: no-preference)` so it's off for users who opt out.

**Acceptance:** the hero feels alive — colours migrate slowly. Effect is invisible on still inspection but perceptible after a few seconds. Off entirely under `prefers-reduced-motion`.

### Task 0.5 — Verify
- Run `pnpm --filter @haven/frontend dev`.
- Visit `/design/v2`, `/design/v2/how-it-works`, `/design/v2/protocols/x402`, `/design/v2/protocols/mpp`. Each hero has more colour, every card lifts on hover, the dark band's eyebrow has the fuchsia dot, the mesh drifts slowly.
- `pnpm --filter @haven/frontend lint && pnpm --filter @haven/frontend test`.

---

## Phase 0.5 — Copy pass

The mockups were written before `docs/UX_COPY_GUIDELINES.md` was finalised. Several strings still use the old technical vocabulary (`Policy engine`, `Connect your wallet`, `Hand the credential to your agent`, etc.). Apply the copy guidelines **in the mockup namespace first** so the user can review the wording on the v2 preview routes, then graduate. This is a separate pass from the visual changes in Phase 0.

**Read `docs/UX_COPY_GUIDELINES.md` start to finish before starting.** The technical‑term mapping table at the bottom is the source of truth for replacements.

### Task 0.5.1 — Homepage (`app/design/v2/page.tsx`)

Apply these explicit swaps:

| Current | Replace with |
|---|---|
| Hero lede: "Non‑custodial wallet infrastructure that gives AI agents the ability to hold, send, and receive money — within strict, user‑defined guardrails." | "An account for your agents. You set the rules — they pay within them, never beyond. No raw keys, no shared cards." |
| `HOW_IT_WORKS` step 02 title "Create an agent with policies" | "Set agent rules" |
| `HOW_IT_WORKS` step 02 body "Define exactly what each agent can do: daily spend limits, allowed assets, approved recipients, and per‑transaction approval thresholds." | "Choose how much each agent can spend, who it can pay, and what it can pay for." |
| `HOW_IT_WORKS` step 03 title "Agents transact within the rules" | "Connect your agent" |
| `HOW_IT_WORKS` step 03 body | "Add your Haven credential to Claude, GPT, or your own agent. It can now make payments — only within the rules you set." |
| Section title "Three steps. One policy engine. Zero raw keys." | "Three steps. One set of rules. Zero raw keys." |
| Policy band eyebrow "Policy engine" | "Agent rules" |
| Policy band title "The rules that gate every payment." | (keep) |
| Policy band lede: "Every payment intent passes through the policy engine before any money moves. Agents request — they don't decide." | "Every payment is checked against your rules before any money moves. Agents request — you decide." |
| `POLICY_METRICS[0].label` "Daily spend limit" | "Daily budget" |
| `POLICY_METRICS[1].label` "Asset allowlists" | "Allowed tokens" |
| `POLICY_METRICS[3].label` "Audited transactions" | "Audited payments" |
| `DIFFERENTIATORS[0].title` "Non‑custodial" | "You stay in control" |
| `DIFFERENTIATORS[0].body` "Funds live in a smart wallet you control. Haven never holds signing authority — if we disappear tomorrow, your money is safe." | "Your funds live in your Haven wallet. You approve actions; Haven never moves money on its own. If we disappear tomorrow, your money is safe." |
| `DIFFERENTIATORS[1].title` "Policy‑first" | "Rules‑first" |
| `DIFFERENTIATORS[1].body` "Every action is evaluated against your rules before execution. No intent touches the blockchain without passing through the policy engine." | "Every payment is checked against your rules before it goes through. Nothing reaches the network without clearing your rules." |
| `DIFFERENTIATORS[2].title` "Agent‑first API" | "Built for agents" |
| `DIFFERENTIATORS[3].title` "Protocol native" | "Open standards" |
| `DIFFERENTIATORS[4].title` "Runtime agnostic" | "Works with any agent" |
| `DIFFERENTIATORS[5].title` "Defense in depth" | "Layered security" |
| `DIFFERENTIATORS[5].body` (mentions "smart account, policy engine, credential scoping…") | "Five independent layers — your Haven account, your rules, scoped agent credentials, approval flows, and a full audit trail." |
| Protocol card x402 title "x402 — pay‑per‑request HTTP" | (keep — protocol pages can use the technical name) |
| CTA "Ready to give your agents financial superpowers?" | "Ready to put your agents to work?" |
| CTA lede "No credit card required. Deploy in minutes." | "No credit card. No setup call. Live in minutes." |

### Task 0.5.2 — How‑it‑works page (`app/design/v2/how-it-works/page.tsx`)

The copy guidelines provide the **preferred copy verbatim** for this page (section "How it works page"). Replace the entire `STEPS` array with this content:

```ts
const STEPS = [
  { step: '01', title: 'Create your Haven account',
    body: 'Sign up with your email. No credit card and no setup call needed.',
    visual: 'account' },
  { step: '02', title: 'Choose how you sign in',
    body: 'Use Face ID / Touch ID or connect your wallet. Either way, you stay in control of your account.',
    visual: 'wallet' },
  { step: '03', title: 'Set up your Haven wallet',
    body: 'We create your Haven wallet in the background. This is where you hold the funds your agents can spend.',
    visual: 'vault' },
  { step: '04', title: 'Add funds',
    body: 'Add USDC, EURe, or another supported token to start making payments.',
    visual: 'fund' },
  { step: '05', title: 'Set agent rules',
    body: 'Choose how much an agent can spend, who it can pay, and what it can pay for.',
    visual: 'credentials' },
  { step: '06', title: 'Connect your agent',
    body: 'Add your Haven credential to Claude, GPT, or your own agent. It can now make payments within the rules you set.',
    visual: 'agent' },
] as const
```

Other swaps on this page:

| Current | Replace with |
|---|---|
| Hero h1 "Empower your agent with payment functionality." | (keep — works with positioning) |
| Hero lede "Your agent pays for things on its own — and you stay in control of every dollar." | (keep) |
| Section title "From zero to a paying agent." | (keep) |
| Promises block — "Non‑custodial / Haven never holds your funds" | "You stay in control / Haven never moves money on its own" |
| Promises block — "1‑click revoke / Kill an agent instantly" | "Instant revoke / Stop an agent in one click" |
| Visuals: `VisualCredentials` shows `sk_live_••••9aF2` with copy button. Change the heading from "Policy" to "Agent rules". | as written |
| `VisualVault` "Haven cannot move funds without your signature" | "Haven cannot move funds without your approval" |

### Task 0.5.3 — Flow card (`components/marketing/v2/V2FlowCard.tsx`)

| Current | Replace with |
|---|---|
| Header "Live payment intent" | "Live payment" |
| Step 1 label "Intent received" | "Payment requested" |
| Step 1 sub "POST /payments" | (keep — it's developer detail; appropriate on the homepage where the audience overlaps) |
| Step 2 label "Policy evaluated" | "Rules check" |
| Step 2 check "Within per‑tx limit" | "Within per‑payment limit" |
| Step 2 check "Network allowed" | "Allowed network" |
| Step 2 check "Allowance sufficient" | "Funds available" |
| Step 3 label "Settled on Base" | (keep — Base is the chain name and is appropriate here) |
| Footer "auto‑executed" | "approved automatically" |

### Task 0.5.4 — Protocol pages

These are technical pages — the audience overlaps with developers — so technical terms are allowed. **Don't strip protocol names** (`x402`, `MPP`, `AllowanceModule`, `Base`, `USDC`). Do still update generic product‑facing strings:

**`app/design/v2/protocols/x402/page.tsx`:**

| Current | Replace with |
|---|---|
| `POLICY_CHECKS[0]` "Within per‑tx limit (1 USDC)" | "Within per‑payment limit (1 USDC)" |
| Actor tile "Policy engine / Haven" kicker | "Agent rules / Haven" |
| Actor tile body for Haven: "Evaluates the intent against agent policy." | "Checks the payment against your agent rules." |
| Timeline event "Policy engine evaluated intent" | "Rules checked" |
| Timeline event "Policy cleared — delegate signed transfer" | "Rules cleared — Haven signed the transfer" |

**`app/design/v2/protocols/mpp/page.tsx`:** same swaps (`POLICY_CHECKS`, "Policy engine" → "Agent rules", "Evaluates the intent against agent policy" → "Checks the payment against your agent rules", timeline "Policy" wording).

### Task 0.5.5 — Verify

Open all four mockup routes. Search for these terms in the rendered DOM and confirm zero hits:
- `policy engine` (case‑insensitive)
- `signing wallet`
- `hand the credential`
- `drop the credential`
- `generate credentials`
- `non‑custodial` (in body copy — it's fine in technical copy lower down a page if it's the right word, but it shouldn't lead)
- `safe deployed`
- `relayer`

`rg -i "policy engine|signing wallet|hand the credential|drop the credential|generate credentials|safe deployed|relayer" packages/frontend/src/app/design packages/frontend/src/components/marketing/v2` should return nothing.

---

## Phase 1 — Graduate marketing site

Move v2 from a preview namespace into production. Existing dark marketing pages get **replaced**. App routes (`(authenticated)/*`) are **untouched** in this phase — they stay dark until Phase 2.

### Task 1.1 — Lift tokens into the global stylesheet and Tailwind config

**Files:**
- `packages/frontend/src/app/globals.css` — add a `:root { --v2-bg: …; … }` block copied verbatim from `app/design/v2/v2.css`. Drop the `.v2-root` scoping.
- `packages/frontend/tailwind.config.js` — extend `theme.extend.colors` with semantic names that read the CSS vars:
  ```js
  colors: {
    bg: 'var(--v2-bg)',
    surface: 'var(--v2-surface)',
    'surface-2': 'var(--v2-surface-2)',
    'surface-code': 'var(--v2-surface-code)',
    ink: { DEFAULT: 'var(--v2-ink)', 2: 'var(--v2-ink-2)', 3: 'var(--v2-ink-3)' },
    border: { DEFAULT: 'var(--v2-border)', strong: 'var(--v2-border-strong)' },
    brand: { DEFAULT: 'var(--v2-brand)', strong: 'var(--v2-brand-strong)', soft: 'var(--v2-brand-soft)' },
    success: { DEFAULT: 'var(--v2-success)', soft: 'var(--v2-success-soft)' },
    warning: { DEFAULT: 'var(--v2-warning)', soft: 'var(--v2-warning-soft)' },
    danger:  { DEFAULT: 'var(--v2-danger)',  soft: 'var(--v2-danger-soft)'  },
  }
  ```
  Also extend `boxShadow` with `card`, `button`, `modal`, and `borderRadius` with `card: 10px`, `modal: 14px`.

**Important:** the existing app pages use `bg-[#0a0a0a]`, `text-[#ededed]`, `border-white/[0.06]` etc. The dark theme **must keep working** during this phase — don't change the body background to white globally. Set the white bg only on the marketing routes (homepage, how-it-works, protocols/*) explicitly. The authenticated layout already sets its own dark wrapper, so that survives.

**Acceptance:** `bg-bg`, `text-ink`, `border-border`, `bg-brand` etc. compile. Existing dark app screens are visually unchanged.

### Task 1.2 — Promote v2 components to shared primitives

Move and rename:

| From (delete after) | To |
|---|---|
| `components/marketing/v2/V2Button.tsx` | `components/ui/Button.tsx` |
| `components/marketing/v2/V2Card.tsx` | `components/ui/Card.tsx` |
| `components/marketing/v2/V2Section.tsx` | `components/marketing/Section.tsx` |
| `components/marketing/v2/V2CodeBlock.tsx` | `components/ui/CodeBlock.tsx` |
| `components/marketing/v2/V2StepList.tsx` | `components/marketing/StepList.tsx` |
| `components/marketing/v2/V2HeroBackdrop.tsx` | `components/marketing/HeroBackdrop.tsx` |
| `components/marketing/v2/V2FlowCard.tsx` | `components/marketing/FlowCard.tsx` |
| `components/marketing/v2/V2Header.tsx` | replaces `components/marketing/SiteHeader.tsx` |
| `components/marketing/v2/V2Footer.tsx` | replaces `components/marketing/SiteFooter.tsx` |

Drop the `V2` prefix from default exports. Update the `nav` links in `SiteHeader` (formerly `V2Header`) to point at production routes (`/`, `/how-it-works`, `/protocols/x402`, `/protocols/mpp`) instead of `/design/v2/...`.

If `Button` is used inside the authenticated app already, **don't break it** — search for existing `<Button>` imports first; if there are none, the rename is safe.

**Acceptance:** all v2 mockup pages still render unchanged after the imports are rewritten. Tests pass.

### Task 1.3 — Replace `app/page.tsx` (homepage)

- Copy the full body of `app/design/v2/page.tsx` over `app/page.tsx`.
- Update imports to the promoted paths.
- Update internal links: `/design/v2/how-it-works` → `/how-it-works`, `/design/v2/protocols/x402` → `/protocols/x402`, `/design/v2/protocols/mpp` → `/protocols/mpp`.
- Remove the production `metadata` export only if a richer one isn't already there; keep the existing title/description if better.

**Acceptance:** `/` shows the new homepage. Old gradient‑heavy version is gone.

### Task 1.4 — Replace `app/how-it-works/page.tsx`

- Copy from `app/design/v2/how-it-works/page.tsx`.
- Update imports + links as in 1.3.
- The current production page has additional copy/structure not in the v2 mockup (e.g. some legacy nav items). Compare and fold any **product copy** the user has since added back in. Visual chrome and step visuals come from v2.

**Acceptance:** `/how-it-works` shows the v2 design with all production copy preserved.

### Task 1.5 — Replace `app/protocols/x402/page.tsx`

This is the biggest delta. The production page has an **interactive state‑machine demo** (the `run()` callback, phase timers, animated `StageColumn` and `FlowArrow`). The v2 mockup has a **static** representation.

**Approach:** keep the live state machine, restyle it with the v2 system.
- Lift the existing `Phase`, `DEMO`, `useState`/`useEffect` logic from the current production file into the new page.
- Replace the dark `StageColumn` styling: white card on `--v2-bg`, brand‑coloured ring when `active`, success ring when `done`. No glow shadow — use the `--v2-shadow-card` and a brand‑soft background tint when active.
- Replace the dark `FlowArrow`: hairline border by default (`bg-[var(--v2-border-strong)]`), brand colour when active, success colour after `delivered`. The moving dot keeps the brand colour but loses the glow shadow.
- Replace the timeline rows with the static `TIMELINE` component pattern from `app/design/v2/protocols/x402/page.tsx` — but populated dynamically from the live `timeline` state.
- Keep "Run payment flow" / "Settling…" / "Run again" buttons; replace gradient styling with `Button` primary.

**Acceptance:** clicking "Run payment flow" plays the same 8‑step animation as today, but on the light surface in v2 styling.

### Task 1.6 — Replace `app/protocols/mpp/page.tsx`

Same as 1.5 — the MPP page has the same state‑machine architecture. Lift the logic, restyle.

### Task 1.7 — Replace `SiteHeader` / `SiteFooter` consumers

The existing `SiteHeader` is imported by all four marketing pages. After Task 1.2 it's already been replaced — confirm every import resolves.

If any other consumer (login, signup pages) imports `SiteHeader` and **expects the dark version**, leave those pages on the dark theme for now (don't include them in this phase) — they're auth surfaces and graduate with the app in Phase 2.

**Acceptance:** marketing routes use the new header/footer; auth surfaces (`/login`, `/signup`, `/onboarding`) are untouched.

### Task 1.8 — Delete the v2 mockup namespace

Once 1.3–1.7 are verified visually:
- `rm -rf packages/frontend/src/app/design`
- `rm -rf packages/frontend/src/components/marketing/v2`

Update `docs/DESIGN_SYSTEM.md` Section 7 ("Where things live") so the "Today" column matches reality.

### Task 1.9 — Update `docs/UX_GUIDELINES.md`

Section 3 of `UX_GUIDELINES.md` ("Visual system") still describes the **dark surface tokens**. Either:
- (a) Replace section 3 entirely with a pointer to `DESIGN_SYSTEM.md`, **or**
- (b) Keep both sets of tokens, label one "marketing (light)" and one "app (dark, deprecated)" until Phase 2 lands.

Recommend (b) until Phase 2 begins so app contributors aren't confused.

### Phase 1 verification

- `/`, `/how-it-works`, `/protocols/x402`, `/protocols/mpp` all render the v2 design.
- The two protocol demos still play their state machines end‑to‑end.
- Every authenticated route (`/dashboard`, `/agents`, etc.) looks **identical to today** — dark, untouched.
- `pnpm --filter @haven/frontend lint && pnpm --filter @haven/frontend test && pnpm --filter @haven/frontend build` all pass.
- Manual mobile pass at 375px on each marketing page.

---

## Phase 2 — Migrate the app to light

Goal: bring the authenticated app onto the same light system. Bigger scope; tackle in slices.

### Task 2.1 — Define dark→light token mappings for app

Audit `(authenticated)/*` for hardcoded dark colours. Produce a mapping doc (append to `DESIGN_SYSTEM.md`):
- `bg-[#0a0a0a]` → `bg-bg`
- `bg-white/[0.02]` → `bg-surface`
- `bg-white/[0.04]` → `bg-surface-2`
- `bg-white/[0.06]` → `bg-surface-2` or `bg-brand-soft` depending on context
- `border-white/[0.06]` → `border-border`
- `border-white/[0.08]` → `border-border-strong`
- `text-zinc-300` → `text-ink`
- `text-zinc-400` → `text-ink-2`
- `text-zinc-500` → `text-ink-3`
- `text-zinc-600` → `text-ink-3` (with a note — used in disabled states, may need a new `--v2-ink-disabled`)
- `bg-gradient-to-r from-indigo-500 to-violet-600` → `bg-brand` (kill the gradient on buttons)

Status colours (`amber`, `emerald`, `red`) keep their semantic mapping per the system doc.

### Task 2.2 — Migrate the app shell

**Files:**
- `app/(authenticated)/layout.tsx`
- `components/sidebar/Sidebar.tsx`
- `components/TopBar.tsx`

Apply the mapping. Sidebar gets `bg-surface border-r border-border`; active nav row gets `bg-brand-soft text-brand`. TopBar gets `bg-bg/85 backdrop-blur border-b border-border`.

**Acceptance:** the shell is light. Internal pages still render with their old dark content (broken, but isolated) — fixed in 2.3+.

### Task 2.3 — Build shared app primitives

Promote these from one‑off implementations into shared primitives in `components/ui/`:
- `Button` — already exists from Phase 1, extend with `danger` and `tertiary` variants.
- `Modal` — extract from `ConfirmDialog`/`SendModal`/`CreateAgentModal`. Backdrop `bg-ink/40 backdrop-blur-sm`, panel `bg-bg border border-border rounded-modal shadow-modal`.
- `Input` / `Select` — `bg-bg border border-border rounded-md focus:border-brand focus:ring-2 focus:ring-brand/20`.
- `StatusBadge` — variants: `success`, `warning`, `danger`, `neutral`, `brand`. Pill with soft bg + saturated text.
- `EmptyState` — dashed border, centered icon, primary action.

**Acceptance:** primitives have stories or a single visual reference page (could live at `/design/v2/primitives` temporarily, then deleted).

### Task 2.4 — Copy migration in the authenticated app

Apply `docs/UX_COPY_GUIDELINES.md` across the app surfaces. This is bigger than the marketing pass because the app has more strings and many of them currently leak Safe / Module / Policy terminology.

Key surfaces and the term swaps that apply:

- **Onboarding (`app/onboarding/*`, `app/login/*`, `app/signup/*`):** the copy doc has prescribed strings for "Choose your network and sign‑in method", the passkey screen, deployment progress labels, and the success state. Use them verbatim. Replace any "Safe deployed", "Enroll signer", "Deploy smart account", "Relayer" with the user‑facing equivalents.
- **Sidebar nav:** review labels. "Approval queue" → "Approvals" is fine. "Accounts" / "Agents" / "Transactions" / "Contacts" / "Settings" — all match the doc.
- **Dashboard:** any "Safe" or "smart account" references in headings, empty states, tooltips → "Haven account" / "Haven wallet". `BalanceCards` heading "Balance" stays. The portfolio hero CTAs ("Send", "Receive", "Add funds") are fine.
- **Agents (`/agents`, `/agents/[id]`):** "Spending policy" / "Policy" / "Allowance module" → "Agent rules" or "Agent budget". Modal "Create agent" → make sure the policy step is labelled "Set agent rules". "Generate credentials" → "Get the credential to connect your agent". "Hand the credential to your agent" → "Add your Haven credential to your agent". "Revoke agent" stays.
- **Approvals queue:** "Pending payment" / "Approve" / "Reject" — already clear. Make sure error states follow the voice rules.
- **Transactions / payments:** "Transaction" is fine when referring to on‑chain records; outbound transfers Haven executes can use "Payment". Avoid "Outgoing internal tx".
- **Settings → Sign‑in methods:** screen title "Sign‑in methods", not "Signers" or "Owners". List items show device labels and "approve actions in your Haven account" copy.
- **Account details:** technical disclosure surface — `Safe address`, `Setup transaction`, `Module status`, `Network` are fair game here per the copy doc's "Safe can be shown later in account details" allowance. Keep the technical detail, just label it gently ("Account address" with "Also known as Safe address" subtitle is the recommended pattern).
- **Errors:** rewrite per the voice rules. Bad: `Error: 500`. Good: "We couldn't reach the network. Try again in a moment."

**Acceptance:** `rg -i "policy engine|signer|enroll|safe deployed|smart account|relayer|owner type" packages/frontend/src/app/\(authenticated\)` returns only deliberate technical‑disclosure occurrences (each annotated with a comment if not obvious from context). The grep should be near‑empty.

### Task 2.5 — Migrate page‑by‑page

Order by visibility / blast radius:
1. `/dashboard` (`DashboardClient.tsx` + `PortfolioHero` + `BalanceCards` + `TransactionList` + `ApprovalQueue`)
2. `/transactions`
3. `/agents` and `/agents/[agentId]`
4. `/accounts` and `/accounts/[safeId]`
5. `/approvals`
6. `/contacts`
7. `/settings`
8. `/login`, `/signup`, `/onboarding` (auth surfaces — these were skipped in Phase 1)

For each: replace inline class strings using the dark→light mapping. Replace gradient buttons with `Button`. Replace one‑off cards with `Card`.

### Task 2.6 — Update `UX_GUIDELINES.md`

Now that the app is light:
- Replace section 3 (visual system) with a one‑line pointer to `DESIGN_SYSTEM.md`.
- **Replace section 1 (Language & terminology) with a one‑line pointer to `UX_COPY_GUIDELINES.md`.** The terminology table in `UX_GUIDELINES.md` is now stale and conflicts with the copy guidelines — collapse it.
- Walk through sections 4 (component patterns) and 5 (states) and update class examples to the new system.
- IA (section 2), accessibility (section 7), and the parts of voice (section 6) that don't conflict with the copy guidelines — keep.

### Phase 2 verification

- Every authenticated route is light, consistent, accessible at WCAG AA.
- All forms still validate, all modals still trap focus, all loading skeletons render on the light surface.
- Lint, test, build pass. Manual mobile pass.

---

## Phase 3 — Cleanup

**Completed:** the production app no longer contains residual `bg-[#…]`, `text-zinc-*`, or `bg-zinc-*` app-surface classes. The `/v2` redirect and remaining unused dark-era components were removed. `DESIGN_SYSTEM_V2.md` was renamed to `DESIGN_SYSTEM.md`.

### Task 3.1 — Audit residual `bg-[#…]` literals
Run `rg "bg-\[#" packages/frontend/src` and `rg "text-zinc-" packages/frontend/src`. Every remaining occurrence is either an intentional escape or an oversight. Convert or document.

### Task 3.2 — Delete the v2 mockup namespace remainder
Confirm `app/design/` and `components/marketing/v2/` are gone. If a primitives reference page was left in place for Phase 2, delete it now.

### Task 3.3 — Final docs pass
- `DESIGN_SYSTEM.md` — renamed from `DESIGN_SYSTEM_V2.md` after it became the only system. Section 7 reflects the post‑migration file layout.
- `UX_GUIDELINES.md` — final read‑through.
- A separate `CONTRIBUTING_DESIGN.md` was not added; the condensed do/don't guidance now lives in `UX_GUIDELINES.md` plus `DESIGN_SYSTEM.md`.

---

## Open questions Codex should flag back, not guess on

1. **Auth surfaces theme.** `/login`, `/signup`, `/onboarding` — should they be light from Phase 1 (consistent with marketing) or wait for Phase 2 (consistent with the rest of the app)? Plan above says Phase 2; flag if it feels wrong while implementing 1.7.
2. **Token names in Tailwind.** Going with semantic names (`brand`, `ink`) over scale names (`indigo-600`, `slate-900`). If anyone in the codebase is already using a different naming convention, flag before locking in.
3. **`UX_GUIDELINES.md` reconciliation.** Phase 1 keeps both token sets side‑by‑side; Phase 2 collapses to one. Phase 2 also collapses the terminology table (section 1 of UX_GUIDELINES) into a pointer at `UX_COPY_GUIDELINES.md`. Confirm with the user before deleting the dark‑system documentation.
4. **Copy guidelines coverage gaps.** `UX_COPY_GUIDELINES.md` has explicit guidance for onboarding, sign‑in, agent setup, and the how‑it‑works page. It's lighter on: error states, transaction history language, settings nav labels, and dashboard empty states. When you hit a string the doc doesn't cover, **apply the principles** (lead with user outcome, no infrastructure jargon, "Haven account" / "Haven wallet" / "agent rules") and flag a list at the end of each phase so the user can review and add canonical strings to the doc.
5. **Where to surface technical detail.** The copy guidelines say Safe / passkey / module / relayer terms are allowed in "account details, transaction details, advanced settings, developer documentation". For each app surface, decide whether it's product‑facing (translate aggressively) or technical‑disclosure (keep the terms, label them gently). When in doubt, ask.
