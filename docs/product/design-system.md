---
owner: "@d-hinders"
status: current
covers:
  - packages/frontend/src/app/globals.css
  - packages/frontend/tailwind.config.js
  - packages/frontend/src/components/ui/**
  - packages/frontend/src/app/layout.tsx
  - packages/frontend/src/app/page.tsx
  - packages/frontend/src/app/how-it-works/**
  - packages/frontend/src/app/protocols/**
  - packages/frontend/src/app/(authenticated)/design-system/**
  - packages/frontend/src/components/marketing/**
  - packages/frontend/src/components/sidebar/**
  - packages/frontend/src/components/TopBar.tsx
  - packages/frontend/src/components/haven/TransactionActivityRow.tsx
  - packages/frontend/src/components/haven/TransactionMovement.tsx
  - packages/frontend/src/components/transactions/**
last-verified: "2026-08-22" # #1708: the documented primary/ghost focus ring was the dead arbitrary-value form; re-read against globals.css + tailwind.config.js and corrected, plus a new "Opacity on a token colour" rule. Token tables and the rest of the body NOT re-verified in this pass. # #1726: Buttons § gains the Tap targets rule — sm/md extend an invisible 44px hit area rather than raising h-9/h-10; the rest of § Buttons re-read and still accurate # #1749: new "Layering (z-index)" § under Tokens — the shell's stacking order is now a named scale in globals.css, and the mobile nav overlay deliberately outranks the chrome. Only § Tokens re-verified in this pass # #1766: § Buttons' Tap targets rule gains "the rule outlives the primitive" — the mobile sidebar toggle borrows the ::after mechanism as a non-Button, growing in both axes because an icon-only square has no long axis, and must not take `relative`. § Buttons re-read against Button.tsx and sidebar/Sidebar.tsx; nothing else re-verified in this pass # #1741/#1746: new "Focus rings" § under Accessibility — one treatment (focus-visible: + ring-2 + /80), the measured 3:1 rationale, and the dark-fill rule that a brand ring can never satisfy. § Buttons focus-ring line corrected to the shipped value and the § Inputs "one family … same focus ring" claim re-read against Input/Select/Textarea/Checkbox — it is now TRUE, having been false since the two families diverged. Nothing else re-verified in this pass
---

# Haven Design System

This is the source of truth for Haven's current light visual language. Companion to the product UX guide (`docs/product/README.md`, which documents product doctrine, vocabulary, and IA — those rules **still apply**). If older docs mention a dark app surface system, **this document supersedes them**.

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
| `--v2-ink-3` | `#5d6c85` | Tertiary text, eyebrows, captions — AA-safe (≥4.5:1) on white and all tinted surfaces |
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
| `--v2-success` | `#047857` | `--v2-success-soft` `#ecfdf5` | Settled, confirmed, incoming |
| `--v2-debit` | `#0369a1` | `--v2-debit-soft` `#f0f9ff` | Outgoing / sent money (sibling to success; never a warning) |
| `--v2-warning` | `#b54708` | `--v2-warning-soft` `#fef3c7` | 402 Payment Required, pending review |
| `--v2-danger` | `#b42318` | `--v2-danger-soft` `#fef2f2` | Failed, destructive |

Same rule as v1: **never repurpose a semantic color**.

**Contrast guarantee:** every ink and semantic text token meets WCAG AA (≥4.5:1) against white, its own `-soft` background, and the tinted surfaces (`--v2-surface`, `--v2-surface-2`, hover). Guarded by `packages/frontend/src/__tests__/token-contrast.test.ts` — if you change a token, that test tells you whether it still clears the bar.

### Opacity on a token colour ([#1708](https://github.com/d-hinders/Haven-AI/issues/1708))

**Want a token at partial opacity? Use the Tailwind alias, never the arbitrary
value.** `ring-brand/80`, `border-danger/40`, `bg-warning/10` — not
`ring-[var(--v2-brand)]/80`.

The arbitrary-value form does not merely look worse; it **compiles to nothing**.
Tailwind cannot re-compose a colour whose value is a bare `var()`, so it drops
the utility from the output with no error, no warning and no class. That is how
68 focus rings across 39 files spent months setting a ring *width* with no ring
*colour*, leaving `--tw-ring-color` at Tailwind's preflight default and
rendering blue-500/50 instead of brand indigo.

The mechanism: every `--v2-<name>: #RRGGBB` above is paired with a channel form
`--v2-<name>-rgb: R G B`, and `tailwind.config.js` reads the channels through an
`<alpha-value>` placeholder. One theme entry then serves both the solid
(`bg-brand`) and the translucent (`ring-brand/80`) use. Two rules follow, and
`src/__tests__/design-token-alpha.test.ts` enforces both against the **compiled
CSS** — source-level checking cannot see this defect, which is the whole reason
it survived 68 call-sites:

- adding a colour means adding **both** forms — the hex stays, because the
  contrast guarantee above is checked by parsing those hex values;
- a theme colour is never a bare `var()`.

A solid arbitrary value with **no** opacity modifier — `bg-[var(--v2-brand)]`,
`text-[var(--v2-ink-2)]` — is still fine and still used widely.

### Chain identity

`--v2-chain-*` (Base, Gnosis, testnet, plus `NetworkPill`'s sky/amber soft-pill scale) tells networks apart in `NetworkPill` and `NetworkSwitcher`. These are **identity** colours — deliberately outside the semantic rule above. Never reuse a chain colour to carry success/warning meaning, and never route money tone through them. Live swatches on `/design-system` → "Colour tokens".

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

### Layering (z-index) ([#1749](https://github.com/d-hinders/Haven-AI/issues/1749))

Every stacking layer has a named token. **Reach for a token, never a fresh number.**

```css
--v2-z-content:        10;   /* in-flow overlaps: badges, gradient washes */
--v2-z-sticky:         20;   /* sticky table headers */
--v2-z-chrome:        100;   /* TopBar */
--v2-z-chrome-popover: 110;  /* popovers anchored in the chrome */
--v2-z-nav-scrim:     130;   /* mobile drawer scrim */
--v2-z-nav-drawer:    140;   /* mobile drawer */
--v2-z-nav-toggle:    150;   /* the Open / Close sidebar toggle */
--v2-z-modal:         200;   /* Modal, SidePanel */
--v2-z-tooltip:       210;
--v2-z-panel:         250;   /* AgentPanel */
--v2-z-toast:        9999;   /* Toast, skip-to-content link */
```

The rule the numbers encode: **the mobile navigation overlay outranks the app chrome it slides over, and modals outrank the navigation.** The drawer is `inset-y-0`, so its own logo band shares the top 56px with the bar, and its scrim exists to dim everything behind it — the bar included. Let the bar win and the drawer is decapitated, the scrim dims all but the top strip, and the toggle (which sits *inside* that strip by design, in the gap the bar reserves for it) cannot be tapped at all. That was #1749: a `z-[100]` header and a `z-[60]` toggle chosen independently in different files left mobile primary navigation unopenable on every authenticated route.

Tiers are spaced by 10 so a new layer lands between two without renumbering. Adding a layer means picking the tier it belongs to; if none fits, add one to the scale first. A raw `z-[…]` in a shell component is the failure this scale prevents — `src/__tests__/z-index-scale.test.ts` fails on one, and on any inversion of the order above.

That test reads source, so it cannot see stacking contexts or hit-testing. `e2e/mobile-nav-layering.spec.ts` is the half that can: it drives a real engine at four widths below `lg` and asserts `document.elementFromPoint` at the toggle's centre returns the toggle.

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
- focus ring: `focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2` — the one treatment, see *Focus rings* below
- Three sizes: `sm` (h‑9), `md` (h‑10), `lg` (h‑11)
- Trailing arrow icon optional, slides 2px on hover via wrapper `group-hover:gap-2`

Ghost (`variant="ghost"`):
- `bg-white text-[var(--v2-ink)] border border-[var(--v2-border-strong)] hover:bg-[var(--v2-surface)]`
- Same sizes, same focus ring

White‑on‑brand (used inside dark CTA band):
- `bg-white text-[var(--v2-ink)] hover:bg-white/95` for primary
- `bg-white/10 text-white border border-white/20 backdrop-blur` for secondary

**No gradient buttons. No glow shadows.**

**Tap targets ([#1726](https://github.com/d-hinders/Haven-AI/issues/1726)).** `sm` paints
36px tall and `md` 40px — both under the ~44px usually cited as comfortable for touch.
(Not an accessibility failure: WCAG 2.2 AA *Target Size (Minimum)* floors at 24px. It is
mis-tap rate, and it bites hardest in row lists of destructive actions.) `Button` closes
the gap without moving any pixels: `sm` and `md` carry a transparent pseudo-element that
extends the **hit area** to 44px while the button still renders at its declared height.
`lg` is already 44px and carries nothing.

Consequences worth knowing:

- **Do not "fix" this by raising `h-9`/`h-10`.** The compact sizes are compact on purpose
  — tables, toolbars and row lists chose them for density — and changing them moves the
  rhythm of every one of those surfaces and invalidates the `/design-system` baselines.
- **The target grows vertically only.** An `sm` button's width already clears 44px at real
  call sites; growing it sideways would let a button in a `gap-2` toolbar swallow taps
  meant for its neighbour.
- **Keep at least 8px between stacked controls.** The overhang is 4px per edge on `sm` and
  2px on `md`, so at the 8px (`gap-2`) spacing this system typically uses between stacked
  controls, adjacent targets meet but never overlap. Tighter than that and two buttons
  fight over the same pixels — this is the one new constraint the mechanism introduces.
- Choosing `size` therefore stays a **density** decision, not an ergonomics one.

**The rule outlives the primitive ([#1766](https://github.com/d-hinders/Haven-AI/issues/1766)).**
A control that is not a `Button` inherits none of the above automatically, and the
first one to need it was the mobile sidebar toggle — a hand-rolled 32px square that
#1749 had just made reachable, so an undersized target went from moot to load-bearing
on the entry point to primary navigation. It borrows the same mechanism (transparent
`::after`, paint unchanged) with two deviations worth knowing before you copy it:

- **An icon-only square grows in BOTH axes.** "Vertical only" is not the rule; it is a
  consequence of a labelled `sm` Button's width already clearing 44px. A 32px square
  has no long axis, so the overlay is `h-11 w-11` and centred on both. What still
  applies is the *reason* behind the original rule — check what the widened target now
  reaches, in **both** states the control has. For the toggle, closed: right box edge
  x=54, nearest interactive control (`NetworkSwitcher`) at x=68, 14px of clearance.
  Open: the target floats over the drawer's own logo band, which it already did at 32px
  — what is asserted there is that the logo link is still reachable at its centre, not
  that nothing overlaps. Both are pinned in `e2e/mobile-nav-tap-target.mobile.spec.ts`.
- **Do not add `relative` to an already-positioned element.** `Button` needs it because
  it is static. A `fixed` or `absolute` control is already a positioning context, and
  adding `relative` un-fixes it — on the toggle that shifts the whole app shell 32px
  and drops the control back under `TopBar`, which was #1749. Do not take this on the
  prose's word: it is a claim about which of two same-property utilities the cascade
  keeps, so it is pinned by a test rather than by this paragraph —
  `e2e/mobile-nav-tap-target.mobile.spec.ts` asserts `header.left === 0` as an absolute
  anchor, and that assertion exists **because** the mutation passed three other mobile
  specs first.

**Prove it rendered, not in the class string.** A pseudo-element overlay has several
silent no-op failure modes (a clipping ancestor, a positioning context resolving
elsewhere, another element winning the band), and none of them exist in jsdom — which
has no layout, no stacking contexts and no hit-testing. Measure the hit rectangle by
walking `elementFromPoint` outward from the centre in a real engine; `getBoundingClientRect`
returns the border box and reports 32×32 even when the overlay works perfectly.

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

`Input`, `Select`, `Textarea` and `Checkbox` are **one family**: same radius, surface, padding, focus ring, and `invalid`/`disabled` treatment, so a mixed form row aligns and nothing looks bolted on. Reach for the primitive — a hand-rolled control drifts from the family the moment either side changes, which is what [#1410](https://github.com/d-hinders/Haven-AI/issues/1410) had to undo.

### Textarea

Use `components/ui/Textarea.tsx` for multi-line fields — the `Input` half of the family, with the same `invalid` and `helperText` support. `resize-none` by default (dialog fields should not grow under the user); pass `className="resize-y"` where growing is genuinely wanted.

### Checkbox

Use `components/ui/Checkbox.tsx`. Every checkbox in Haven is a box **plus an explanation**, so the primitive owns the `flex items-start gap-2` label row and takes a required `label` (plus optional `helperText` for a consequence on a second line). Pass `className` for the row's own typography or surface.

It is the **native** control with `accent-color`, not a custom-painted box: keyboard behaviour, focus ring and screen-reader semantics come from the platform rather than being re-earned. The wrapping `<label>` gives implicit association, so the text is a click target with no `id`/`htmlFor` wiring at the call site — do not re-add one.

One limit worth knowing before you reach for it: no ref is forwarded, so `indeterminate` — a DOM property rather than an attribute — is out of reach. Every checkbox in Haven is a single confirmation, so nothing needs it; add `forwardRef` when a real tri-state (a select-all header, say) actually arrives.

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

Use `TransactionActivityRow` for compact dashboard, account detail, or agent detail previews.

A collapsing table like this one has to **fit** at mobile widths, not scroll: the `overflow-x-auto` wrapper the `Table` primitive recommends for dense admin tables is mutually exclusive with `Table.Head sticky`, because `overflow-x: auto` forces the computed `overflow-y` to `auto` and the wrapper then becomes the sticky scroll ancestor. When such a table overflows, the cause is usually a `truncate`d cell — `truncate` is `white-space: nowrap`, and an auto-layout column can never be narrower than its min-content, so the untruncated text widens the table instead of ellipsising. Put `max-w-0` on the one flexible cell. Both findings, with their measured numbers, live in `components/ui/Table.tsx`'s docstring ([#1772](https://github.com/d-hinders/Haven-AI/issues/1772)).

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

- One family: **lucide-react**, rendered through the shared `Icon` wrapper (`components/ui/Icon.tsx`) — never a hand-rolled inline `<svg>`. Exemptions: brand marks in `components/brand` and marketing pages.
- 14 / 16 / 20 px exactly (matches v1 rule); size via className (`h-4 w-4`) or the wrapper's numeric `size` prop.
- `stroke-width` 1.5 everywhere, currentColor. Overrides require a call-site comment (see `/design-system` → Icons).
- Decorative by default (`aria-hidden`); pass `label` only when the icon is the sole carrier of meaning.
- No emoji in product UI or marketing.
- Arrow chevrons (`→`) come from lucide, not unicode, so they animate consistently.

---

## 6. Vocabulary, voice, accessibility

**Authoritative copy source: `docs/product/copy-guidelines.md`.** Read it before writing any user‑facing string — landing page, onboarding, dashboard, error message, anything.

It supersedes the terminology table in `docs/product/README.md` section 1 and the voice rules in section 6. Where the two conflict, **the copy guidelines win.** Specifically:

| Old (product/README.md) | New (copy-guidelines.md) |
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

What survives unchanged from `docs/product/README.md`: the **product doctrine** (section 0), **information architecture** rules (section 2 — collection routes, no dead ends), **accessibility** (section 7), and the **voice principles** that don't conflict (sentences not jargon, no exclamation marks, no emoji in product UI, error copy is the user's friend).

Tonally: marketing copy can be **slightly more inviting** to match the more energetic visual; product UI stays quiet. Confidence over over‑explanation. Lead with the user outcome, not the infrastructure.

**Voice exception flagged in the copy guidelines:** Haven *is* built on Safe and on smart‑account infrastructure. The technical disclosure surfaces (account details, transaction details, advanced settings, developer documentation) can use the technical terms — `Safe`, `passkey-backed signer`, `module`, `relayer`, `transaction hash`. But the default surface is product‑facing.

Accessibility expectations for production primitives:

- Modals use `role="dialog"`, `aria-modal="true"`, labelled titles, Escape handling, focus trap, and focus return.
- Toasts use polite or assertive live regions depending on tone.
- Tooltip triggers are keyboard focusable when the tooltip is needed for non-mouse users.
- Loading regions that replace content use `role="status"`, `aria-busy`, and `aria-live`.
- The authenticated shell includes a skip link to `main#main-content`.

### Focus rings

There is **one** focus-ring treatment ([#1746](https://github.com/d-hinders/Haven-AI/issues/1746)):

```
focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-<tone>/80
```

Three parts, each decided rather than inherited:

- **`focus-visible:`, never `focus:`.** Form fields used to fire on mouse click
  as well. Switching them costs nothing, and that was **measured in a real
  browser rather than reasoned from the selector name**: in Chromium a
  mouse-clicked `<input>`, `<textarea>` *and* `<select>` all match
  `:focus-visible` and keep their ring, because the heuristic covers any control
  that accepts keyboard input once focused — not only text entry. A
  mouse-clicked `<button>`, measured the same way on the same page, does **not**
  match and shows no ring, which is both the desired behaviour and the control
  that proves the others were not a stuck keyboard modality. The heuristic is
  UA-defined, so a browser that declined to match on a clicked select would only
  drop a ring on mouse click — never a keyboard regression.
- **`ring-2`, and `/80` opacity.** `/80` is the lowest 10%-step alpha at which
  every ring/background pair in the product clears WCAG's **3:1** non-text
  contrast bar ([1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast),
  [2.4.11](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance)). The
  binding pair is `ring-success` on `--v2-success-soft`: 2.99:1 at `/70`, 3.58:1
  at `/80`. The old values were far under — `ring-brand/30` is **1.60:1** on
  white and the form family's `/20` was **1.36:1**
  ([#1741](https://github.com/d-hinders/Haven-AI/issues/1741)).
- **Tone follows the surface, not the brand.** On a light surface the ring is
  `brand` (or `danger` on a destructive control). **On a dark fill it is
  `white`** — brand indigo reaches only 2.99:1 on `--v2-surface-code` and 2.58:1
  on `--v2-ink` at *full* opacity, so no alpha can rescue it. That is why
  `CodeBlock`'s copy button and the shell's skip-link pill use `ring-white/80`.

**Offset is contextual, its size is not.** Use `focus-visible:ring-offset-2
focus-visible:ring-offset-[var(--v2-bg)]` whenever the ring would otherwise abut
the control's *own* fill — on a brand-filled button an un-offset brand ring
composites brand-over-brand and measures ~1.0:1, i.e. invisible at any opacity.
Full-bleed rows use `ring-inset` instead, because an outset ring would be
clipped. Where an offset is used at all it is always `-2`.

`Input`, `Select`, `Textarea` and `Checkbox` share this ring, so the "one family"
claim under *Inputs* is now true on focus ring as well as on radius and padding.

`src/__tests__/focus-ring.test.ts` enforces all of the above against the
**compiled** CSS and re-derives every ratio from `globals.css` — a class-string
check cannot see a ring that compiles to nothing, which is how both
`ring-[var(--v2-brand)]/30` (#1708) and `ring-current/30` (#1741) rendered
Tailwind's default blue for months.

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
| Agent & transaction activity rows | `packages/frontend/src/components/haven/TransactionActivityRow.tsx` |
| Transaction previews | `packages/frontend/src/components/haven/TransactionActivityRow.tsx`, `packages/frontend/src/components/haven/TransactionMovement.tsx` |
| Full transaction history | `packages/frontend/src/components/transactions/TransactionsTable.tsx` |

The handoff plan in `docs/archive/redesign-handoff.md` is now project history.

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

---

## 9. Enforcement

This system is enforced by automated gates (epic [#904](https://github.com/d-hinders/Haven-AI/issues/904)), not just documented. The authoritative process description lives in the [frontend ship-playbook](../contributing/ship-playbooks/frontend.md); in brief:

| Gate | Catches | Posture |
|---|---|---|
| **design-lint** (`npm run design:lint -w packages/frontend`) | Token bypass (raw palette classes, hex colours, micro-fonts) **and** structural bypass (hand-rolled header bands, raw `<table>`/`<svg>`, address slices) | Blocking CI; shrink-only baseline |
| **Visual regression** (`/design-system` snapshot suite) | Unreviewed pixel drift in any shared primitive | Blocking CI; Linux baselines |
| **Design-system coupling** (`npm run design:coupling -w packages/frontend`) | A new `ui/`/`haven/` primitive missing from `/design-system` | **Blocking** on every PR (*Design-system coupling (strict)*, #1023); a sticky comment explains the finding |
| **copy-lint** (`npm run lint:copy`) | Banned multi-word technical terms in user-facing copy | Blocking CI; shrink-only baseline |
| **haven-design-reviewer** | Rendered-UX issues (visual weight, spacing rhythm, states, touch targets) reviewed from the screenshot evidence | Review pass; any finding pauses auto-merge |

Marketing/landing surfaces are exempt from the lint gates (intentionally bespoke); the product app and `/design-system` stay fully gated.

**Escape markers (reviewed exceptions).** One placement rule for the line-scanning gates: put the marker on the offending line **or the line directly above** — `design-lint-disable-line` (design-lint) and `// copy-lint-ignore` (copy-lint) both work either way (shared helper: `scripts/lib/lint-escapes.mjs`). The coupling gate's `// design-system-exempt: <reason>` is different by design — it exempts an *export*, sits as a trailing comment on the export line, and requires the colon + reason. Use escapes sparingly; each one is a standing reviewed exception.
