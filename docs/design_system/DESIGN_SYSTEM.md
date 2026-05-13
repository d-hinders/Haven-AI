# Haven Design System

This is the source of truth for Haven's current light visual language. Companion to `UX_GUIDELINES.md` (which documents product doctrine, vocabulary, and IA — those rules **still apply**). If older docs mention a dark app surface system, **this document supersedes them**.

The production authenticated app and `/design-system` are the live references for product UX. The production marketing routes are the live references for marketing UX: `/`, `/how-it-works`, `/protocols/x402`, and `/protocols/mpp`. When in doubt, open the live route, inspect the element, and match the system here.

---

## 1. Tokens

All tokens live as CSS custom properties at `:root` in `packages/frontend/src/app/globals.css`. Core color, radius, and shadow tokens are mirrored in `packages/frontend/tailwind.config.js` so they are usable as `bg-bg`, `text-ink`, `border-border`, etc. Newer production tokens such as typography utilities, raised cards, popovers, modal backdrop, and the brand gradient may exist as CSS variables/classes only until they are promoted into Tailwind.

### Surfaces

| Token | Value | Use |
|---|---|---|
| `--v2-bg` | `#ffffff` | Page background |
| `--v2-surface` | `#f6f9fc` | Alternating section bands, card hover backgrounds |
| `--v2-surface-2` | `#eef2f7` | Disabled states, deeper card stacking |
| `--v2-surface-code` | `#0b1120` | Dark code blocks on light pages (Stripe pattern) |
| `--v2-surface-hover` | `#f0f4f9` | Sidebar/user-menu row hover and subtle interactive shells |
| `--v2-modal-backdrop` | `rgba(26, 31, 54, 0.66)` | Modal backdrop with blur |

### Ink (text)

| Token | Value | Use |
|---|---|---|
| `--v2-ink` | `#1a1f36` | Headings, primary text, amounts |
| `--v2-ink-2` | `#525f7f` | Body text, secondary information |
| `--v2-ink-3` | `#8898aa` | Tertiary text, eyebrows, captions |
| `--v2-ink-on-brand` | `#ffffff` | Text on brand‑colored or dark surfaces |

### Borders

| Token | Value | Use |
|---|---|---|
| `--v2-border` | `#e6ebf1` | Default hairline (cards, dividers) |
| `--v2-border-strong` | `#d6dbe3` | Hover, ghost button borders, flow arrows |

### Brand

| Token | Value | Use |
|---|---|---|
| `--v2-brand` | `#4f46e5` (indigo‑600) | Primary CTA bg, links, accents, brand mark |
| `--v2-brand-strong` | `#4338ca` (indigo‑700) | Primary CTA hover |
| `--v2-brand-soft` | `#eef2ff` | Brand‑tinted card backgrounds, focus rings |
| `--v2-brand-gradient` | `linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)` | Gradient wordmark or one restrained brand accent |

Use `.v2-brand-gradient-text` for the production app wordmark. In product UI, do not use the gradient for buttons, badges, large panels, or repeated decoration.

### Semantic

| Token | Value | Soft variant | Use |
|---|---|---|---|
| `--v2-success` | `#0e9f6e` | `--v2-success-soft` `#ecfdf5` | Settled, confirmed, incoming |
| `--v2-warning` | `#b54708` | `--v2-warning-soft` `#fef3c7` | 402 Payment Required, pending review |
| `--v2-danger` | `#b42318` | `--v2-danger-soft` `#fef2f2` | Failed, destructive |

Same rule as v1: **never repurpose a semantic color**.

### Radii

- Buttons: `6px` (`rounded-md`)
- Cards, inputs: `10px` (custom)
- Modals, large surfaces: `14px` (custom)
- Pills, avatars, dots: `9999px` (`rounded-full`)

### Shadows

```css
--v2-shadow-card:    0 1px 2px rgba(16,24,40,.04), 0 1px 3px rgba(16,24,40,.06);
--v2-shadow-card-raised: 0 2px 4px rgba(16,24,40,.06), 0 4px 12px rgba(16,24,40,.08);
--v2-shadow-button:  0 1px 1px rgba(16,24,40,.04), inset 0 1px 0 rgba(255,255,255,.12);
--v2-shadow-modal:   0 12px 32px rgba(16,24,40,.12), 0 4px 8px rgba(16,24,40,.06);
--v2-shadow-popover: 0 12px 24px rgba(16,24,40,.10), 0 2px 6px rgba(16,24,40,.06);
```

Cards on hover get a brand‑tinted lift only when interactive:
`hover:shadow-[0_8px_24px_-12px_rgba(16,24,40,0.12)]` (neutral) or `hover:shadow-[0_12px_32px_-16px_rgba(79,70,229,0.30)]` (protocol cards, navigational).

Raised card elevation is reserved for the few surfaces that anchor a page, such as the dashboard hero and account balance card. Popover shadow is for floating menus, tooltips, and toasts.

**No glow shadows on text**, no colored shadows on buttons.

---

## 2. Typography

Font: Inter (already loaded via `next/font/google` in `app/layout.tsx`). Optional later: switch headings to Inter Display.

Authenticated app pages use compact product typography utilities from `globals.css`:

| Utility | Size / line-height | Weight | Tracking | Use |
|---|---:|---:|---:|---|
| `.v2-text-display` | 40 / 48px | 600 | -0.02em | Rare app hero display, not ordinary dashboards |
| `.v2-text-h1` | 28 / 34px | 600 | -0.015em | PageHeader title |
| `.v2-text-h2` | 20 / 28px | 600 | -0.01em | Major section titles |
| `.v2-text-h3` | 16 / 24px | 600 | 0 | Card and panel titles |
| `.v2-text-body` | 14 / 22px | 400 | 0 | Main app body copy |
| `.v2-text-meta` | 12 / 18px | 400 | 0 | Labels, captions, metadata |

Marketing pages may still use larger hero type:

| Role | Size | Weight | Tracking | Class string |
|---|---|---|---|---|
| Hero h1 | 44 / 64px | 600 | -0.03em | `text-[44px] md:text-[64px] font-semibold tracking-[-0.03em] leading-[1.02]` |
| Section h2 | 28 / 34px | 600 | -0.02em | `text-[28px] md:text-[34px] font-semibold tracking-[-0.02em] leading-[1.15]` |
| Color‑band h2 | 28 / 40px | 600 | -0.025em | adds extra size for impact on dark sections |
| Card title | 15 / 18px | 600 | -0.01em | depending on density |
| Body | 14 / 16px | 400 | normal | leading-relaxed |
| Hero lede | 17 / 18px | 400 | normal | leading-relaxed, color `--v2-ink-2` |
| Eyebrow | 12px | 500 | tracking-tight | uppercase only when on dark band; otherwise sentence case in brand color |
| Caption / mono | 11 / 12px | 400 | font-mono | for tx hashes, addresses, technical detail |

**Tabular numerals** (`.v2-tabular` utility, applies `font-variant-numeric: tabular-nums`) on every amount, address, step counter, metric.

**One h1 per page.** Eyebrows are `<div>`, not headings.

---

## 3. Component patterns

### Authenticated shell

The authenticated app uses one stable product shell:

- Sidebar: 240px desktop rail, mobile overlay, white surface, subtle active tint, and a 2px brand accent bar on the active route.
- Sidebar nav: 36px row height, 16px icon box, 13px medium label. The Approvals item shows a live actionable-count badge, hidden at zero and capped at `99+`.
- Brand: the wordmark may use `.v2-brand-gradient-text`; do not repeat the gradient elsewhere in nav.
- User menu: two-line user card with a kebab menu using popover shadow; destructive menu items use danger styling.
- Top bar: 56px blurred white header. Detail routes show a back link to the parent collection; page-level CTAs go in the `actionSlot`.
- Main content: scrolls inside the shell, with `p-6 lg:p-8` and a skip link targeting `main#main-content`.

### PageHeader

Use `components/ui/PageHeader.tsx` on authenticated pages instead of hand-rolled title blocks. It provides:

- Optional uppercase eyebrow.
- One compact h1 using `.v2-text-h1`.
- Optional subtitle using `.v2-text-body`.
- Right-side actions that wrap on narrow viewports.

Do not use marketing hero typography for normal authenticated pages.

### Buttons

Primary (`Button` `variant="primary"`):
- `bg-[var(--v2-brand)] text-white hover:bg-[var(--v2-brand-strong)]`
- `shadow-[var(--v2-shadow-button)]`
- focus ring: `ring-2 ring-[var(--v2-brand)]/30 ring-offset-2`
- Three sizes: `sm` (h‑9), `md` (h‑10), `lg` (h‑11)
- Trailing arrow icon optional, slides 2px on hover via wrapper `group-hover:gap-2`

Ghost (`variant="ghost"`):
- `bg-white text-[var(--v2-ink)] border border-[var(--v2-border-strong)] hover:bg-[var(--v2-surface)]`
- Same sizes, same focus ring

White‑on‑brand (used inside dark CTA band):
- `bg-white text-[var(--v2-ink)] hover:bg-white/95` for primary
- `bg-white/10 text-white border border-white/20 backdrop-blur` for secondary

**No gradient buttons. No glow shadows.**

### Cards (`Card`)

`bg-white border border-[var(--v2-border)] rounded-[10px] shadow-[var(--v2-shadow-card)]`. Padding by use: `p-7` standard, `p-5` compact, `p-7 md:p-10` hero‑adjacent.

Interactive cards (linked) add hover lift — see Shadows above.

`Card` supports `elevation="flat" | "raised"` and `hover={false}`. Use `raised` only for prominent page anchors, and keep nested or data-dense cards flat.

### Inputs

Use `components/ui/Input.tsx` for product forms. Inputs have visible borders, token focus rings, and support:

- `leftIcon` for search, token, or address context.
- `rightAction` for field-local affordances such as `MaxButton` and `PasteButton`.
- `invalid` and `helperText` for inline validation.

Amount fields should use `.v2-tabular`. Paste handlers should trim pasted whitespace. Do not rely on toast alone for validation; field errors belong next to the field.

### Skeletons

Use `components/ui/Skeleton.tsx` instead of inline `animate-pulse` divs. The primitive is caller-sized; choose `variant="text"`, `variant="rect"`, or `variant="circle"` for radius only. Loading containers that replace meaningful content should use `role="status"`, `aria-busy="true"`, and `aria-live="polite"` around the skeletons.

### Toasts

Use `ToastProvider`, `Toaster`, and `useToast()` for short feedback after user actions such as copy, save, send, or retry. Toasts:

- Auto-dismiss after 4 seconds and cap at 5 visible messages.
- Use polite live regions for info/success and assertive live regions for errors.
- Supplement the screen state; they do not replace inline error, loading, or success content when the user needs to act.

### Tooltips

Use `components/ui/Tooltip.tsx` for brief hover/focus clarification and for revealing truncated technical values. Tooltips are portaled and use popover shadow.

Tooltips must not hide essential instructions, money/risk information, or the only copy of a raw address that the user must copy. If the value is required to complete the task, show it inline.

### Transaction tables

Use `components/transactions/TransactionsTable.tsx` for full transaction history routes. It is a semantic sortable table:

- Desktop columns: direction icon, Activity, Initiator, From/To, Date, Amount, external link.
- Sticky header on desktop.
- Mobile hides secondary columns and keeps icon, activity, amount, and external link readable.
- Date and Amount are sortable; amount sorting uses the raw transaction value, never the formatted display string.
- Empty state renders inside the table with the correct column span.

Use `TransactionActivityRow` or `AgentActivityRow` for compact dashboard, account detail, or agent detail previews.

### Sections (`Section`)

Standard rhythm:
1. Eyebrow — `text-[12px] font-medium tracking-tight text-[var(--v2-brand)]`
2. h2 — see typography
3. Lede — `text-[16px] leading-relaxed text-[var(--v2-ink-2)]`, max‑width ~520px

Sections alternate background:
- Default: white (`--v2-bg`)
- Surface band: `bg-[var(--v2-surface)] border-t border-[var(--v2-border)]`
- Color band: see below

### Hero (light section)

Anatomy on every marketing page:
1. **`HeroBackdrop`** — soft mesh of four blurred radial blobs (indigo, pink, cyan, amber) at ~0.3‑0.5 opacity, plus a fine dotted grid masked to fade out. Set `position: absolute inset-0` inside a `relative overflow-hidden` section. Hero content wrapper must be `relative` so it sits above.
2. **Eyebrow pill** — `border border-[var(--v2-border)] bg-white/80 backdrop-blur`, with a pulsing brand dot.
3. **Headline** — see typography. **One** phrase highlighted with the brand gradient (`bg-clip-text text-transparent`). Period after the gradient is plain ink. Line break with `<br />` for rhythm.
4. **Lede** — short, ≤ 2 sentences.
5. **CTA pair** — primary + ghost.
6. **Optional right column** — flow card (homepage) or omitted (subpages).

### Color band (dark indigo, used sparingly)

Used for **one** mid‑page section per long page (currently the homepage Agent rules band) and the **bottom CTA**. Recipe:

```css
background:
  radial-gradient(ellipse 80% 60% at 20% 0%, rgba(124,58,237,0.55) 0%, transparent 60%),
  radial-gradient(ellipse 70% 70% at 100% 100%, rgba(236,72,153,0.45) 0%, transparent 55%),
  linear-gradient(180deg, #1e1b4b 0%, #2e2a78 100%);
```

Plus a low‑opacity dotted texture masked from the centre. White text, eyebrow in `text-pink-300`, secondary text `text-white/75`. Metric tiles use `bg-white/[0.04]` with `gap-px` on a `bg-white/10` parent for hairline grid lines.

**Bottom CTA band variant** is a brighter brand gradient (`#4f46e5 → #4338ca` with a pink wash) — bolder, used only for the conversion ask.

**Limit:** at most one mid‑page color band + the bottom CTA band per page. Don't bookend or sandwich.

### Code blocks (`CodeBlock`)

Dark code on light page (Stripe pattern). `bg-[var(--v2-surface-code)]` (#0b1120), white/90 text, `font-mono text-[13px] leading-[1.65]`. Optional header with filename + language tag.

### Flow card (`FlowCard`, homepage hero)

Animated, cycling state machine showing one payment lifecycle (Intent → Policy → Settled). CSS‑only animation, no framer‑motion. Soft brand glow behind shifts to green when settled. Includes status pill in footer with brand pulse → success. Pattern is reusable for other "live" demos in the app.

### Step list (`StepList`)

3‑column grid on desktop, hairline `gap-px` on `bg-[var(--v2-border)]` parent (faux dividers via background bleed‑through). Number in brand color, title in ink, body in ink‑2.

---

## 4. Motion

- **No entrance animations on first paint.** Respect `prefers-reduced-motion`.
- **Allowed:** hover transitions (≤200ms), toast enter/exit transitions, the cycling flow card on the homepage hero, the pulsing brand dot in eyebrow pills and "live" indicators, hover lift on cards.
- **Banned:** staggered fade‑ups, page‑level animated blobs, shimmer on text, parallax.

---

## 5. Iconography

- 14 / 16 / 20 px exactly (matches v1 rule).
- Inline SVGs, `stroke-width="1.5"` for line icons, currentColor.
- No emoji in product UI or marketing.
- Arrow chevrons (`→`) drawn in SVG, not unicode, so they animate consistently.

---

## 6. Vocabulary, voice, accessibility

**Authoritative copy source: `docs/UX_COPY_GUIDELINES.md`.** Read it before writing any user‑facing string — landing page, onboarding, dashboard, error message, anything.

It supersedes the terminology table in `docs/UX_GUIDELINES.md` section 1 and the voice rules in section 6. Where the two conflict, **the copy guidelines win.** Specifically:

| Old (UX_GUIDELINES.md) | New (UX_COPY_GUIDELINES.md) |
|---|---|
| "Account" / "Safe smart account" | **"Haven account"** (and "Haven wallet" for funds) |
| "Signing wallet" | **"Sign‑in method"** in onboarding; "your wallet" elsewhere |
| "Policy" / "Policy engine" / "Spending policy" | **"Agent rules"** or **"Agent budget"** in product surfaces; "spending policies" only in advanced/dev contexts |
| "Generate credentials" / "Hand the credential" | **"Connect your agent"**; "Add your Haven credential to your agent" |
| "Allowance module" / "Session key" | **"Rules"** / **"Haven credential"** |
| "Smart account" / "Smart wallet" | **"Haven account"** / **"Haven wallet"** |
| "Safe deployed" | **"Your Haven account is ready"** |
| "Owner" / "Signer" / "Enroll signer" | **"Approve actions"** / **"Sign‑in method"** / **"Save your sign‑in method"** |
| "Relayer", "Metadata" | **avoid mentioning** |

What survives unchanged from `UX_GUIDELINES.md`: the **product doctrine** (section 0), **information architecture** rules (section 2 — collection routes, no dead ends), **accessibility** (section 7), and the **voice principles** that don't conflict (sentences not jargon, no exclamation marks, no emoji in product UI, error copy is the user's friend).

Tonally: marketing copy can be **slightly more inviting** to match the more energetic visual; product UI stays quiet. Confidence over over‑explanation. Lead with the user outcome, not the infrastructure.

**Voice exception flagged in the copy guidelines:** Haven *is* built on Safe and on smart‑account infrastructure. The technical disclosure surfaces (account details, transaction details, advanced settings, developer documentation) can use the technical terms — `Safe`, `passkey-backed signer`, `module`, `relayer`, `transaction hash`. But the default surface is product‑facing.

Accessibility expectations for production primitives:

- Modals use `role="dialog"`, `aria-modal="true"`, labelled titles, Escape handling, focus trap, and focus return.
- Toasts use polite or assertive live regions depending on tone.
- Tooltip triggers are keyboard focusable when the tooltip is needed for non-mouse users.
- Loading regions that replace content use `role="status"`, `aria-busy`, and `aria-live`.
- The authenticated shell includes a skip link to `main#main-content`.

---

## 7. Where things live

| Concern | Production location |
|---|---|
| Tokens | CSS vars in `packages/frontend/src/app/globals.css` at `:root`; core aliases in `packages/frontend/tailwind.config.js` |
| Header/Footer | `packages/frontend/src/components/marketing/SiteHeader.tsx`, `SiteFooter.tsx` |
| UI primitives | `packages/frontend/src/components/ui/Button.tsx`, `Card.tsx`, `CodeBlock.tsx`, `Input.tsx`, `Modal.tsx`, `PageHeader.tsx`, `Skeleton.tsx`, `Toast.tsx`, `Tooltip.tsx` |
| Marketing components | `packages/frontend/src/components/marketing/Section.tsx`, `StepList.tsx`, `HeroBackdrop.tsx`, `FlowCard.tsx`, `ProtocolPlayground.tsx` |
| Marketing pages | `packages/frontend/src/app/page.tsx`, `app/how-it-works/page.tsx`, `app/protocols/*/page.tsx` |
| Authenticated shell | `packages/frontend/src/components/sidebar/Sidebar.tsx`, `packages/frontend/src/components/TopBar.tsx`, authenticated routes under `packages/frontend/src/app/(authenticated)` |
| Live product reference | `packages/frontend/src/app/(authenticated)/design-system/page.tsx` |
| App entity cards | `packages/frontend/src/components/ui/entityCardStyles.ts` shared by Accounts and Agents |
| App modals | `packages/frontend/src/components/ui/Modal.tsx` plus Send, Receive, Add funds, and agent modals in `packages/frontend/src/components` |
| Agent activity rows | `packages/frontend/src/components/haven/AgentActivityRow.tsx` |
| Transaction previews | `packages/frontend/src/components/haven/TransactionActivityRow.tsx`, `packages/frontend/src/components/haven/AgentActivityRow.tsx` |
| Full transaction history | `packages/frontend/src/components/transactions/TransactionsTable.tsx` |

The handoff plan in `docs/design_system/REDESIGN_HANDOFF.md` is now project history.

---

## 8. App Migration Mapping

The authenticated app has migrated from the old dark surface system onto the light v2 tokens. Use this mapping when cleaning up old surfaces or reviewing older branches:

| Old dark token/class | Light v2 target | Notes |
|---|---|---|
| `bg-[#0a0a0a]` | `bg-bg` | Main app background |
| `bg-[#111113]`, `bg-[#121216]`, `bg-white/[0.02]` | `bg-white` or `bg-surface` | Use white for cards/panels; use surface for page bands and nested areas |
| `bg-white/[0.04]`, `bg-white/[0.06]` | `bg-surface-2` or `bg-brand-soft` | Use `brand-soft` only for selected/active states |
| `border-white/[0.06]` | `border-border` | Default card, row, and shell dividers |
| `border-white/[0.08]`, `border-white/[0.10]` | `border-border-strong` | Hover/focus or stronger panel boundaries |
| `text-[#ededed]`, `text-zinc-100`, `text-zinc-200`, `text-zinc-300` | `text-ink` | Primary headings and readable body text |
| `text-zinc-400` | `text-ink-2` | Secondary text |
| `text-zinc-500`, `text-zinc-600`, `text-zinc-700` | `text-ink-3` | Tertiary, captions, disabled text |
| `bg-gradient-to-r from-indigo-500 to-violet-600` | `bg-brand` | App buttons use solid brand, not gradients |
| `shadow-black/*` | `shadow-modal` or `shadow-card` | Use token shadows rather than black glow |

Semantic colors keep their meaning: emerald/success, amber/warning, red/danger. Prefer the v2 semantic tokens (`success`, `warning`, `danger`) for new work.
