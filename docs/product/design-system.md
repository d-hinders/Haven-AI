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
last-verified: "2026-08-23" # #1710: § "Opacity on a token colour" — KNOWN_DEAD is now EMPTY and documented as the enforcement rather than an inventory, with the guarded escape hatch; plus a paragraph on why this is NOT also a design-lint rule (that gate scans two dirs and exempts marketing, where two of the dead call-sites lived). Only that § re-verified in this pass. Prior: #1708: the documented primary/ghost focus ring was the dead arbitrary-value form; re-read against globals.css + tailwind.config.js and corrected, plus a new "Opacity on a token colour" rule. Token tables and the rest of the body NOT re-verified in this pass. # #1726: Buttons § gains the Tap targets rule — sm/md extend an invisible 44px hit area rather than raising h-9/h-10; the rest of § Buttons re-read and still accurate # #1749: new "Layering (z-index)" § under Tokens — the shell's stacking order is now a named scale in globals.css, and the mobile nav overlay deliberately outranks the chrome. Only § Tokens re-verified in this pass # #1766: § Buttons' Tap targets rule gains "the rule outlives the primitive" — the mobile sidebar toggle borrows the ::after mechanism as a non-Button, growing in both axes because an icon-only square has no long axis, and must not take `relative`. § Buttons re-read against Button.tsx and sidebar/Sidebar.tsx; nothing else re-verified in this pass # #1741/#1746: new "Focus rings" § under Accessibility — one treatment (focus-visible: + ring-2 + /80), the measured 3:1 rationale, and the dark-fill rule that a brand ring can never satisfy. § Buttons focus-ring line corrected to the shipped value and the § Inputs "one family … same focus ring" claim re-read against Input/Select/Textarea/Checkbox — it is now TRUE, having been false since the two families diverged. Nothing else re-verified in this pass # #1767: § Buttons' Tap targets rule — the toggle is `top-3` (centred in the 56px band); the documented 14px clearance to `NetworkSwitcher` was true only at >=768px, because TopBar's `w-8` spacer was shrinkable and collapsed to 0 on phones, and three bullets now record that, how a neighbour is damaged without moving, and why the concentric `left-6` was measured and rejected. § Buttons re-read against Button.tsx, TopBar.tsx and sidebar/Sidebar.tsx; nothing else re-verified in this pass # #1817/#1809: § Buttons gains the previously undocumented Danger variant and the rule that ring TONE lives per-variant in VARIANT_CLASS while ring GEOMETRY stays in the base string — the co-location is what makes the fill/ring pair checkable at all. § Focus rings' offset paragraph gains the inversion it did not record: fixing a solid control's tone makes its offset MORE load-bearing, not less (danger-on-danger un-offset is 1.00:1, against 1.08:1 when it wrongly wore brand). § Buttons and § Focus rings re-read against Button.tsx and globals.css; the token tables and everything else NOT re-verified in this pass # #1818: § "Opacity on a token colour" gains "The rule is about the OUTPUT, not the shape" — the bare-var() telling was the commonest instance, not the definition; currentColor and an off-scale numeric modifier (`text-white/78`, live on a design-lint-exempt marketing surface) drop identically, and the binding check is the compiled-CSS guard rather than a spelling rule. § Layering gains the nav scrim reusing `v2-modal-backdrop`. Only those two §§ re-verified in this pass. # #1840: § 5 Iconography's arrow rule — the bullet claiming arrows "come from lucide, not unicode" was false against `TransactionMovement.tsx`, which this doc `covers:` by exact path. Replaced by an "### Arrows" sub-section: the marketing/`protocols` exemption now stated as covering the WHOLE section (it sat on bullet 1 only and the arrow rule silently inherited it — 15 arrows live on those surfaces legitimately), a ONE-FILE allowlist, and a check written over the Unicode arrow RANGES rather than a list of spellings. Three review iterations are recorded in the § itself because each fix hid the same hole one level down: false claim -> a punctuation/affordance taxonomy that forbade nothing -> an allowlist whose grep searched only `->`/`&rarr;` and so reported clean on files rendering an up-right arrow. The check's blind spots (numeric character references, string escapes, runtime/i18n data) are stated in the doc, and it was verified from a CLEAN shell after the first version turned out to invoke a tool that was only a shell function locally. All six § 5 bullets re-read against `components/ui/Icon.tsx`, `scripts/design-lint.mjs` (`MARKETING_SURFACES`) and every arrow call site in `app/**` + `components/**`. Two findings recorded rather than fixed, so this § is NOT stamped clean: ten raw arrows across seven gated files remain (#1857, enumerated in the doc, including the shared `Address` primitive), and the "14 / 16 / 20 px exactly" bullet was re-read, MEASURED, and is VERIFIED FALSE — roughly a third of sized call sites are off-scale, with the exact counts and the census script in #1858 rather than here. The bullet now carries that caveat and the issue link INLINE in the body; an earlier draft of this note recorded the finding only here, which is nowhere anyone reads. Nothing outside § 5 re-verified in this pass. # #1857: § 5's Arrows sub-section re-verified by RUNNING its own check, not by reading it — extracted byte-for-byte from this Markdown and run under `env -i` before and after the diff: **15 lines before, 5 after**, which is the acceptance criterion. The ten defects the table used to enumerate are converted (lucide `ExternalLink` in the shared `Address` primitive and on `custody`'s Safe{Wallet} link, `Button`'s existing `trailingIcon` in `AddFundsModal` ×2, lucide `ArrowRight` on the `AccountDetailClient` ×2 / `AccountsOverviewClient` / `SettingsClient` link affordances, and two copy edits on `/design-system` — one of which was the caption advertising `Address`'s `↗` as the pattern). The table is replaced by what the check returns in its CLEAN state (5 lines: the one allowlist entry plus four JSX-comment continuation lines, each named with why it is a false positive) — a documented clean number, so more than 5 is a new defect and fewer than 5 means an expected line moved. Also ANSWERS #1857's open question, which #1840 left open: **the allowlist stays at one file and does not go to zero**, because emptying it would change what `TransactionMovement` renders (a 14px stroked glyph mid-sentence, with no separable icon slot since #1774) rather than clean up a call site — recorded in the body with the reasoning, not just here. `Icon.tsx`, `Button.tsx`'s `trailingIcon`, and the `TransactionActivityRow` / `SendModal` `ExternalLink` precedents re-read. The `14 / 16 / 20 px` bullet's #1858 caveat re-read and still accurate — every icon this pass added is `h-3.5 w-3.5`, on-scale, so it does not grow the 12px cluster. Nothing outside § 5 re-verified in this pass. # #1830: § Buttons — `variant="tertiary"` was the last undocumented variant and is now recorded, with what actually separates it from `ghost` (a box vs. no box; tertiary is the only variant that shifts its TEXT colour on hover, having no border to do that work) and the shipped case where it mattered (`connect-agent/SetupStates.tsx:219` swapped tertiary→ghost because transparent-on-white read as stray bold text mid-checklist). Completeness is anchored to the SOURCE and says so: enumerated from `Button.tsx`'s `Variant` union + `VARIANT_CLASS`, kept in agreement by `Record<Variant, string>` — not from the list being edited. Also corrects two FALSE claims the § had carried for months: `trailingIcon` does NOT "slide 2px on hover via wrapper `group-hover:gap-2`" (`Button` sets no `group`; that class lives on three hand-rolled marketing link affordances), and the danger hover was quoted as `hover:bg-[var(--v2-danger)]/90` — an opacity modifier on a bare `var()`, i.e. the dead form § "Opacity on a token colour" exists to forbid — against the shipped `hover:bg-danger/90`. New "Shared by every variant" block records the base-string axes the § omitted entirely (disabled, transition, `href`→`next/link`, `trailingIcon`'s variant- AND element-independence: 6 anchor + 2 `AddFundsModal` button call sites). White-on-brand relabelled a PATTERN with its off-scale `h-12` and its focus treatment differing across its own three instances (2 of 3 carry no `focus-visible:` at all — filed separately, NOT fixed here); `InvestorButton` and `MaxButton`/`PasteButton` added as patterns. **On the strength of this pass, honestly:** the first draft asserted a line-by-line re-read and still shipped the dead danger class and an "all six `trailingIcon` call sites" claim contradicted by #1857's entry directly above this one — review caught both. So what this entry buys is narrower than a re-read: § Buttons' variant table, shared-state block and pattern catalog are now each backed by a **published command** (variant distribution; hand-copied-base-class catalog, clean output 4) with its blind spots stated, and the pattern catalog is labelled known-partial rather than complete. § Focus rings was read only for consistency with the new pattern entry, NOT re-verified. The Tap-targets and "rule outlives the primitive" bullets inside § Buttons were NOT re-verified. Token tables, § 5 and everything else: untouched and uninspected. # #1858: § 5's "14 / 16 / 20 px exactly" bullet was VERIFIED FALSE by #1840 and is now resolved BOTH ways rather than by bending the code to the doc. Re-derived the census with the balanced-JSX parser against `dev` e206ad88 — 141 call sites, 120 sized, 34 off-scale, **UNCLASSIFIED 0** (the load-bearing figure; the naive `<Icon` line grep gives 110/30 because a `className` two lines below the tag is invisible to it, and that gap is now an assertion in `design-lint.test.ts` rather than a claim). 12 px (19 sites, glyphs in `text-xs`), 24 (48 px medallions) and 28 (56 px medallions) were each a coherent built convention, not drift, and are ADDED to the scale; the 11 genuine outliers — all eight arbitrary values among them — were converted to the nearest rung. New "### Size" sub-section replaces the bullet: a container-keyed table of precedents, an explicit split between what is mechanically enforced (SET MEMBERSHIP) and what is a judgement no gate can make (WHICH RUNG), and a published command with its blind spots, following the Arrows precedent. § 9 gains the `icon-size` design-lint row and the note that `tsc` now carries half the rule (`IconSize`). Also fixed a leak the gate structurally cannot see: `agent-panel/agent-display.tsx`'s `BotIcon` was threading 15/17/24 into `<Icon size>` past a rule that only reads `<Icon>` elements — closed by typing its prop `IconSize`, which is the honest answer to "can this be enforced in `Icon.tsx`": the `size` half CAN and now is, the `className` half cannot (an opaque string; a runtime check would not gate CI) and lives in design-lint. **Independent review changed three claims in this entry, and they are worth recording because each was the section's own failure mode recurring.** (a) The census figure was 141, not 140: `/design-system` renders its usage EXAMPLE as a string, `{'<Icon icon={Check} className="h-4 w-4" />'}`, and the walk counted it — on-scale today, so invisible, but editing that documentation string to show an off-scale value would have failed CI on a pure doc change, on the page that teaches the rule. Fixed, so 140 sized-and-real, and the original off-scale finding is 34 of 119. (b) The first fix for that was a whole-file string scanner, which is wrong for JSX: bare apostrophes in body text (`its own primitive's home file`, line 183 of that same page) open strings that never close and masked two live call sites — a false NEGATIVE, caught only because the total moved by two. Replaced with a one-character adjacency test that cannot make that mistake. (c) "Every one of the 19 sits in a run of `text-xs`" was checkably FALSE — `NetworkSwitcher.tsx:96` is `text-[13px]`, `ui/Table.tsx:157` a `text-[11px]` header, `FilterBar.tsx:329` `text-sm`. The rung is real; the tidy single-class story about it was not, and it is now stated as the dense-affordance rung with the measured spread. Also from review: the census now actually applies the marketing exemption its own header claimed, the escape marker works beside the SIZE line of a multiline element rather than only beside the tag, a brace inside an attribute string no longer stops an element terminating (a silent drop), and the 12 px row now says plainly that several buttons it cites are below the 44 px tap target it does not change. ONLY § 5 and § 9's enforcement table were re-verified in this pass; the token tables, § Buttons, § Focus rings and everything else were NOT re-read.
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
| `--v2-modal-backdrop` | `rgba(26, 31, 54, 0.66)` | Overlay dim for Modal, SidePanel and the mobile nav scrim — solid, deliberately **no** blur (see § Layering) |

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

#### The rule is about the OUTPUT, not the shape ([#1818](https://github.com/d-hinders/Haven-AI/issues/1818))

"Don't write a bare `var()`" is the commonest instance of this defect, not its
definition. **Tailwind drops any opacity modifier it cannot re-compose**, and it
has now done so in three shapes that have nothing in common at the source level:

| shape | example | why it drops |
|---|---|---|
| bare `var()` colour | `bg-[var(--v2-bg)]/85` | no channels to re-compose |
| `currentColor` | `ring-current/30` | same — `currentColor` has no channels |
| off-scale modifier | `text-white/78` | `78` is not a step on the opacity scale |

The third is the one that matters for how you read this section. It carries no
`var()` at all — the colour is a perfectly ordinary `white` — and it shipped on a
marketing surface that design-lint exempts. Every guard written before it matched
a *shape*, so each new occurrence arrived wearing a shape the previous guard
could not see. `TopBar`'s dead background was found only because a mutation
during unrelated work went green when both renders came out byte-identical.

So the check that binds is not a spelling rule. `src/__tests__/compiled-colour-utilities.test.ts`
reads every opacity-modified colour utility out of the product source, compiles
it through the real `tailwind.config.js`, and asserts a colour declaration came
out — indifferent to which shape the next one wears.

**Its `KNOWN_DEAD` map is now empty, and that is the enforcement**
([#1710](https://github.com/d-hinders/Haven-AI/issues/1710) closed epic
[#1685](https://github.com/d-hinders/Haven-AI/issues/1685)). It began as a
shrink-only inventory of triaged debt — 31 entries across #1709 and #1710 — and
with every one converted the assertion changes character: from "do not grow"
to **there is no such thing as an accepted dead class**. Any opacity-modified
colour utility that compiles to nothing now fails outright, and re-adding a key
to quiet a failure trips a second assertion that the map stays empty. The
escape hatch is guarded rather than merely absent.

**Why this is not also a design-lint rule.** #1710 originally specified one.
Two things ruled it out, both measurable: `design-lint.mjs` scans only
`src/app` and `src/components` while this guard walks all of `src/`, and every
design-lint rule takes `exempt: isMarketingSurface` — so a rule built to
match the other rules' exemptions would have been blind to
`components/marketing/`, where two of the dead call-sites it was meant to catch
actually lived. A text rule also cannot strip comments: in #1709 an explanatory
comment quoting the dead form tripped the very guard explaining it. Compiling
the class settles all three.

Fixes, in preference order: the channel-token alias (`bg-bg/85`), an on-scale
modifier (`/75`), or the arbitrary form when the exact value matters (`/[0.78]`).

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

**One dim treatment for every overlay: `v2-modal-backdrop`** ([#1818](https://github.com/d-hinders/Haven-AI/issues/1818)). `Modal`, `SidePanel` and the mobile nav scrim all use it. It is a solid `--v2-modal-backdrop` fill and it deliberately carries **no `backdrop-filter`** — the reason is written at its definition in `globals.css`: a full-viewport blur makes the compositor hold a GPU snapshot of the whole page and re-blur it on every paint, which on tall pages ballooned VRAM and made the overlay feel sluggish.

The nav scrim was the exception until #1818, and instructively so: it read `bg-[var(--v2-ink)]/40 backdrop-blur-sm`, but the opacity modifier on a bare `var()` compiled to nothing (see § "Opacity on a token colour"), so the scrim painted no background — and a `backdrop-filter` with nothing behind it to composite costs nothing. **The blur was free only by accident.** Fixing the fill would have made it real, on a `fixed inset-0` element, which is precisely the shape the rule above exists to prevent. So the fix reused the shared token rather than reviving a second convention.

The general point, since it will recur: when a dead style rule comes back to life, the classes sitting *next to* it come back to life too. Re-read the whole class string, not just the one being fixed.

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

**`Button` has four variants, and that is the whole set — but read the next sentence before
trusting it.** The four below were enumerated *from the source*, not from this list: the
`Variant` union at the top of `packages/frontend/src/components/ui/Button.tsx` and the
`VARIANT_CLASS` record beneath it, which cannot disagree with each other because
`Record<Variant, string>` makes TypeScript reject a missing or extra key. **That pair is the
authority; this section is a copy of it.** Enumerate from there whenever you need to know
what exists — `danger` went undocumented until
[#1817](https://github.com/d-hinders/Haven-AI/issues/1817) and `tertiary` until
[#1830](https://github.com/d-hinders/Haven-AI/issues/1830), and in both cases the mechanism
was the same: a reader found a plausible-looking list of three, and a list of three is
indistinguishable from a complete one. The compiler will force a new variant into
`VARIANT_CLASS`. Nothing forces it into this document.

**Variant vs. pattern.** Each entry below is labelled. A *variant* is a `variant=` value on
the `Button` primitive. A *pattern* is hand-rolled markup that looks like a button and shares
none of `Button`'s guarantees — sizes, tap target, disabled treatment, or focus ring.

#### Shared by every variant

These live in `Button`'s base class string, so they are variant-independent and stated once
rather than repeated per entry:

- **Three sizes**, `sm` (h‑9 / 36px), `md` (h‑10 / 40px, the default), `lg` (h‑11 / 44px) —
  plus the invisible 44px tap target on `sm` and `md`, see *Tap targets* below.
- **Focus-ring geometry:** `focus-visible:outline-none focus-visible:ring-2
  focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)]` — the one treatment,
  see *Focus rings* below. Ring **tone** is per-variant; see *Ring tone lives with the fill*.
- **Disabled:** `disabled:cursor-not-allowed disabled:opacity-60`. There is no per-variant
  disabled fill — every variant dims to 60% of itself. (Note this is *not* the same
  treatment the field micro-actions use; see *Button-shaped controls that are not `Button`*.)
- **Transition:** `transition-colors duration-150`. Colour only — nothing about a `Button`
  animates its size, position or spacing.
- **`href` turns it into a link.** With `href`, `Button` renders a `next/link` `<a>` (and
  accepts `target` / `rel`) with an identical class string; without it, a `<button>` (with
  `type`, defaulting to `"button"`). Same paint, different element — which matters for focus,
  because a `<button>` does not match `:focus-visible` on mouse click while an `<a>` behaves
  differently again.
- **`trailingIcon`** renders a 14px lucide `ArrowRight` after the label, at the base
  `gap-1.5`. It is available on **every** variant and on **both** elements — six of its eight
  call sites are the marketing `href`/`<a>` form, and two (`AddFundsModal.tsx:123` and
  `:166`) are `onClick` `<button>`s. **It does not animate.**
  (Through #1829 this section claimed the icon "slides 2px on hover via wrapper
  `group-hover:gap-2`". It never did: `Button` sets no `group` class and no call site wraps
  one. `group-hover:gap-2` is real, but it belongs to three hand-rolled marketing link
  affordances — `app/page.tsx:299`, `:320`, `app/protocols/page.tsx:80` — none of which are
  `Button`s. Corrected in #1830.)

#### The four variants

Primary — **variant**, `variant="primary"`, and the default when `variant` is omitted:
- `bg-[var(--v2-brand)] text-white hover:bg-[var(--v2-brand-strong)]`
- `shadow-[var(--v2-shadow-button)]`
- focus ring `focus-visible:ring-brand/80`

Ghost — **variant**, `variant="ghost"`. By a wide margin the most-used variant (see the
distribution note below):
- `bg-white text-[var(--v2-ink)] border border-[var(--v2-border-strong)] hover:bg-[var(--v2-surface)]`
- focus ring `focus-visible:ring-brand/80`

Tertiary — **variant**, `variant="tertiary"`
([#1830](https://github.com/d-hinders/Haven-AI/issues/1830)). The *quiet* action: dismiss,
cancel, "not now" — the escape hatch beside a committing action, never the committing action
itself. Live at eight product call sites plus the `/design-system` showcase — among them
`ConfirmDialog`'s cancel, `ProfileClient`'s cancel edit, `DashboardOnboardingGuide`'s dismiss,
and three in `settings/ManageApprovers`:
- `bg-transparent text-[var(--v2-ink-2)] hover:bg-[var(--v2-surface)] hover:text-[var(--v2-ink)]`
- focus ring `focus-visible:ring-brand/80`

**Tertiary is not a quieter ghost — it is a different shape.** The two are worth
distinguishing explicitly, because "subtle neutral button" describes both and the choice
between them is made wrongly by default. Ghost paints a **box**: a white fill and a
`--v2-border-strong` outline, so at rest it reads as a control. Tertiary paints **no box at
all**: transparent fill, no border, and dimmed `--v2-ink-2` label, so at rest it reads as
text and only resolves into a control on hover — which is also the only variant that shifts
its *text* colour on hover (`ink-2` → `ink`), because it has no border to do that work.

That difference has a shipped consequence, and it is the rule to take from it: **tertiary
needs surrounding structure to be legible as pressable.** It works inside a dialog's action
row or at the end of a card, where position tells you it is a control. It fails in running
content — `connect-agent/SetupStates.tsx:219` records the case where a tertiary button
"rendered as stray bold text in the middle of a checklist rather than a control", and was
changed to ghost for the border alone while keeping secondary weight. Reach for ghost when
the control has to announce itself; tertiary when its context already has.

Danger — **variant**, `variant="danger"`, used for destructive confirmations (the approval
queue's reject, agent revoke/remove, delete contact):
- `bg-[var(--v2-danger)] text-white hover:bg-danger/90 shadow-[var(--v2-shadow-button)]`
- focus ring `focus-visible:ring-danger/80` — its own tone, per *Focus rings* below
- Note the hover is the **semantic token** `bg-danger/90`, not `bg-[var(--v2-danger)]/90`.
  The two look interchangeable and are not: an opacity modifier on a bare `var()` compiles to
  nothing, which is the whole subject of *Opacity on a token colour* above. This section
  quoted the dead form until #1830. The resting fill is safe in arbitrary-value form only
  because it carries **no** alpha modifier; `bg-danger` is defined in `tailwind.config.js`
  and would work there too. The mixed spelling in one class string is the tell — where the
  two forms sit side by side, the one with a modifier is the one that has to be semantic.

**Distribution, with the command that produced it.** Ghost dominates: 111 ghost, 9 tertiary,
6 danger, 2 primary — 128 literal occurrences, from `packages/frontend`:

```bash
grep -rhoE 'variant="(primary|ghost|tertiary|danger)"' src --include='*.tsx' | sort | uniq -c
```

The command is published because it has to be: during review of #1830 two reasonable
counting methods disagreed by roughly a factor of two, and a call-site number without its
command is not reproducible. It misses two things by construction. **`variant` is optional**,
so every unadorned `<Button>` is an uncounted `primary` — which is why primary shows 2 and is
nonetheless the most common button in the product. And it cannot see the three dynamic call
sites (`DashboardClient.tsx:336`, `ConfirmDialog.tsx:52`, `CopyBlock.tsx:39`). The shape of
the distribution is the point, not the integer.

**Ring tone lives with the fill ([#1817](https://github.com/d-hinders/Haven-AI/issues/1817)).**
The ring's *geometry* (`ring-2`, `ring-offset-2`, the offset colour) is uniform and lives in
`Button`'s base class string; its *colour* lives per-variant in `VARIANT_CLASS`, next to the
fill it has to agree with. That is not a stylistic preference — it is what makes the pair
**checkable**. While the colour sat in the base string, `variant="danger"` wore `ring-brand/80`
across four destructive confirmations, and no guard could see it: a per-class-string rule
cannot pair a fill in one declaration with a ring in another. Do not consolidate the three
repeated `ring-brand/80` values back into the base string to deduplicate them.

#### Button-shaped controls that are not `Button`

**This list is derived from a check, and the check is the artifact — not the list.** The
first draft of this section was itself a plausible-looking incomplete catalog, which is the
exact failure the opening paragraph warns about, so the enumeration is a command you can run
rather than a number you have to trust. From `packages/frontend`:

```bash
# Controls that hand-copy Button's base class string.
grep -rn "rounded-md font-medium tracking-tight" src --include='*.tsx' \
  | grep -v 'src/components/ui/Button.tsx'
```

**Clean output today is 4 lines** — `app/page.tsx:372`, `:381`,
`investor-briefing/page.tsx:438`, and the `InvestorButton` helper at
`investor-briefing/page.tsx:551`. More than 4 is a new hand-copy; fewer means one was
converted to `Button` or its class string drifted out of the signature.

**What this check cannot see, stated because a check without its blind spots is just a
number.** It matches only controls that copied the *full* base signature. Button-shaped
controls built from scratch do not appear, and there are at least a dozen: the `MaxButton` /
`PasteButton` micro-actions below, `CodeBlock`'s copy button, `ApprovalNotifications.tsx:133`
(a `next/link` styled as a button, with no `focus-visible:` of its own). **Treat the list
below as known-partial for that class.** Making it complete would need a real lint rule —
something that classifies by rendered role rather than by class-string spelling — and that is
a code change nobody has scoped yet, not a longer paragraph here.

White‑on‑brand — **pattern, not a variant** (used inside the dark CTA band; there is no
`variant="white"`). It is hand-rolled `next/link` / `<a>` markup that copies `Button`'s base
class string by hand:
- `bg-white text-[var(--v2-ink)] hover:bg-white/95` for the leading action
- `bg-white/10 text-white border border-white/20 backdrop-blur` for the trailing one

Three things follow from it being a copy rather than the primitive, and they are the reason
this entry is now labelled:

- **It is off the size scale.** All three instances are `h-12 px-6 text-[15px]` — a fourth
  size that `SIZE_CLASS` does not have. Nothing carries the `sm`/`md` tap-target overlay
  either, though at 48px it does not need one.
- **Its focus treatment is inconsistent between instances.** `investor-briefing/page.tsx:438`
  carries the correct dark-fill ring — `focus-visible:ring-white/80` with
  `focus-visible:ring-offset-[var(--v2-brand)]`, exactly what *Focus rings* prescribes on a
  brand band. The two on the home page (`app/page.tsx:372`, `:381`) carry **no
  `focus-visible:` classes at all** and fall back to the browser's default outline. That is
  an indicator, so it is not a 2.4.7 failure — but it is not this system's ring, and no guard
  catches it: `focus-ring.test.ts` checks that declared rings compile and measure, not that
  every button-shaped control declares one. Tracked separately; do not treat the home-page
  form as the reference.
- **`Button`'s own guarantees do not travel with the class string.** Copying the classes
  copies the paint and nothing else.

`InvestorButton` — **pattern**, `investor-briefing/page.tsx:531-557`, used 3×. A local
mini-`Button`: it re-implements the base string, a two-value `variant` (`primary`/`ghost`)
and a two-value `size` (`sm`/`lg`) by hand. It diverges from `Button` in four ways worth
knowing before copying it — no `md` size, **no `disabled` handling at all**, a bare `<a>`
rather than `next/link`, and a hardcoded `focus-visible:ring-brand/80` that does not follow
the variant. That last one is only correct today because both of its variants are
light-surface; it would be wrong the moment someone added a solid or dark one, which is the
same defect *Ring tone lives with the fill* describes.

Field micro-actions — **pattern**. `MaxButton` and `PasteButton`
(`components/ui/Input.tsx`) are exported `<button>`s that are deliberately not `Button`s:
brand-coloured uppercase text at `px-1.5 py-0.5`, sized to sit inside a field's trailing
slot. They carry the system focus ring (`focus-visible:ring-brand/80`) but a **different
disabled treatment** — `disabled:opacity-40 disabled:pointer-events-none` against `Button`'s
`disabled:opacity-60 disabled:cursor-not-allowed`. Recorded as observed, not endorsed.

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
- **The clearance is only as real as the space the neighbour is standing in
  ([#1767](https://github.com/d-hinders/Haven-AI/issues/1767)).** The 14px above was
  measured at 768px and assumed to hold on a phone. It did not. `TopBar` reserves the
  toggle's room with a `w-8` spacer, and `w-8` on a flex item still carries
  `flex-shrink: 1` — in a row that does not fit, it is the first thing given away. The
  spacer collapsed to **width 0** below about 700px, `NetworkSwitcher` slid left to
  x=36, and the painted toggle sat on top of it with 18px of the chip's own tap area
  inside the invisible overlay. **Reserve space with `shrink-0`, and assert the
  reserved box's measured width** — not just the gap it was supposed to produce.
- **A neighbour can be damaged without moving.** The chip's border box never changed;
  only a walked `elementFromPoint` showed its hit rectangle starting 18px right of it.
  Measure the neighbour the same way you measure the control.
- **Moving the control into the slot is not automatically the fix.** `left-6` would
  make the toggle concentric with the spacer and was rejected on measurement: it cuts
  the clearance above to 6px and pushes the target past the centre of the open
  drawer's own logo link (x=56). A spacer's job is to keep content clear of a floating
  control, not to be concentric with it.
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
- Size: **12 / 14 / 16 / 20 / 24 / 28 px**, square, no arbitrary values — see [Size](#size) below, which is the rule and is gated.
- `stroke-width` 1.5 everywhere, currentColor. Overrides require a call-site comment (see `/design-system` → Icons).
- Decorative by default (`aria-hidden`); pass `label` only when the icon is the sole carrier of meaning.
- No emoji in product UI or marketing.


### Size

**The scale is six values, and they are the six Tailwind steps that express them:**

| px | Class | Where it is used (the built precedent, not a preference) |
|---|---|---|
| 12 | `h-3 w-3` | A glyph in a run of the product's **smallest type** — a disclosure chevron before a `<summary>`, a trailing arrow after a 12 px link label, a copy glyph after a mono address, a sort caret in a table header — and the icon inside the small icon-only affordances that host that type. Mostly `text-xs`, but **not exclusively, and the exception is the point**: `NetworkSwitcher`'s trigger is `text-[13px]`, `Table`'s header is `text-[11px]`, `FilterBar`'s is `text-sm`. Read it as *the dense-affordance rung*, not as a `text-xs` lookup |
| 14 | `h-3.5 w-3.5` | The default beside `text-sm`, and the **block-leading indicator** on a banner or callout (`flex items-start` + `mt-0.5` + `flex-shrink-0`) whatever the body type is — it aligns to the first line's cap height, not to the em box |
| 16 | `h-4 w-4` | Beside `text-base`, and the icon in a **32–36 px tile** (`h-8 w-8` / `h-9 w-9`) |
| 20 | `h-5 w-5` | A standalone icon with no container, and `EmptyState`'s icon slot — which is literally `h-5 w-5` inside a 40 px halo, so a call site that passes anything else is fighting the primitive |
| 24 | `h-6 w-6` | The icon inside a **48 px** (`h-12 w-12`) status medallion |
| 28 | `h-7 w-7` | The icon inside a **56 px** (`h-14 w-14`) status medallion |


**The 12 px row cites buttons that do not meet the 44 px tap target, and that is a debt it inherits rather than endorses.** `haven/Address.tsx:88`/`:90` (a bare `h-5 w-5`), `EditAgentModal.tsx:540` (`h-6 w-6`), and the unsized ones in `SendModal.tsx:627` and `agent-panel/UnmanagedDelegateCard.tsx:72` all host this rung and none carry the invisible `::after` hit area § Buttons requires — that machinery lives on the `Button` primitive and its one documented borrower. Nothing here changes those boxes. Naming it so the table is not read as blessing sub-44 px targets: an icon-only button owes its own tap-target treatment whatever size glyph it holds.

**Always square.** lucide's `viewBox` is `0 0 24 24` with the SVG default `preserveAspectRatio`, so a non-square box does not stretch the glyph — it **letterboxes** it and leaves dead space on the long axis. `h-3 w-5` renders a 12 px arrow in a 20 px-wide hole; it looks like a sizing decision and is actually padding in the wrong place.


**One live case the table does not name:** a diagram connector — a standalone arrow joining two boxes, not inline with type and not inside a container. `InfoModal.tsx`'s `Arrow` is the only instance and it is currently dead code (nothing imports it), so it is recorded rather than given a row: one unrendered call site is not enough to found a precedent on. If a connector ships for real, decide the rung here first.

**Never an arbitrary value.** Every rung above is a first-class Tailwind class, so `h-[13px]` is never *needed* to land on the scale — which is what lets "no arbitrary values" be a rule rather than an inconvenience. `size={16}` on the wrapper is equivalent and equally constrained.

**Why six and not the three this section used to claim.** The old rule said 14/16/20 "exactly" and was [verified false](https://github.com/d-hinders/Haven-AI/issues/1858): 34 of 119 sized call sites were off it. Crucially the discrepancy resolved **both ways**, and assuming the code had to bend to the doc would have destroyed real work:

- **12 px was never drift.** Nineteen call sites, and they are not scattered — every one is a chevron, caret, copy glyph or trailing arrow in the app's densest controls, the great majority of them in a `text-xs` run. Three rungs simply had no step for type that small, so authors took a fourth without the doc admitting it existed. **Stated carefully, because the first draft of this line was checkably false**: "every one sits in `text-xs`" is not true — `NetworkSwitcher.tsx:96` sits in `text-[13px]`, `ui/Table.tsx:157` in a `text-[11px]` header, and `transactions/FilterBar.tsx:329` in `text-sm`. The rung is real; the tidy single-class story about it was not, and replacing a false absolute with the measured spread is the whole habit this section is trying to build.
- **24 and 28 were not drift either.** Four sites, two apiece, and each pair is the icon at half its status medallion (48→24, 56→28). `EmptyState` had independently hard-coded the same ratio — a 20 px slot in a 40 px ring, 16 in a 32 — so "half the container" was already built into a primitive before it was ever written down.
- **Eleven sites WERE drift**, and all eight arbitrary values were among them. They were corrected to the nearest rung: 10→12, 11→12, 13→14 (×3), 17→16, 18→20, 22→20, 22→24, and both non-square pairs→12.

The two 18/22 sites are the clearest case in the set: they are the **same slot in the same file** — two `EmptyState` icons in `AgentPanel.tsx` — at two different wrong numbers, one of them overflowing the 20 px slot the primitive provides. Nothing about a product need produced those; the absence of a check did.

**What is enforced, and what is honestly not.** Be precise here, because this section's history is four rounds of rules that forbade nothing:

- **Enforced, mechanically:** *membership*. `design-lint`'s `icon-size` rule fails any `<Icon>` whose size is not one of the six pairs — off-scale, non-square, single-axis, arbitrary-value, or a literal `size={n}` off the scale. Every one of the eleven defects above was a membership violation, so this catches the whole class that actually occurred.
- **NOT enforced, and not enforceable cheaply:** *which rung*. No gate can know that a chevron belongs at 12 rather than 14. That part is the table above — precedents keyed to the container, so a reviewer and an author can at least argue about the same thing. Saying this plainly is the point: the previous two attempts at this section died by pretending a judgement was a rule.
- **The scale itself is closed.** "Half the container" tells you *which* of the six to use; it cannot mint a seventh. A 64 px medallion does not get a 32 px icon — it gets an edit to this table. That is deliberate, and it is the same posture as the one-file arrow allowlist below.

**Why the gate scans elements, not lines.** A `<Icon>`'s `className` routinely sits two or three lines below the tag, and inside a template literal. A line-based `grep` for `<Icon.*h-\[13px\]` returns **zero** on `AgentPanel.tsx:212`, a real instance — which is exactly how an earlier line-regex census reported 110 sized sites against the true 120. `scanElements` walks brace depth to each element's real `>`. The test asserts both halves: that the gate sees the multiline case, *and* that the line-based form does not.

**Re-derive the distribution; do not cite a number from here.**

```sh
npm run design:lint -w packages/frontend            # the gate: 0 icon-size violations
node packages/frontend/scripts/design-lint.mjs --icons   # the census behind it
```

Clean output of the census today is **`UNCLASSIFIED: 0`** and **`OFF-SCALE: 0`**, over **140** call sites (141 until the walk learned that `/design-system`'s own usage EXAMPLE — `{'<Icon icon={Check} className="h-4 w-4" />'}`, a string — is not a call site). `UNCLASSIFIED` is the load-bearing line, not the totals: a non-zero bucket means a call site was silently dropped and every figure beside it is a guess rather than a measurement. That is the whole reason this section states a rule and ships a command instead of pasting counts, the same as [Arrows](#arrows) below.

**What the gate cannot see** — so a clean run is not over-trusted:

- `size={someVariable}`, and classNames assembled wholly at runtime (2 call sites today);
- a size arriving from a `cva`/lookup table in another file, or threaded in as a `className` prop by a wrapper component. A wrapper threading a **numeric** size is no longer in this list — `IconSize` closes it, and `BotIcon` is the worked example — but a wrapper passing a `className` string still is;
- a usage EXAMPLE written as a string with padding inside the quotes (`{'  <Icon … '}`) is still counted. The rejection test is one character of adjacency, deliberately: a whole-file string scanner is what you reach for first and it is wrong here, because bare apostrophes in JSX body text (`its own primitive's home file`) open strings that never close and mask every element after them — that version silently dropped two live call sites. This blind spot fails **loudly**, on the line, and the escape marker clears it;
- marketing surfaces, which are exempt from every rule in this section by the first bullet — correctly, and unlike the [opacity rule](#opacity-on-a-token-colour-1708), that exemption costs nothing here because no icon rule applies there anyway.

### Arrows

- **The marketing exemption in the first bullet covers this whole section, including these arrow rules.** `components/brand`, `components/marketing`, the landing page, `/protocols`, `/investor-briefing` and `/how-it-works` are intentionally bespoke and exempt from every icon rule here (#874). Fifteen unicode arrows live on those surfaces legitimately and none of the rules below are about them. The authoritative list is `MARKETING_SURFACES` in `packages/frontend/scripts/design-lint.mjs` — read it there; this sentence is a pointer, not a copy.
- **In a gated surface, an arrow that is an affordance comes from lucide.** A control's trailing arrow (`Button`'s `trailingIcon`, which renders lucide `ArrowRight` for you), a list/row chevron, a disclosure marker, anything that animates (`ErrorBoundary`'s `group-open:rotate-90`, `AgentPanel`'s removed-agents toggle). Never a raw glyph — it cannot be rotated, sized on the icon scale, or stroked at 1.5, and it lands wherever the label's typeface puts it rather than where the icon system does.
- **Exactly one gated file may render a raw arrow:** `components/haven/TransactionMovement.tsx`, the `From <a> → To <b>` movement line. The glyph joins two operands the way a colon would — `aria-hidden`, on the text baseline at the run's own size and weight, with the words `From` and `To` carrying the direction. A lucide glyph would sit at a fixed pixel size beside text it must match, and since #1774 it is nested *inside* the `From` half to stop it wrapping alone, so there is no separable icon slot to fill. **Every other raw arrow in a gated surface is a defect**, whatever it is called.

  **Why a one-file allowlist and not a rule of thumb.** This section has now been wrong three times in the same way, and the shape is worth keeping:

  1. It claimed arrows "come from lucide, not unicode" — false against a component it `covers:` by exact path ([#1840](https://github.com/d-hinders/Haven-AI/issues/1840)).
  2. The first fix sorted arrows into "punctuation" vs. "affordance". Review killed it by demonstration: every author of a new arrow can call theirs punctuation, so it forbade nothing.
  3. The second fix added a closed allowlist with a `grep` — but the grep searched `→` and `&rarr;` only, so it reported clean on files rendering `↗`.

  Each version was better and each hid the same hole one level down. The list above **is** the rule; the reasoning is only why that one file is on it. Adding a second entry is a design-system decision, not a call-site one.

  **Check it over the arrow RANGES, not a list of spellings** — an enumeration only ever catches the glyph that already burned you:

  ```sh
  git ls-files packages/frontend/src/app packages/frontend/src/components \
    | grep -E '\.tsx?$' \
    | grep -v -e 'components/brand/' -e 'components/marketing/' -e 'src/app/page.tsx' \
              -e 'src/app/protocols/' -e 'src/app/investor-briefing/' -e 'src/app/how-it-works/' \
    | grep -v -e '__tests__' -e '\.test\.' -e '\.spec\.' \
    | xargs perl -CSD -ne 'print "$ARGV:$.: $_" if /[\x{2190}-\x{21FF}\x{2794}-\x{27BF}\x{27F0}-\x{27FF}\x{2900}-\x{297F}\x{2B00}-\x{2BFF}]|&[a-zA-Z]*arr[a-zA-Z]*;/; close ARGV if eof' \
    | grep -vE ':[0-9]+: *(//|\*|/\*|\{/\*)'
  ```

  The character class covers the Unicode arrow blocks — `→ ← ↑ ↓ ↗ ⇒ ⟶ ➔` and every sibling — and the second alternative covers named entities (`&rarr;`, `&larr;`, `&nearr;`, …).

  **Take each block WHOLE; do not trim it to the codepoints in use.** An earlier draft stopped Miscellaneous Symbols and Arrows at `\x{2B11}`, which covers `⬅ ⬆ ⬇` but not their rightwards mirror `⮕` — Unicode put that one at a disjoint codepoint because no adjacent slot was free. A range trimmed to what exists today reproduces exactly the failure ranges were adopted to fix, and it did so on the *rightwards* arrow, the direction every known defect uses.

  **Why `perl` and not `rg` or a glyph list.** `\x{…}` ranges are explicit and locale-independent, and `perl` is present on macOS and Linux by default. The first draft of this check used `rg`; on the machine that wrote it `rg` was a **shell function**, so pasting the command into a plain shell printed `command not found` — and an empty result reads exactly like a clean one. A check you have not run from a clean shell is not a check.

  **What this check CANNOT see** — state it, so nobody trusts a clean result past its reach:

  - **Numeric character references** — `&#8594;`, `&#x2192;`.
  - **String escapes** — `{'\u2192'}` or a glyph built by concatenation. No source-text search can catch these.
  - **Runtime data** — a glyph arriving from the API, or from i18n values rather than the JSX beside them. (Checked at the time of writing: the `lib/` translation data holds no arrows, but that is a fact about today, not a guarantee.)

  A clean run means "no arrow spelled the obvious ways", never "no arrows".

  **What it returns today: 5 lines, and every one of them is expected** ([#1857](https://github.com/d-hinders/Haven-AI/issues/1857) cleared the debt this table used to hold):

  | Line | Why it is there |
  |---|---|
  | `components/haven/TransactionMovement.tsx:55` | The **one allowlisted raw arrow** — the `From <a> → To <b>` movement glyph described above |
  | `components/haven/TransactionMovement.tsx:38`, `components/connect-agent/SetupStates.tsx:163`, `components/connect-agent/WaitingForConnector.tsx:100` and `:115` | **Continuation lines of multi-line `{/* … */}` JSX comments.** The check strips a comment line by its *opening* delimiter, which a continuation line does not carry, so a line-based search cannot tell them from markup. Four false positives is the price of not parsing JSX, and it is the right price |

  So the check's clean state is **5, not 0**. A run returning more than 5 has found a new defect; a run returning fewer means an expected line moved and the table above is stale.

  **The allowlist stays at one file — it does not go to zero (decided in [#1857](https://github.com/d-hinders/Haven-AI/issues/1857)).** Now that the ten defects are gone, the allowlist is the only thing standing between this rule and a zero-hit rule, so it is worth saying why it stays rather than letting it look like leftover debt. Greppability does not decide it: `expected set` and `empty set` are equally machine-checkable, and the entry is keyed by *file*, not line number, so it does not rot when `TransactionMovement` is edited. What decides it is the rendering. Converting that site would put a stroked 14px lucide glyph **inside a sentence**, at a fixed pixel size on a baseline it does not share with the text either side of it — and since [#1774](https://github.com/d-hinders/Haven-AI/issues/1774) the glyph is nested *inside* the `From` half to stop it wrapping alone, so there is no separable icon slot to put an `<Icon>` in. #1840 judged that a worse rendering; #1857 re-read the site and agrees. Emptying the allowlist would therefore be a **design-system decision that changes what `TransactionMovement` renders**, not a call-site cleanup, and it would have to widen this section explicitly rather than let the list quietly reach zero.

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

The rule bites hardest exactly where the tone rule has just been satisfied, and
that is worth stating because it reads as a paradox. Getting a **solid**
control's ring tone right puts the ring in its fill's own hue, so an un-offset
ring would paint the fill onto itself: `Button variant="danger"` un-offset now
measures **1.00:1**, against 1.08:1 back when it wrongly wore brand. Correcting
the tone made the offset load-bearing rather than merely tidy. What ships is
legible because of the offset — the ring lands on the page at 4.64:1 with a
white moat reading 6.57:1 against the fill. **So never copy a tone fix without
its offset**, and never drop an offset on the grounds that the tones now match.

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
| **design-lint** (`npm run design:lint -w packages/frontend`) | Token bypass (raw palette classes, hex colours, micro-fonts), structural bypass (hand-rolled header bands, raw `<table>`/`<svg>`, address slices) **and** off-scale `<Icon>` sizing (#1858 — the only rule scanned per element rather than per line) | Blocking CI; shrink-only baseline |
| **Visual regression** (`/design-system` snapshot suite) | Unreviewed pixel drift in any shared primitive | Blocking CI; Linux baselines |
| **Design-system coupling** (`npm run design:coupling -w packages/frontend`) | A new `ui/`/`haven/` primitive missing from `/design-system` | **Blocking** on every PR (*Design-system coupling (strict)*, #1023); a sticky comment explains the finding |
| **copy-lint** (`npm run lint:copy`) | Banned multi-word technical terms in user-facing copy | Blocking CI; shrink-only baseline |
| **haven-design-reviewer** | Rendered-UX issues (visual weight, spacing rhythm, states, touch targets) reviewed from the screenshot evidence | Review pass; any finding pauses auto-merge |


One design rule is also enforced by the **type system**: `Icon`'s `size` prop is typed
`IconSize` (12 | 14 | 16 | 20 | 24 | 28), so `tsc` rejects an off-scale numeric size before
design-lint ever runs — and a wrapper that threads a size through to `<Icon>` closes the
gate's one-level-indirection blind spot by adopting that type (#1858).

Marketing/landing surfaces are exempt from the lint gates (intentionally bespoke); the product app and `/design-system` stay fully gated.

**Escape markers (reviewed exceptions).** One placement rule for the line-scanning gates: put the marker on the offending line **or the line directly above** — `design-lint-disable-line` (design-lint) and `// copy-lint-ignore` (copy-lint) both work either way (shared helper: `scripts/lib/lint-escapes.mjs`). The coupling gate's `// design-system-exempt: <reason>` is different by design — it exempts an *export*, sits as a trailing comment on the export line, and requires the colon + reason. Use escapes sparingly; each one is a standing reviewed exception.
